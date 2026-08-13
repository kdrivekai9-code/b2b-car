// Vertex AI(Gemini) 임베딩 클라이언트 — 서비스 계정 JWT 자체 서명 후 OAuth2 access token으로 교환한다.
// b2bcar GCP 프로젝트 전용 서비스 계정을 사용하며(플로라 프로젝트와 분리),
// newaiflower(플로라)의 supabase/functions/_shared/vertex-ai.ts와 동일한 인증 방식을 Node.js로 옮긴 것이다.
//
// 토큰 캐시는 2단계: (1) 모듈 레벨 인메모리 — 같은 서버리스 인스턴스 안에서는 가장 빠름.
// (2) DB(vertex_token_cache 테이블) — 인메모리는 콜드스타트마다 비어서, 매번 구글 OAuth 왕복이
// 새로 발생해 응답이 느려지는 문제(상담원 연결 요청 지연의 실제 원인)가 있었다. 인스턴스 간에
// 아직 유효한 토큰을 공유해서, 콜드스타트여도 DB에 남은 토큰이 살아있으면 재사용한다.
const crypto = require('crypto');
const db = require('../db');
const aiCallLog = require('./aiCallLog');

const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const EMBEDDING_MODEL = 'gemini-embedding-001';
const EMBEDDING_DIMENSIONS = 768;
const CHAT_MODEL = 'gemini-2.5-flash';

let tokenCache = null; // { token, expiresAt }
let tokenMintInFlight = null;

// Vercel 함수의 실제 최대 실행시간이 플랜/설정에 따라 달라도, 이 앱 자체는 Google API가
// 멈춰있을 때 무한 대기하지 않도록 호출별로 타임아웃을 건다.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`Google API 응답이 ${timeoutMs / 1000}초 내에 오지 않았습니다: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function getPrivateKey() {
  return String(process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY || '').replace(/\\n/g, '\n');
}

function base64UrlEncode(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function mintAccessToken() {
  const clientEmail = process.env.GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL;
  const privateKey = getPrivateKey();
  if (!clientEmail || !privateKey) {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_CLIENT_EMAIL / GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY 환경변수가 설정되어 있지 않습니다.');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: clientEmail,
    sub: clientEmail,
    aud: GOOGLE_OAUTH_TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
    scope: CLOUD_PLATFORM_SCOPE,
  };

  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsignedToken).sign(privateKey);
  const assertion = `${unsignedToken}.${base64UrlEncode(signature)}`;

  const res = await fetchWithTimeout(GOOGLE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  }, 10000);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vertex AI access token 발급 실패: ${text}`);
  }
  const data = await res.json();
  const expiresIn = Number(data.expires_in || 3600);
  return { token: data.access_token, expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000 };
}

async function loadTokenFromDb() {
  try {
    const row = await db.get('SELECT access_token, expires_at FROM vertex_token_cache WHERE id = 1');
    if (row && new Date(row.expires_at).getTime() > Date.now()) {
      return { token: row.access_token, expiresAt: new Date(row.expires_at).getTime() };
    }
  } catch (e) {
    console.error('vertex_token_cache 조회 실패(무시하고 새로 발급):', e.message);
  }
  return null;
}

async function saveTokenToDb(cache) {
  try {
    await db.run(
      `INSERT INTO vertex_token_cache (id, access_token, expires_at) VALUES (1, ?, to_timestamp(? / 1000.0))
       ON CONFLICT (id) DO UPDATE SET access_token = EXCLUDED.access_token, expires_at = EXCLUDED.expires_at`,
      [cache.token, cache.expiresAt]
    );
  } catch (e) {
    console.error('vertex_token_cache 저장 실패(무시, 다음 호출에서 재발급됨):', e.message);
  }
}

async function getAccessToken() {
  if (tokenCache && tokenCache.expiresAt > Date.now()) return tokenCache.token;
  if (tokenMintInFlight) return (await tokenMintInFlight).token;

  tokenMintInFlight = (async () => {
    // 콜드스타트로 인메모리 캐시가 비어있어도, 다른 인스턴스가 최근에 발급해 DB에 남겨둔
    // 아직 유효한 토큰이 있으면 그걸 재사용한다 — 구글 OAuth 왕복(JWT 서명+토큰교환)을 건너뛴다.
    const fromDb = await loadTokenFromDb();
    if (fromDb) return fromDb;

    const minted = await mintAccessToken();
    saveTokenToDb(minted).catch(() => {}); // 실패해도 이번 요청 자체는 막지 않음
    return minted;
  })();

  try {
    tokenCache = await tokenMintInFlight;
    return tokenCache.token;
  } finally {
    tokenMintInFlight = null;
  }
}

// taskType: 'RETRIEVAL_DOCUMENT'(저장할 지식 항목) | 'RETRIEVAL_QUERY'(검색어)
async function embedTextRaw(text, taskType) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast3';
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${EMBEDDING_MODEL}:predict`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      instances: [{ content: text, task_type: taskType }],
      parameters: { outputDimensionality: EMBEDDING_DIMENSIONS },
    }),
  }, 20000);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI 임베딩 요청 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const values = data?.predictions?.[0]?.embeddings?.values;
  if (!Array.isArray(values)) throw new Error('Vertex AI 임베딩 응답 형식이 예상과 다릅니다.');
  return values;
}

