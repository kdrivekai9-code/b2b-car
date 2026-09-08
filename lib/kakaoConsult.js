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
// 리치 발송 실패 이유를 운영에서 읽을 수 있게 남긴다(콘솔은 볼 수 없다).
const { logIntegrationErrorAsync } = require('./integrationLog');
// 진단 기록은 한 번만 남긴다(성공 로그가 쌓이지 않게).
let loggedRichAccepted = false;

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
//
// buttons를 주면 그 섹션에 붙인다 — 명세상 텍스트 섹션에도 attachment.buttons를 달 수 있다
// (예시: type:"text" + attachment.buttons[{name,type:"WL",url_pc,url_mobile}]).
// 카카오 평문은 앵커 텍스트를 지원하지 않아 "사진 보기" 같은 글자에 링크를 걸 수 없다 —
// 링크를 깔끔하게 주려면 날 URL을 본문에 적거나 이 버튼을 쓰는 두 가지뿐이다.
function textBody(text, buttons) {
  const section = { type: 'text', data: String(text || '').slice(0, MAX_TEXT_LENGTH) };
  if (Array.isArray(buttons) && buttons.length) section.attachment = { buttons };
  return { version: 1, chapters: [{ sections: [section] }] };
}

// WL(웹링크) 버튼 하나를 만든다. url_pc/url_mobile 둘 다 필수다(명세 "메시지 버튼 타입").
function webLinkButton(name, url) {
  const link = String(url || '').trim();
  if (!link || !/^https?:\/\//i.test(link)) return null;
  return { name: String(name || '열기').slice(0, 14), type: 'WL', url_pc: link, url_mobile: link };
}

// ── 항목표(item_list) ───────────────────────────────────────────────────────
// 카카오 평문에는 굵게가 없다(마크다운·HTML 미지원). 항목 이름을 도드라지게 보이려면 리치
// 메시지의 아이템 리스트 유형을 써야 한다 — 카카오가 항목/값을 표처럼 정렬해 그리고 항목에
// 강조를 넣는다(굵기는 카카오가 정한다. 우리가 지정할 수 있는 값이 아니다).
//
// 정의서 제약(상담톡 API 명세 "5. 아이템 리스트"):
//   · 아이템 리스트는 최소 2개, 최대 10개
//   · **아이템 제목 최대 6자, 아이템 설명 최대 23자**
//   · 이미지·헤더·하이라이트·리스트 중 하나 이상 필수
//
// 23자 제약이 이 기능의 한계를 정한다. 실측(2026-09-08): 출발지 "서울 강서구 양천로53길 30
// 서서울모터리움 803호 KGM인증중고차"는 38자라 표에 넣으면 "…서서울모터리"에서 잘린다.
// 통보의 핵심 정보를 잘라 보낼 수는 없으므로, **긴 값은 표에 넣지 않고 본문에 문장으로 남긴다.**
const ITEM_TITLE_MAX = 6;
const ITEM_DESC_MAX = 23;
const ITEM_MIN = 2;
const ITEM_MAX = 10;

// 평문을 말풍선 목록으로 나눈다. 표로 만들 수 없으면 null — 호출부가 평문으로 보낸다.
//
// **오더가 여럿인 답변도 표로 만든다.** 처음에는 접수번호 줄이 둘 이상이면 통째로 포기했는데
// (표는 한 덩이라 어느 값이 어느 오더 것인지 알 수 없다), 실사용에서 조회 답변은 대개 여러
// 건이었다 — 그래서 표가 한 번도 안 나왔다(2026-09-08: "오늘 예약 1건 + 접수일이 오늘인 주문
// 1건" 답변이 이 가드에 걸려 평문으로 나갔고, 카카오는 호출조차 되지 않았다).
//
// 카카오는 한 요청에 말풍선을 여러 개 담을 수 있다(명세: chapters[]는 "메시지 목록",
// sections[]는 "말풍선 내 컨텐츠"). 그래서 접수번호를 경계로 오더별 말풍선을 만들고 각
// 말풍선에 그 오더의 표를 담는다 — 값이 섞이지 않는다.
const MAX_CHAPTERS = 5;

// "상태: 운행시작, 요금: 0원"처럼 한 줄에 두 항목이 붙어 오는 경우를 쪼갠다.
// 모델이 그렇게 쓰기도 해서, 안 쪼개면 "상태" 한 줄에 요금까지 들어가 표가 어긋난다.
function splitPairs(line) {
  // **뒤에 "라벨:"이 오는 콤마에서만** 나눈다. 그냥 콤마로 자르면 금액의 천단위 콤마가
  // 걸린다 — "상태: 대기, 요금: 10,000원"이 ["상태: 대기","요금: 10","000원"]으로 쪼개져
  // 쪼개기 자체가 실패하고, 결국 "상태" 한 칸에 요금까지 들어간다(실측으로 잡았다).
  const parts = String(line).split(/,\s*(?=[^:,]{1,20}\s*:)/);
  if (parts.length < 2) return null;
  const rows = [];
  for (const part of parts) {
    const m = part.match(/^([^:]{1,20})\s*:\s*(.+)$/);
    if (!m) return null;
    rows.push({ title: m[1].trim(), description: m[2].trim() });
  }
  return rows;
}

// 한 줄에서 표 행을 뽑는다. 표에 넣을 수 없으면 null(호출부가 본문으로 남긴다).
function rowsFromLine(line) {
  const fits = (r) => r.title.length <= ITEM_TITLE_MAX
    && r.description.length <= ITEM_DESC_MAX
    && !/https?:\/\//.test(r.description);

  const pairs = splitPairs(line);
  if (pairs && pairs.every(fits)) return pairs;

  const m = line.match(/^([^:]{1,20})\s*:\s*(.+)$/);
  if (!m) return null;
  const one = { title: m[1].trim(), description: m[2].trim() };
  return fits(one) ? [one] : null;
}

function splitForItemList(text) {
  const lines = String(text || '').split('\n');
  const blocks = [];
  let current = null;

  // 표가 시작된 뒤에 나오는 문장은 **다음 오더의 머리말**이다. 그대로 두면 앞 말풍선에
  // 섞인다(실측: "접수일이 오늘인 주문도 1건 있습니다"가 앞 오더 표 아래 붙었다).
  let pendingProse = [];

  const startBlock = (firstLine) => {
    current = { body: pendingProse.slice(), rows: [] };
    pendingProse = [];
    if (firstLine) current.body.push(firstLine);
    blocks.push(current);
  };
  startBlock(null); // 접수번호 앞의 안내 문장이 들어갈 덩이

  lines.forEach((raw) => {
    const trimmed = raw.trim().replace(/^[-*·•]\s*/, '');
    if (!trimmed) { current.body.push(''); return; }

    // 접수번호 줄은 새 오더의 시작이다 — 여기서 말풍선을 가른다.
    //
    // 그 줄도 표의 첫 행으로 올린다("접수번호 OID2075(182353721)"에는 콜론이 없어서
    // 일반 규칙으로는 안 걸린다). 한도를 넘으면 예전처럼 본문에 남긴다.
    if (/^접수번호/.test(trimmed)) {
      const value = trimmed.replace(/^접수번호\s*[:\s]\s*/, '').trim();
      const fits = value && value.length <= ITEM_DESC_MAX;
      startBlock(fits ? null : trimmed);
      if (fits) current.rows.push({ title: '접수번호', description: value });
      return;
    }

    const rows = rowsFromLine(trimmed);
    if (rows) { current.rows.push(...rows); return; }

    // 표에 못 들어간 줄을 어느 말풍선에 둘지 가른다.
    //
    // "출발지: …"처럼 **라벨이 붙은 줄**은 한도(23자)를 넘어 표에서 빠진 것뿐이고, 값은 이
    // 오더 것이다 — 이 말풍선에 남긴다. 라벨이 없는 문장은 다음 오더의 머리말이다
    // ("접수일이 오늘인 주문도 1건 있습니다"). 이 구분이 없으면 주소가 다음 말풍선으로
    // 넘어가거나 안내 문장이 앞 말풍선에 섞인다(둘 다 실측으로 겪었다).
    const labeled = /^[^:]{1,20}\s*:\s*.+/.test(trimmed);
    if (!labeled && current.rows.length) pendingProse.push(trimmed);
    else current.body.push(trimmed);
  });

  // 마지막까지 남은 문장은 맨 뒤 덩이에 붙인다 — 버리면 정보가 사라진다.
  if (pendingProse.length) {
    const last = blocks[blocks.length - 1];
    last.body.push(...pendingProse);
    pendingProse = [];
  }

  // 표가 못 되는 덩이(항목이 2개 미만)는 그 줄들을 앞 덩이의 본문으로 되돌린다 —
  // 버리면 정보가 사라진다.
  const kept = [];
  blocks.forEach((b) => {
    const body = b.body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (b.rows.length >= ITEM_MIN && b.rows.length <= ITEM_MAX) {
      kept.push({ body, rows: b.rows });
      return;
    }
    // 표가 안 되면 문장으로: 뽑아둔 행도 되돌려 붙인다.
    const flat = [body, ...b.rows.map((r) => `${r.title}: ${r.description}`)].filter(Boolean).join('\n');
    if (!flat) return;
    if (kept.length) kept[kept.length - 1].body = `${kept[kept.length - 1].body}\n${flat}`.trim();
    else kept.push({ body: flat, rows: [] });
  });

  const withRows = kept.filter((b) => b.rows.length);
  if (!withRows.length) return null;
  if (kept.length > MAX_CHAPTERS) return null;
  return kept;
}

function itemListBody(blocks, buttons) {
  const list = Array.isArray(blocks) ? blocks : [{ body: '', rows: [] }];
  const chapters = list.map((b, i) => {
    // 표가 없는 덩이는 평문 말풍선으로 둔다(안내 문장만 있는 첫 덩이 등).
    if (!b.rows.length) {
      return { sections: [{ type: 'text', data: String(b.body || '').slice(0, MAX_TEXT_LENGTH) }] };
    }
    const section = {
      type: 'item_list',
      data: String(b.body || '').slice(0, MAX_TEXT_LENGTH),
      attachment: {
        item: {
          list: b.rows.slice(0, ITEM_MAX).map((r) => ({
            title: String(r.title).slice(0, ITEM_TITLE_MAX),
            description: String(r.description).slice(0, ITEM_DESC_MAX),
          })),
        },
      },
    };
    // 버튼은 마지막 말풍선에만 붙인다 — 같은 링크가 말풍선마다 반복되면 지저분하다.
    if (Array.isArray(buttons) && buttons.length && i === list.length - 1) {
      section.attachment.buttons = buttons;
    }
    return { sections: [section] };
  }).filter((c) => c.sections[0].type === 'item_list' || c.sections[0].data);

  return { version: 1, chapters };
}

// 평문 발신.
//
// "라벨: 값" 줄이 둘 이상이면 항목표(리치)로 보낸다. 표로 못 만들거나 리치 발송이 실패하면
// **평문으로 다시 보낸다** — 서식 하나 때문에 통보가 통째로 안 나가는 쪽이 훨씬 나쁘다.
// options.plain을 주면 변환하지 않는다(형태를 그대로 보내야 하는 자리).
async function sendMessage(session, text, options) {
  const buttons = options && Array.isArray(options.buttons) ? options.buttons.filter(Boolean) : null;
  const asTable = (options && options.plain) ? null : splitForItemList(text);

  if (asTable) {
    const rich = await postJson('/send/rich', session, itemListBody(asTable, buttons));
    if (rich.ok) {
      // 성공도 한 번은 남긴다(진단용). 카카오가 받아줬는데도 화면이 평문으로 보이는 경우와,
      // 애초에 거절당해 평문으로 되돌아간 경우를 구분할 방법이 이것뿐이다 — 콘솔은 볼 수 없다.
      // 한 번만 남기므로 로그가 쌓이지 않는다.
      if (!loggedRichAccepted) {
        loggedRichAccepted = true;
        logIntegrationErrorAsync({
          source: 'kakao_consult', operation: 'send_item_list_ok', refType: 'chat_session', refId: session.id,
          message: `항목표 발송이 받아들여졌다(말풍선 ${asTable.length}개). 화면이 평문으로 보이면 채널의 리치 메시지 설정을 확인해야 한다.`,
          context: { chapters: asTable.map((b) => b.rows.map((r) => r.title)) },
        });
      }
      return rich;
    }
    // 실패 이유를 **DB에 남긴다.** 콘솔만 남기면 운영에서 읽을 수 없어서, 표가 안 나오는데
    // 이유를 알 수 없었다(2026-09-08 실사용: "표로 나오지 않음"). 카카오가 리치 메시지를
    // 거절하는 이유(권한·필드·유형)는 응답 본문에 있으므로 그것을 그대로 담는다.
    logIntegrationErrorAsync({
      source: 'kakao_consult', operation: 'send_item_list', refType: 'chat_session', refId: session.id,
      message: String(rich.error || '알 수 없는 실패').slice(0, 500),
      context: { chapters: asTable.length, rows: asTable.map((b) => b.rows.length) },
    });
    console.error('카카오 항목표 발송 실패 — 평문으로 다시 보낸다:', rich.error);
  }
  return postJson('/send/plain', session, textBody(text, buttons));
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

// 이미지 발신 — 명세서 "업로드 API : /image/plain" 그대로.
//
// 두 단계다. 먼저 이미지를 카카오에 올려 URL을 받고(21일 보관), 그 URL을 image 섹션에 실어
// 보낸다. 우리 Supabase 공개 URL을 그대로 섹션에 넣을 수는 없다 — 명세가 "이미지 업로드 API로
// 업로드한 이미지를 사용해야 합니다"라고 못박고 있다.
//
// 경로가 /api/v1로 고정인 점에 주의. 발신 API는 v3를 쓰지만(CONSULTALK_API_VERSION) 업로드는
// 명세에 v1로 적혀 있어서 endpoint()를 쓰지 않는다. 헤더도 다르다 — X-Service-Key만 필요하고
// X-User-Key는 요구하지 않는다(이미지는 특정 대화가 아니라 발신 프로필에 올리는 것이라서).
// 명세서(IF12501, "Upload Service API(ROOT URL : /api/v1/upload)" → "업로드 API : /image")대로
// /api/v1/upload/image 다. 예전에는 /plain을 붙여두어 실제 발송 때 404가 났다 — 텍스트 발송
// 경로(/send/plain)의 접미사를 업로드에도 그대로 옮겨 적은 실수였다. 텍스트만 나가고 사진은
// 한 장도 못 나가는 상태였는데, 통보 자체는 성공으로 처리돼 조용히 묻혔다.
const IMAGE_UPLOAD_PATH = '/api/v1/upload/image';

// 명세서 제한: 5MB 이하, jpg/jpeg/png/gif.
// 가로:세로 비율도 2:1 이상 3:4 이하만 허용되고 가로 500px 이상을 권장한다 — 콜마너 탁송사진은
// 400x300(4:3)이라 비율은 통과하지만 권장 폭에는 못 미친다.
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_IMAGE_EXT = /\.(jpe?g|png|gif)$/i;

async function uploadImage(session, buffer, filename, contentType) {
  if (!session || !session.kakao_service_key) return { ok: false, error: 'kakao_service_key_missing' };
  const size = buffer && (buffer.byteLength != null ? buffer.byteLength : buffer.length);
  if (!size) return { ok: false, error: 'empty_image' };
  if (size > MAX_IMAGE_BYTES) return { ok: false, error: `image_too_large(${size})` };

  try {
    const form = new FormData();
    form.append('image', new Blob([buffer], { type: contentType || 'image/jpeg' }), filename || 'photo.jpg');
    const res = await fetchWithTimeout(baseUrl() + IMAGE_UPLOAD_PATH, {
      method: 'POST',
      headers: {
        'X-Platform-Type': process.env.CONSULTALK_PLATFORM_TYPE || DEFAULT_PLATFORM_TYPE,
        'X-Service-Key': session.kakao_service_key,
      },
      body: form,
    }, 20000);
    const raw = await res.text().catch(() => '');
    if (!res.ok) return { ok: false, error: `이미지 업로드 실패 (${res.status}): ${raw.slice(0, 200)}` };

    let parsed = null;
    try { parsed = raw ? JSON.parse(raw) : null; } catch (e) { parsed = null; }
    // 성공 응답의 payload가 곧 이미지 URL이다.
    const url = parsed && typeof parsed.payload === 'string' ? parsed.payload.trim() : '';
    if (!url) return { ok: false, error: `업로드 응답에 이미지 URL이 없습니다: ${raw.slice(0, 200)}` };
    return { ok: true, url };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 텍스트 한 줄 + 이미지 여러 장을 한 메시지로 보낸다. 사진만 덜렁 보내면 무엇의 사진인지
// 알 수 없어서, 오더를 알려주는 문장을 같은 말풍선에 함께 싣는다.
function imageBody(imageUrls, text) {
  const sections = [];
  if (text) sections.push({ type: 'text', data: String(text).slice(0, MAX_TEXT_LENGTH) });
  (imageUrls || []).forEach((url) => sections.push({ type: 'image', data: String(url) }));
  return { version: 1, chapters: [{ sections }] };
}

function sendImages(session, imageUrls, text) {
  if (!imageUrls || !imageUrls.length) return Promise.resolve({ ok: false, error: 'no_images' });
  return postJson('/send/plain', session, imageBody(imageUrls, text));
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
  // 실제 수신 로그를 보니 표기가 한 가지가 아니다 — /receive/reference는 camelCase(userKey)로,
  // /receive/message는 snake_case거나 아예 바디에 키가 없고 헤더로만 온다(카카오 원본 형식).
  // 한쪽만 보다가 6건이 missing_keys로 버려지고 있었다. 셋을 모두 훑는다.
  const pick = (...names) => {
    for (const name of names) {
      for (const source of [body, meta]) {
        const v = source && source[name];
        if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
      }
    }
    return null;
  };

  const sessionId = pick('session_id', 'sessionId');
  return {
    serviceKey: req.get('X-Service-Key') || pick('service_key', 'serviceKey', 'sender_key', 'senderKey'),
    userKey: req.get('X-User-Key') || pick('user_key', 'userKey'),
    eventKey: req.get('X-Event-Key') || sessionId || pick('event_key', 'eventKey'),
  };
}

// 수신 요청의 카카오 관련 헤더만 추려낸다 — 키가 안 잡혀 버려진 요청이 "헤더가 아예 없었는지,
// 우리가 못 읽은 것인지" 구분하려면 이게 로그에 남아 있어야 한다. 웹훅 시크릿은 제외한다.
function extractDiagnosticHeaders(req) {
  const names = ['x-service-key', 'x-user-key', 'x-event-key', 'x-platform-type', 'content-type'];
  const out = {};
  names.forEach((n) => {
    const v = req.get(n);
    if (v) out[n] = n === 'x-service-key' ? String(v).slice(0, 8) + '…' : v;
  });
  return out;
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
  // 항목표 변환 — 검사가 직접 본다(scripts/check-kakao-item-list.js).
  splitForItemList, itemListBody,
  webLinkButton,
  sendMessage,
  sendClose,
  sendPersonalInfoRequest,
  uploadImage,
  sendImages,
  imageBody,
  ALLOWED_IMAGE_EXT,
  MAX_IMAGE_BYTES,
  uploadFile,
  extractPlainText,
  extractKeys,
  extractDiagnosticHeaders,
  extractPersonalInfo,
  hasNonTextSection,
  isConfigured,
};
