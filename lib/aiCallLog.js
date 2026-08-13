// Vertex AI 호출의 소요 시간을 남긴다.
//
// lib/integrationLog.js와 같은 두 원칙을 지킨다:
//  1. 절대 던지지 않는다 — 계측하려다 본 호출이 실패하면 주객이 전도된다. 테이블이 아직
//     없는 환경(마이그레이션 전)에서도 조용히 넘어간다.
//  2. 본 호출을 기다리게 하지 않는다 — 기록은 await하지 않는다. AI 호출이 2초 걸리는데
//     계측 INSERT 때문에 2.1초가 되면 계측이 측정 대상을 바꾼다.
const db = require('../db');

const MAX_ERROR_LENGTH = 500;

let tableMissing = false; // 한 번 없다고 확인되면 매 호출 시도하지 않는다

function record({ provider = 'vertex', op, model, durationMs, ok, errorMessage, inputChars, outputChars, imageCount }) {
  if (tableMissing) return;
  const params = [
    provider,
    String(op || 'unknown'),
    model || null,
    Math.max(0, Math.round(Number(durationMs) || 0)),
    !!ok,
    errorMessage ? String(errorMessage).slice(0, MAX_ERROR_LENGTH) : null,
    Number.isFinite(inputChars) ? Math.round(inputChars) : null,
    Number.isFinite(outputChars) ? Math.round(outputChars) : null,
    Number.isFinite(imageCount) ? Math.round(imageCount) : 0,
  ];
  // await하지 않는다(위 원칙 2). 실패해도 조용히 넘어간다.
  db.run(
    `INSERT INTO ai_call_logs
       (provider, op, model, duration_ms, ok, error_message, input_chars, output_chars, image_count)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params
  ).catch((e) => {
    if (e && e.code === '42P01') { // undefined_table — 마이그레이션 전
      tableMissing = true;
      return;
    }
    console.error('AI 호출 계측 저장 실패:', e.message);
  });
}

// 호출을 감싸 시간을 재고 결과와 함께 기록한다. 성공·실패 모두 남긴다 —
// 실패만 남기면(integration_errors처럼) "느리지만 성공하는" 구간이 통째로 안 보인다.
async function timed(meta, fn) {
  const started = Date.now();
  try {
    const result = await fn();
    record({
      ...meta,
      durationMs: Date.now() - started,
      ok: true,
      outputChars: typeof result === 'string' ? result.length : safeLength(result),
    });
    return result;
  } catch (e) {
    record({ ...meta, durationMs: Date.now() - started, ok: false, errorMessage: e && e.message });
    throw e;
  }
}

function safeLength(value) {
  try {
    return JSON.stringify(value).length;
  } catch (e) {
    return null;
  }
}

module.exports = { record, timed };