// 구조화된 JSON 응답이 필요한 호출(의도 분류 + 필드 추출 등)에 사용 — responseSchema로 형태를 강제한다.
//
// thinking(모델의 응답 전 내부 추론)은 기본 ON이다. 한때 모든 호출에서 꺼서 응답을 1~2초
// 앞당긴 적이 있는데(2026-08-10), 실측 A/B(같은 입력 8회 반복)에서 여러 줄 자유 문장 필드
// 추출(classifyAndExtract) 정확도가 8/8 → 0/8로 무너지는 것을 확인했다 — 도착지를 경유지로
// 잘못 분류하고 원문에 없는 예약시간을 지어내는 사고로 이어졌다(실제 카카오 접수 사고).
// 응답 속도보다 접수 정확도가 우선이라 기본을 다시 ON으로 되돌리고, 스키마가 작고 판단이
// 단순한 호출(예: classifyPhaseReply — "네/아니오/1번" 수준의 enum 하나)만 호출부가 명시적으로
// { thinking: false }를 넘겨 끄도록 옵션화한다.
async function generateJsonRaw(systemInstruction, userText, responseSchema, options) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast3';
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${CHAT_MODEL}:generateContent`;

  const generationConfig = { responseMimeType: 'application/json', responseSchema };
  if (options && options.thinking === false) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig,
    }),
  }, 25000);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI generateContent 요청 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI generateContent 응답에 텍스트가 없습니다.');
  return JSON.parse(text);
}

// 이미지를 함께 넣는 JSON 추출 — generateJson과 같은 모델·같은 응답 규약이지만 parts에
// inlineData를 실을 수 있다. generateJson의 parts는 [{ text }] 하나로 고정돼 있어(호출부 4곳이
// 그 형태에 맞춰져 있다) 넓히는 대신 함수를 따로 뒀다.
//
// fileData(gs:// URI)는 쓰지 않는다 — 우리 이미지는 외부 HTTPS 링크이고 Vertex의 fileData는
// Cloud Storage URI만 받는다. 그래서 바이트를 직접 실어 보낸다(base64).
//
// images: [{ buffer, mimeType }] — 버퍼는 호출부가 이미 받아둔 것을 그대로 넘긴다
// (lib/kakaoOrderPhotos.js의 fetchImage가 만드는 것과 같은 형태).
async function generateJsonWithImagesRaw(systemInstruction, userText, images, responseSchema, options) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast3';
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${CHAT_MODEL}:generateContent`;

  const generationConfig = { responseMimeType: 'application/json', responseSchema };
  if (options && options.thinking === false) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  const parts = [{ text: userText }];
  (images || []).forEach((img) => {
    if (!img || !img.buffer) return;
    parts.push({
      inlineData: {
        mimeType: img.mimeType || 'image/jpeg',
        data: Buffer.isBuffer(img.buffer) ? img.buffer.toString('base64') : String(img.buffer),
      },
    });
  });

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts }],
      generationConfig,
    }),
    // 이미지가 붙으면 텍스트만 보낼 때보다 오래 걸린다.
  }, (options && options.timeoutMs) || 40000);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI generateContent(이미지) 요청 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Vertex AI generateContent(이미지) 응답에 텍스트가 없습니다.');
  return JSON.parse(text);
}

