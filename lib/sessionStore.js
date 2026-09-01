// 세션 저장소 — connect-pg-simple을 감싸 실패를 눈에 보이게 만든다.
//
// 왜 감싸나(2026-09-01 실측): 세션 저장소가 1시간 30분 동안 모든 요청을 500으로 만들었는데
// integration_errors에는 한 줄도 안 남았다. 실패가 console.error로만 나가서
// lib/systemAlert.js가 볼 수 있는 곳에 아무것도 없었고, 결국 사용자가 세 번 말해줘서 알았다.
//
// 세션 저장소 실패는 성격이 특별하다. 오더 하나가 실패하는 것과 달리 **로그인부터 모든 화면이
// 동시에 막힌다.** 가장 조용하면 안 되는 실패가 가장 조용했다.
//
// express-session의 저장소는 에러를 이벤트가 아니라 콜백으로 돌려준다. 그래서 이벤트를 듣는
// 방법이 없고, 메서드를 감싸는 것이 유일한 자리다.
const { logIntegrationErrorAsync } = require('./integrationLog');

// 감쌀 메서드. touch는 disableTouch로 꺼져 있지만, 나중에 켜질 때 조용히 빠지지 않도록 넣어둔다.
const WRAPPED = ['get', 'set', 'destroy', 'touch'];

// 같은 실패를 요청마다 기록하지 않는다.
//
// 이 사고가 정확히 그 모양이었다 — 모든 요청이 같은 에러로 실패했다. 그대로 남기면 초당 수십
// 건의 INSERT가 되고, 그 INSERT도 같은 풀을 쓰므로 막힌 DB를 더 밀어붙인다. 기록이 장애를
// 키우면 안 된다. 대신 아래 systemAlert의 '고착 오류'가 건수가 아니라 **지속 시간**으로
// 판정하므로, 분당 한 줄이면 충분히 잡힌다.
const LOG_INTERVAL_MS = 60000;
const lastLoggedAt = new Map();

function shouldLog(op) {
  const now = Date.now();
  const prev = lastLoggedAt.get(op) || 0;
  if (now - prev < LOG_INTERVAL_MS) return false;
  lastLoggedAt.set(op, now);
  return true;
}

// 검사에서 상태를 초기화할 수 있게 열어둔다.
function resetThrottle() {
  lastLoggedAt.clear();
}

// log를 주입받는 이유는 검사 때문이다 — require 시점에 함수를 꺼내 쥐고 있으면 검사에서
// 바꿔 끼울 수 없다(lib/plateOcr.js의 options.generate와 같은 방식).
function noteFailure(op, err, log = logIntegrationErrorAsync) {
  if (!shouldLog(op)) return;
  log({
    source: 'session_store',
    operation: op,
    errorCode: err && err.code ? String(err.code) : null,
    message: String((err && err.message) || '세션 저장소 실패'),
    // 세션 값에는 사용자 정보가 들어 있다 — 무엇이 실패했는지만 남기고 내용은 싣지 않는다.
    context: { throttleSeconds: LOG_INTERVAL_MS / 1000 },
  });
}

// store의 메서드를 제자리에서 감싼다. 마지막 인자가 콜백이라는 것은 express-session의 저장소
// 규약이고, connect-pg-simple도 그대로 따른다.
function instrumentSessionStore(store) {
  if (!store || store.__instrumented) return store;

  WRAPPED.forEach((op) => {
    const original = store[op];
    if (typeof original !== 'function') return;
    store[op] = function instrumented(...args) {
      const last = args[args.length - 1];
      if (typeof last !== 'function') return original.apply(this, args);
      args[args.length - 1] = function wrappedCallback(err, ...rest) {
        // 실패를 삼키지 않는다 — 기록만 하고 원래 콜백에 그대로 넘긴다.
        if (err) noteFailure(op, err);
        return last.call(this, err, ...rest);
      };
      return original.apply(this, args);
    };
  });

  store.__instrumented = true;
  return store;
}

module.exports = { instrumentSessionStore, noteFailure, resetThrottle, LOG_INTERVAL_MS, WRAPPED };
