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
async function embedText(text, taskType) {
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
async function generateJson(systemInstruction, userText, responseSchema) {
  const projectId = process.env.GOOGLE_CLOUD_PROJECT_ID;
  const location = process.env.GOOGLE_CLOUD_LOCATION || 'asia-northeast3';
  const accessToken = await getAccessToken();
  const url = `https://${location}-aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${CHAT_MODEL}:generateContent`;

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents: [{ role: 'user', parts: [{ text: userText }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema,
      },
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

// 함수 호출(function calling) 방식 — MCP 도구를 Gemini에게 노출하고, 모델이 어떤 도구를
// 어떤 인자로 부를지 스스로 고르게 한다. generateJson과 달리 한 번에 끝나지 않고 여러 턴이
// 필요해서(모델 → 도구 호출 → 결과 주입 → 모델), contents 전체를 호출자가 관리한다.
// 반환값은 이번 턴의 모델 응답 파트를 그대로 담아, 호출자가 대화 히스토리에 붙일 수 있게 한다.
async function generateWithTools({ systemInstruction, contents, tools, timeoutMs }) {
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
      generationConfig: { temperature: 0.2 },
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

module.exports = { embedText, generateJson, generateWithTools, EMBEDDING_DIMENSIONS };
