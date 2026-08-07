// 카카오 상담톡(ConsulTalk 중계서버) 발신 API 클라이언트.
//
// 2026-08-07 개편: zammad_* 엔드포인트를 버리고 직접 발신 API(/send/plain, /send/rich,
// /send/close, /send/upload)로 갈아탔다. zammad_* 는 Zammad가 쓰던 자리를 그대로 이어받는
// 호환 창구라 중계서버가 내부에서 헤더/구조를 변환해줬을 뿐, 우리가 Zammad를 대체한 지금은
// 한 겹 더 거칠 이유가 없다. 직접 API는 인증 키를 **헤더**로 받고 본문은 카카오 원본과 같은
// chapters/sections 구조를 쓴다.
//
// 스펙 출처: https://consultalk-alpha.callmaner.com/openapi.json (라이브 스펙이 문서보다 최신)
//   /send/plain  X-Platform-Type·X-Service-Key·X-User-Key 필수, X-Event-Key 선택, body=MessageRequest
//   /send/rich   위와 동일, body=RichMessageRequest (섹션에 type만 있어도 유효 — personal이 그 경우)
//   /send/close  네 헤더 전부 필수, body 없음
//   /send/upload multipart/form-data (Phase 3 사진 전달용)
//
// ⚠ API 버전: 사용자 요청은 v1 → v3 교체였는데, 2026-08-07 실측으로 alpha 서버에서 /api/v3/*는
// 404이고 /api/v1/*만 살아 있다(빈 바디로 찌르면 422 = 라우트 존재). 스펙(openapi.json)에도 v1만
// 있고, 확인용으로 받은 Postman 캡처도 v1으로 200 OK를 받았다. 그래서 기본값은 **동작이 확인된
// v1**로 두고, 경로 버전을 환경변수 하나로 바꿀 수 있게만 만들어 뒀다 — v3가 열리면
// CONSULTALK_API_VERSION=v3 만 설정하면 코드 수정 없이 전환된다.
const DEFAULT_BASE_URL = 'https://consultalk-alpha.callmaner.com';
const DEFAULT_API_VERSION = 'v1';
const DEFAULT_PLATFORM_TYPE = 'kakao_counsel_talk';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 1000;

