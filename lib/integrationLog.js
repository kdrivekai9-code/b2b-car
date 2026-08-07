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

// source: callmaner | mcp | kakao | geocode
// operation: sync / send / order_receipt / tool_call 등 그 안에서의 동작 이름
async function logIntegrationError({ source, operation, refType, refId, errorCode, message, context }) {
  const text = String(message || '').slice(0, MAX_MESSAGE_LENGTH);
  console.error(`[연동오류][${source}/${operation}]${refId ? ` ${refType}=${refId}` : ''} ${text}`);
  try {
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
