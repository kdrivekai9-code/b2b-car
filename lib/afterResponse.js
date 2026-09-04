// 응답을 보낸 뒤에 마저 돌릴 작업.
//
// Vercel 서버리스는 응답을 보내고 나면 인스턴스를 얼려버린다. 그냥 fire-and-forget으로 두면
// 그 작업이 조용히 유실된다 — 실행됐는지 안 됐는지도 알 수 없다. waitUntil로 "이 작업이 끝날
// 때까지 살려두라"고 알려줘야 한다.
//
// 왜 모듈로 뽑았나: 같은 코드가 routes/kakaoConsult.js와 routes/orders.js에 각각 있었다.
// 응답 뒤 작업이 필요한 곳이 늘어날수록(오더 생성은 접수 경로가 넷이다) 복붙이 늘고,
// 한 곳만 고쳐지면 그 경로에서만 조용히 유실된다.
let vercelWaitUntil = null;
try { ({ waitUntil: vercelWaitUntil } = require('@vercel/functions')); } catch (e) { /* 로컬 실행 등 */ }

// 실패는 삼키고 로그만 남긴다 — 응답은 이미 나갔으므로 여기서 던져봐야 받을 사람이 없고,
// 처리되지 않은 거부는 프로세스를 죽인다(server.js의 unhandledRejection 주석 참고).
function runAfterResponse(promise, label) {
  const guarded = Promise.resolve(promise)
    .catch((e) => console.error(`${label || '응답 후 작업'} 실패:`, e && e.message ? e.message : e));
  if (vercelWaitUntil) {
    try { vercelWaitUntil(guarded); } catch (e) { /* 로컬에서는 무시 — 프로세스가 계속 살아 있다 */ }
  }
  return guarded;
}

module.exports = { runAfterResponse };