function baseUrl() {
  return (process.env.CONSULTALK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
}

function apiVersion() {
  const v = String(process.env.CONSULTALK_API_VERSION || DEFAULT_API_VERSION).trim();
  return /^v\d+$/.test(v) ? v : DEFAULT_API_VERSION;
}

function endpoint(path) {
  return `${baseUrl()}/api/${apiVersion()}${path}`;
}

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`ConsulTalk API 응답이 ${timeoutMs / 1000}초 내에 오지 않았습니다: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// 직접 발신 API는 인증 키를 헤더로 받는다(zammad_* 는 바디였다).
function authHeaders(session) {
  const headers = {
    'Content-Type': 'application/json',
    'X-Platform-Type': process.env.CONSULTALK_PLATFORM_TYPE || DEFAULT_PLATFORM_TYPE,
    'X-Service-Key': session.kakao_service_key,
    'X-User-Key': session.kakao_user_key,
  };
  // X-Event-Key는 /send/close에서만 필수지만, 있으면 항상 실어 보낸다(중계서버가 세션을 특정한다).
  if (session.kakao_event_key) headers['X-Event-Key'] = String(session.kakao_event_key);
  return headers;
}

// 발신에 필요한 인증 키가 세션에 저장돼 있는지 — 수신 웹훅(routes/kakaoConsult.js)이 첫 메시지
// 처리 시 채워둔다. event_key는 선택이라 필수 조건에서 뺐다(close 호출만 따로 확인한다).
function isConfigured(session) {
  return !!(session && session.kakao_service_key && session.kakao_user_key);
}

// HTTP 200이어도 본문이 실패를 말할 수 있다. 그런데 응답 형식이 두 갈래다.
//   중계서버   : {"code":200,"message":"SUCCESS"}                       — code가 숫자
//   카카오 원본: {"code":"SUCCESS"|"PARTIAL_SUCCESS"|"FAILED"|"ERROR",
//                "payload":{"message_info":[…],"success_count":1,"fail_count":0}}  — code가 문자열
// 중계서버가 원본 응답을 그대로 넘겨줄 수도 있어 둘 다 판정한다. 숫자 비교만 하면
// Number("SUCCESS")가 NaN이라 성공을 실패로 뒤집는다.
function judgeSendResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return { ok: true };

  const payload = parsed.payload || {};
  if (Number(payload.fail_count) > 0) {
    return { ok: false, reason: `fail_count=${payload.fail_count}` };
  }

  const code = parsed.code;
  if (code === undefined || code === null || code === '') return { ok: true };
  if (typeof code === 'number' || /^\d+$/.test(String(code))) {
    return Number(code) === 200 ? { ok: true } : { ok: false, reason: `code=${code}` };
  }
  return String(code).toUpperCase() === 'SUCCESS'
    ? { ok: true }
    : { ok: false, reason: `code=${code}` };
}

async function postJson(path, session, body, options) {
  if (!isConfigured(session)) return { ok: false, error: 'kakao_session_not_configured' };
  if (options && options.requireEventKey && !session.kakao_event_key) {
    return { ok: false, error: 'kakao_event_key_missing' };
  }
  const url = endpoint(path);
  try {
    const res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: authHeaders(session),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) {
      return { ok: false, error: `${path} 실패 (${res.status}): ${raw.slice(0, 300)}` };
    }
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    const verdict = judgeSendResponse(parsed);
    if (!verdict.ok) {
      return { ok: false, error: `${path} 거부 (${verdict.reason}): ${raw.slice(0, 200)}` };
    }
    return { ok: true, response: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 카카오 원본과 같은 chapters[].sections[] 구조. 평문 발신은 섹션 하나(type:text)면 충분하다.
function textBody(text) {
  return {
    version: 1,
    chapters: [{ sections: [{ type: 'text', data: String(text || '').slice(0, MAX_TEXT_LENGTH) }] }],
  };
}

function sendMessage(session, text) {
  return postJson('/send/plain', session, textBody(text));
}

// 개인정보 제공 동의 요청 — 리치 메시지에 type:"personal" 섹션 하나만 담아 보내면 고객 화면에
// 동의 버튼이 뜨고, 고객이 동의하면 이름/휴대폰이 /receive/personal_info 웹훅으로 들어온다.
// (Postman 실측 확인: POST /api/v1/send/rich + {"version":1,"chapters":[{"sections":[{"type":"personal"}]}]}
//  → 200 {"code":200,"message":"SUCCESS"})
// 익명 카카오 고객을 b2b-car 거래처와 잇는 유일한 정식 경로라, 세션 최초 응답 때 한 번 보낸다.
function sendPersonalInfoRequest(session) {
  return postJson('/send/rich', session, {
    version: 1,
    chapters: [{ sections: [{ type: 'personal' }] }],
  });
}

// 상담 종료 통지 — /send/close는 바디를 받지 않는다(헤더 4종 필수). 종료 안내 문구를 같이
// 보내려면 평문을 먼저 보낸 뒤 close를 호출해야 한다.
async function sendClose(session, text) {
  if (text) {
    const sent = await sendMessage(session, text);
    if (!sent.ok) return sent;
  }
  return postJson('/send/close', session, undefined, { requireEventKey: true });
}

// 파일 발신(Phase 3 사진 전달용) — multipart/form-data. 업로드 응답의 URL을 리치 메시지의
// 이미지 섹션에 실어 보내는 것이 카카오 규격이라(명세서: 이미지는 파일 업로드 선행 필수),
// 이 함수는 업로드까지만 담당한다.
async function uploadFile(session, file, filename) {
  if (!isConfigured(session)) return { ok: false, error: 'kakao_session_not_configured' };
  try {
    const form = new FormData();
    form.append('file', file instanceof Blob ? file : new Blob([file]), filename || 'upload');
    const headers = authHeaders(session);
    delete headers['Content-Type']; // multipart 경계는 fetch가 직접 채운다
    const res = await fetchWithTimeout(endpoint('/send/upload'), { method: 'POST', headers, body: form });
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: `/send/upload 실패 (${res.status}): ${raw.slice(0, 300)}` };
    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    return { ok: true, response: parsed };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// chapters[].sections[]의 type:"text" 섹션들을 이어붙여 평문으로 만든다(계획서 5.2).
// message-simple(구버전 단순 형태)이나 원본 DKT content/contents 필드도 방어적으로 처리한다.
// 카카오 원본은 chapters[].sections[]에 type별로 담겨 온다(text / file 등). 장문은 data가 잘리고
// section.attachment.url에 전체 본문 txt가 따로 온다 — 1차 범위는 텍스트라 URL은 쓰지 않지만,
// 잘린 내용으로 의도분류하고 있다는 사실은 알고 있어야 한다(계획서 4.5).
function extractPlainText(body) {
  if (!body) return '';
  if (Array.isArray(body.chapters)) {
    const parts = [];
    body.chapters.forEach((chapter) => {
      (chapter.sections || []).forEach((section) => {
        if (section && section.type === 'text' && section.data) parts.push(String(section.data));
      });
    });
    if (parts.length) return parts.join('\n').trim();
  }
  if (typeof body.text === 'string' && body.text.trim()) return body.text.trim();
  if (typeof body.content === 'string' && body.content.trim()) return body.content.trim();
  if (Array.isArray(body.contents)) {
    const joined = body.contents.filter((c) => typeof c === 'string').join('\n').trim();
    if (joined) return joined;
  }
  return '';
}

// 인증 키 3종은 헤더(카카오 원본 방식)와 바디 양쪽을 다 살펴본다.
//  - /receive/message : 키는 헤더에만 있고 바디는 chapters/meta 구조뿐이다(meta.sessionId).
//  - /receive/reference: 바디에도 user_key / session_id / sender_key가 들어온다.
// 헤더를 먼저 보고, 없으면 바디에서 찾는다.
function extractKeys(req) {
  const body = req.body || {};
  const meta = body.meta || {};
  const sessionId = body.session_id != null ? body.session_id
    : (meta.sessionId != null ? meta.sessionId : null);
  return {
    serviceKey: req.get('X-Service-Key') || body.service_key || body.sender_key || null,
    userKey: req.get('X-User-Key') || body.user_key || null,
    eventKey: req.get('X-Event-Key') || (sessionId != null ? String(sessionId) : null) || body.event_key || null,
  };
}

// 개인정보 제공동의 응답에서 이름/휴대폰을 뽑는다.
// 규격("상담톡 API 명세서 배포용_재판매사용" IF11004, 개인정보제공동의 정보 수신 API):
//   { "user_key":"…", "session_id":"…", "sender_key":"…", "time":1738710631227,
//     "personal_info": { "phone_number":"821012345678", "nickname":"홍길동" } }
// 제공 항목은 프로필 정보(닉네임)와 카카오계정(전화번호) 둘뿐이고, 전화번호는 국가번호가 붙은
// 형태로 온다(82…). 규격 외 표기도 함께 훑는 이유는 중계서버가 한 겹 감싸 전달할 수 있어서다.
function extractPersonalInfo(body) {
  if (!body || typeof body !== 'object') return { name: null, phone: null };
  const candidates = [body.personal_info, body, body.personal, body.data, body.customer, body.user].filter(
    (o) => o && typeof o === 'object'
  );
  // 리치 섹션으로 되돌아오는 형태(chapters[].sections[].type==='personal')도 후보에 넣는다.
  if (Array.isArray(body.chapters)) {
    body.chapters.forEach((chapter) => {
      (chapter.sections || []).forEach((section) => {
        if (section && typeof section === 'object') candidates.push(section);
      });
    });
  }

  const nameKeys = ['nickname', 'name', 'user_name', 'customer_name', 'userName', 'customerName'];
  const phoneKeys = ['phone_number', 'phoneNumber', 'phone', 'mobile', 'hp', 'tel', 'user_phone', 'customer_phone'];
  const pick = (keys) => {
    for (const obj of candidates) {
      for (const k of keys) {
        const v = obj[k];
        if (typeof v === 'string' && v.trim()) return v.trim();
      }
    }
    return null;
  };

  const rawPhone = pick(phoneKeys);
  return { name: pick(nameKeys), phone: rawPhone ? normalizePhone(rawPhone) : null };
}

// 카카오는 국가번호가 붙은 형태로 준다("821012345678") — 우리 DB·콜마너는 전부 국내 표기
// (010-1234-5678)를 쓰므로 앞의 82를 0으로 되돌린 뒤 포맷한다. 이 변환을 빠뜨리면 전화번호로
// 거래처 담당자를 찾는 매칭(기획서 5.7 2단계)이 한 건도 맞지 않는다.
function normalizePhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (digits.startsWith('82')) digits = '0' + digits.slice(2);
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return String(raw || '').trim();
}

// 텍스트가 아닌 메시지(이미지/파일 등)인지 — 텍스트가 없다고 조용히 무시하면 고객 입장에서는
// 사진을 보냈는데 아무 반응이 없는 상태가 된다.
function hasNonTextSection(body) {
  if (!body || !Array.isArray(body.chapters)) return false;
  return body.chapters.some((chapter) => (chapter.sections || [])
    .some((section) => section && section.type && section.type !== 'text'));
}

module.exports = {
  sendMessage,
  sendClose,
  sendPersonalInfoRequest,
  uploadFile,
  extractPlainText,
  extractKeys,
  extractPersonalInfo,
  hasNonTextSection,
  isConfigured,
};