// 함수 호출(function calling) 방식 — MCP 도구를 Gemini에게 노출하고, 모델이 어떤 도구를
// 어떤 인자로 부를지 스스로 고르게 한다. generateJson과 달리 한 번에 끝나지 않고 여러 턴이
// 필요해서(모델 → 도구 호출 → 결과 주입 → 모델), contents 전체를 호출자가 관리한다.
// 반환값은 이번 턴의 모델 응답 파트를 그대로 담아, 호출자가 대화 히스토리에 붙일 수 있게 한다.
// thinking 기본값은 generateJson과 같은 이유로 ON이지만(위 주석), 이 함수의 일은 성격이 다르다 —
// 자유 문장에서 필드를 뽑아내는 게 아니라 (1) 어떤 도구를 부를지 고르고 (2) 도구가 돌려준 JSON을
// 문장으로 옮기는 일이다. 그래서 호출부가 { thinking: false }로 끌 수 있게 열어둔다.
// 실측(2026-08-11, 도구 응답을 고정한 A/B, 5개 질문 × 2회):
//   thinking ON  평균 8.0초, 편차 1.7~20.6초, 오답 2/10
//   thinking OFF 평균 3.2초, 편차 0.9~4.2초,  오답 0/10
// 접수 필드 추출(generateJson)에서 thinking을 끄면 정확도가 무너졌던 것과 반대 결과다 —
// 판단의 종류가 달라서다. 실데이터로 비교하면 조회 중 주문 상태가 바뀌어 비교가 오염되므로,
// 이 판단을 다시 검토할 때도 반드시 도구 응답을 고정하고 재보라.
async function generateWithToolsRaw({ systemInstruction, contents, tools, timeoutMs, thinking }) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast3';
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${CHAT_MODEL}:generateContent`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      tools: [{ functionDeclarations: tools }],
      toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
      generationConfig: {
        temperature: 0.2,
        ...(thinking === false ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
      },
    }),
  }, timeoutMs || 25000);
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Vertex AI 도구호출 요청 실패 (${res.status}): ${errText}`);
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const parts = candidate?.content?.parts || [];
  const functionCalls = parts.filter((p) => p && p.functionCall).map((p) => p.functionCall);
  const text = parts.filter((p) => p && typeof p.text === 'string').map((p) => p.text).join('').trim();
  return { parts, functionCalls, text, finishReason: candidate?.finishReason || null };
}


// ---------------- 계측 래퍼 ----------------
//
// 고객이 실제로 기다리는 시간은 DB가 아니라 이 호출들이 결정한다. 그런데 지금까지 그 시간이
// 어디에도 남지 않아, "챗봇이 느리다"는 말을 숫자로 확인할 방법이 없었다. 성공·실패 모두
// ai_call_logs에 남긴다 — 실패만 남기면(integration_errors처럼) "느리지만 성공하는" 구간이
// 통째로 안 보인다.
//
// op는 호출부가 넘기는 용도 이름이다. 없으면 함수 이름으로 떨어지는데, 그러면 "generate_json이
// 느리다"까지만 알고 접수 파싱인지 FAQ인지를 구분할 수 없다 — 주요 호출부는 op를 넘긴다.
//
// 계측은 본 호출을 기다리게 하지 않는다(lib/aiCallLog.js가 INSERT를 await하지 않는다).
function embedText(text, taskType) {
  return aiCallLog.timed(
    { op: `embed_${taskType || 'unknown'}`, model: EMBEDDING_MODEL, inputChars: String(text || '').length },
    () => embedTextRaw(text, taskType)
  );
}

function generateJson(systemInstruction, userText, responseSchema, options) {
  return aiCallLog.timed(
    {
      op: (options && options.op) || 'generate_json',
      model: CHAT_MODEL,
      inputChars: String(systemInstruction || '').length + String(userText || '').length,
    },
    () => generateJsonRaw(systemInstruction, userText, responseSchema, options)
  );
}

function generateJsonWithImages(systemInstruction, userText, images, responseSchema, options) {
  return aiCallLog.timed(
    {
      op: (options && options.op) || 'generate_json_images',
      model: CHAT_MODEL,
      inputChars: String(systemInstruction || '').length + String(userText || '').length,
      imageCount: (images || []).length,
    },
    () => generateJsonWithImagesRaw(systemInstruction, userText, images, responseSchema, options)
  );
}

function generateWithTools(args) {
  const a = args || {};
  return aiCallLog.timed(
    {
      op: a.op || 'generate_with_tools',
      model: CHAT_MODEL,
      // contents는 대화 전체라 길이가 곧 프롬프트 크기다. 턴이 쌓일수록 느려지는지 보려면 필요하다.
      inputChars: String(a.systemInstruction || '').length + safeContentsLength(a.contents),
    },
    () => generateWithToolsRaw(a)
  );
}

function safeContentsLength(contents) {
  try {
    return JSON.stringify(contents || []).length;
  } catch (e) {
    return 0;
  }
}

module.exports = { embedText, generateJson, generateJsonWithImages, generateWithTools, EMBEDDING_DIMENSIONS };
