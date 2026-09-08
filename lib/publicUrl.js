// 로그인 없이 여는 공개 주소의 기준.
//
// 크론과 통보에는 요청(req)이 없어 호스트를 알아낼 수 없다. 그래서 환경변수(PUBLIC_BASE_URL)로
// 두고, 없을 때 쓸 기본값을 여기 한 곳에만 적는다.
//
// 왜 모았나(실측 2026-09-08): 같은 기본값이 세 곳에 흩어져 있었고 그중 하나가 틀려 있었다 —
// lib/driverLocation.js는 'https://b2b-car.vercel.app'을 쓰고 있었는데 그 도메인은 우리 것이
// 아니다(/login이 404이고, 우리 앱과 무관한 페이지가 응답한다). 운영 주소는
// 'https://b2bcarkr.vercel.app'이다(같은 시각 확인: /login 200, 우리 CSS·JS 그대로).
// 그 값으로 만들어지는 것이 고객에게 보내는 **기사 위치 추적 링크**라, 환경변수가 비어 있는
// 곳에서는 고객이 남의 페이지를 받게 된다. 아직 나간 이력은 0건이었다(chat_messages 전수).
//
// 기본값을 지우고 던지게 하지 않는 이유: 통보는 링크 한 줄이 없어도 나가야 하는 값이고,
// 환경변수 하나 때문에 배차 통보가 통째로 멈추는 쪽이 더 나쁘다. 대신 기본값을 한 곳에 두어
// 다시 갈라지지 않게 한다.
const DEFAULT_PUBLIC_BASE_URL = 'https://b2bcarkr.vercel.app';

function publicBaseUrl() {
  const raw = String(process.env.PUBLIC_BASE_URL || '').trim();
  return (raw || DEFAULT_PUBLIC_BASE_URL).replace(/\/+$/, '');
}

module.exports = { publicBaseUrl, DEFAULT_PUBLIC_BASE_URL };
