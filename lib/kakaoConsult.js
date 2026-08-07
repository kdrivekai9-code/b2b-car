// 카카오 상담톡(ConsulTalk 중계서버) 발신 API 클라이언트 — "카카오 상담톡 연동 계획서" 6절 참고.
//
// 발신은 zammad_* 엔드포인트를 쓴다(콜마너 안내, 2026-08-07). 지금까지 Zammad가 쓰던 자리를
// 우리가 그대로 이어받는 구조라 같은 창구를 쓰는 것이다. 카카오 원본 규격을 그대로 노출하는
// /send/message(헤더 인증 + chapters 구조)와 달리, zammad_* 는 인증 키를 바디로 받고 본문도
// content 평문 문자열 하나다 — 중계서버가 내부적으로 헤더/구조 변환 후 /send/message를 호출한다.
// (스펙 출처: https://consultalk-alpha.callmaner.com/openapi.json)
// 1차 범위는 텍스트만 — 파일 발신(zammad_upload_file, multipart)은 2차 작업으로 미룬다.
const DEFAULT_BASE_URL = 'https://consultalk-alpha.callmaner.com';
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TEXT_LENGTH = 1000;

function baseUrl() {
  return (process.env.CONSULTALK_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
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

// zammad_* 엔드포인트는 인증 키를 헤더가 아니라 바디로 받는다.
function authFields(session) {
  return {
    user_key: session.kakao_user_key,
    service_key: session.kakao_service_key,
    event_key: session.kakao_event_key,
  };
}

// 발신에 필요한 인증 키 3종이 세션에 저장돼 있는지 — 수신 웹훅(routes/kakaoConsult.js)이
// 첫 메시지 처리 시 항상 채워두므로, 이게 비어 있으면 카카오 출신이 아니거나 저장에 실패한 세션이다.
function isConfigured(session) {
  return !!(session && session.kakao_service_key && session.kakao_user_key && session.kakao_event_key);
}

async function postSend(path, session, extraFields) {
  if (!isConfigured(session)) return { ok: false, error: 'kakao_session_not_configured' };
  try {
    const res = await fetchWithTimeout(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...authFields(session), ...(extraFields || {}) }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `${path} 실패 (${res.status}): ${detail.slice(0, 300)}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// content는 평문 문자열이다(chapters 구조가 아님) — 중계서버가 내부에서 감싼다.
function sendMessage(session, text) {
  return postSend('/api/v1/send/zammad_send_message', session, {
    content: String(text || '').slice(0, MAX_TEXT_LENGTH),
  });
}

// 상담 종료 통지 — zammad_send_close는 인증 키만 받고 본문을 받지 않는다. 종료 안내 문구를
// 같이 보내고 싶으면 sendMessage로 먼저 보낸 뒤 이 호출을 해야 한다.
function sendClose(session, text) {
  if (text) return postSend('/api/v1/send/zammad_send_message', session, { content: String(text).slice(0, MAX_TEXT_LENGTH) })
    .then((r) => (r.ok ? postSend('/api/v1/send/zammad_send_close', session, {}) : r));
  return postSend('/api/v1/send/zammad_send_close', session, {});
}

// chapters[].sections[]의 type:"text" 섹션들을 이어붙여 평문으로 만든다(계획서 5.2).
// message-simple(구버전 단순 형태)이나 원본 DKT content/contents 필드도 방어적으로 처리한다
// (8.1 미확인 — 중계서버→b2b-car 방향 실제 바디 포맷이 문서에 없어, 실전 트래픽을 받아보기 전까지는
// 여러 형태를 다 받아주는 쪽이 안전하다).
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

// 인증 키 3종은 헤더(DKT 원본 방식)와 바디(ConsulTalk이 바디로 감싸 전달할 가능성, 8.1 참고) 양쪽을
// 다 살펴본다 — 실제 포맷은 callmaner 쪽 웹훅 연동 확인 후 여기 한 곳만 고치면 된다.
// 중계서버가 카카오 원본을 "가공 없이 그대로 전달"하는 방식으로 바꾸기로 했으므로(콜마너 확인,
// 2026-08-07), 기준은 카카오 상담톡 명세서의 Receive Service API다.
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

// 텍스트가 아닌 메시지(이미지/파일 등)인지 — 텍스트가 없다고 조용히 무시하면 고객 입장에서는
// 사진을 보냈는데 아무 반응이 없는 상태가 된다.
function hasNonTextSection(body) {
  if (!body || !Array.isArray(body.chapters)) return false;
  return body.chapters.some((chapter) => (chapter.sections || [])
    .some((section) => section && section.type && section.type !== 'text'));
}

module.exports = { sendMessage, sendClose, extractPlainText, extractKeys, hasNonTextSection, isConfigured };
