// 외부 연동 오류를 한 곳(integration_errors)에 남긴다.
//
// 원칙 두 가지:
//  1. 이 함수는 절대 던지지 않는다 — 로그를 남기려다 본 작업이 실패하면 주객이 전도된다.
//     테이블이 아직 없는 환경(마이그레이션 전)에서도 조용히 넘어간다.
//  2. console.error는 그대로 유지한다 — Vercel 함수 로그에서 실시간으로 보는 경로도 살려둔다.
//     DB는 "나중에 찾아보기" 용도이고, 콘솔은 "지금 보고 있을 때" 용도라 역할이 다르다.
const db = require('../db');

const MAX_MESSAGE_LENGTH = 1000;
const MAX_CONTEXT_LENGTH = 4000;

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try {
    return JSON.stringify(value).slice(0, MAX_CONTEXT_LENGTH);
  } catch (e) {
    return null;
  }
}

// 같은 오류가 이어지면 새 줄을 만들지 않고 마지막 줄의 횟수를 올린다.
//
// 왜(사용자 지시 2026-09-21): 바깥이 고장 나면 매분 같은 오류가 그대로 쌓였다 — 콜마너
// 장애 때 19분에 57건. 그 상태로 몇 시간이 가면 연동 오류 화면이 같은 줄로 가득 차고,
// 그 사이에 난 **진짜 다른 오류가 그 밑에 묻힌다**(9월 초 AUTO_SEND_NOTICE도 10분에 10건).
//
// 창을 두는 이유: 무한히 접으면 "어제 한 번, 오늘 또"가 한 줄이 되어 언제 다시 시작됐는지
// 알 수 없다. 창 안에서만 접으면 한 사건이 한 줄이 되고, 시간이 지나 다시 나면 새 줄이 선다.
const FOLD_WINDOW_MINUTES = 60;

// 같은 묶음의 가장 최근 줄을 창 안에서 찾아 횟수를 올린다. 올렸으면 true.
//
// 기준은 "무엇이 잘못됐는가"가 같은 것 — source+operation+ref_type+ref_id+message다.
// error_code는 빼둔다: 같은 실패의 코드가 비었다 채워졌다 하면 한 사건이 두 줄로 갈라진다.
//
// created_at은 **처음** 난 시각으로 그대로 두고 last_seen_at만 올린다. 둘이 있어야
// "언제부터 언제까지 몇 번"을 읽을 수 있다.
async function foldIntoRecent({ source, operation, refType, refId, text }) {
  const row = await db.get(
    `UPDATE integration_errors SET repeat_count = repeat_count + 1,
            last_seen_at = to_char((now() at time zone 'Asia/Seoul'), 'YYYY-MM-DD HH24:MI:SS')
      WHERE id = (
        SELECT id FROM integration_errors
         WHERE source = ? AND operation = ? AND message = ?
           AND ref_type IS NOT DISTINCT FROM ? AND ref_id IS NOT DISTINCT FROM ?
           AND created_at >= to_char((now() at time zone 'Asia/Seoul') - interval '${FOLD_WINDOW_MINUTES} minutes',
                                     'YYYY-MM-DD HH24:MI:SS')
         ORDER BY id DESC LIMIT 1
      )
      RETURNING id, repeat_count`,
    [String(source || 'unknown'), String(operation || 'unknown'), text,
      refType || null, Number.isInteger(refId) ? refId : null]
  );
  return row || null;
}

// source: callmaner | mcp | kakao | geocode
// operation: sync / send / order_receipt / tool_call 등 그 안에서의 동작 이름
async function logIntegrationError({ source, operation, refType, refId, errorCode, message, context }) {
  const text = String(message || '').slice(0, MAX_MESSAGE_LENGTH);
  console.error(`[연동오류][${source}/${operation}]${refId ? ` ${refType}=${refId}` : ''} ${text}`);
  try {
    // 마이그레이션(20260921020000) 전이면 42703이 난다 — 그때는 접지 않고 예전처럼 한 줄씩
    // 넣는다. 로그 모양이 조금 시끄러울 뿐, 기록이 빠지는 것보다 낫다.
    const folded = await foldIntoRecent({ source, operation, refType, refId, text })
      .catch((e) => {
        if (e && e.code === '42703') return null;
        console.error('연동오류 접기 실패(새 줄로 남긴다):', e.message);
        return null;
      });
    if (folded) return;

    await db.run(
      `INSERT INTO integration_errors (source, operation, ref_type, ref_id, error_code, message, context_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        String(source || 'unknown'),
        String(operation || 'unknown'),
        refType || null,
        Number.isInteger(refId) ? refId : null,
        errorCode ? String(errorCode).slice(0, 100) : null,
        text,
        safeJson(context),
      ]
    );
  } catch (e) {
    // 마이그레이션 전이거나 DB가 잠깐 안 될 때 — 콘솔에는 이미 남았으므로 여기서 끝낸다.
    console.error('연동오류 로그 저장 실패(무시):', e.message);
  }
}

// 호출부에서 await하지 않아도 되도록(응답 지연을 만들지 않도록) 쓰는 fire-and-forget 버전.
function logIntegrationErrorAsync(payload) {
  logIntegrationError(payload).catch(() => {});
}

module.exports = { logIntegrationError, logIntegrationErrorAsync };
