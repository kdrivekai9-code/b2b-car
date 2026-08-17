// AI(Vertex/Gemini)를 호출하는 엔드포인트의 사용량 제한.
//
// 왜 필요한가: 로그인만 되어 있으면 이 엔드포인트들을 무한히 부를 수 있었다. 한 번 부를 때마다
// Gemini 호출이 일어나므로(접수 분류 2.5초, 도우미 한 판 3.4초), 스크립트 하나로 비용을 계속
// 태울 수 있다. 로그인 제한(IP당 15분 10회)은 로그인 자체만 막을 뿐 로그인 이후를 막지 않는다.
//
// IP가 아니라 **로그인 계정**으로 센다. 고객사는 사무실 한 회선을 여럿이 함께 쓰는 경우가 많아
// IP로 묶으면 정상 사용자끼리 서로의 한도를 깎아먹는다. 로그인 전(세션 없음)에는 IP로 떨어진다.
//
// 한도는 사람이 쓰는 속도보다 넉넉하게 잡았다. 고객이 한 문장을 보내면 이 계열 호출이 2~3번
// 일어나므로(분류 → 접수턴 → 도우미), 분당 60이면 사람 기준으로는 사실상 걸리지 않고 자동화된
// 반복 호출만 걸린다. 시간당 한도를 따로 두는 이유: 분당 한도만 있으면 분당 59회를 쉬지 않고
// 이어붙여 하루 종일 태울 수 있다.
const rateLimit = require('express-rate-limit');

const PER_MINUTE = Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || 60;
const PER_HOUR = Number(process.env.AI_RATE_LIMIT_PER_HOUR) || 600;

function keyByUser(req) {
  const userId = req.session && req.session.user && req.session.user.id;
  // ipKeyGenerator를 쓰지 않고 req.ip를 그대로 쓰면 IPv6에서 접두사가 갈려 한도가 무력해진다.
  return userId ? `u:${userId}` : `ip:${rateLimit.ipKeyGenerator(req.ip)}`;
}

// 한도를 넘겼을 때 화면이 깨지지 않게 한다 — 챗봇 클라이언트는 JSON을 기대하므로 JSON으로
// 답하고, 사용자에게는 "잠시 후"라고만 알린다(내부 한도 수치를 노출할 이유가 없다).
function tooMany(req, res) {
  res.status(429).json({
    error: '요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',
    reason: 'ai_rate_limited',
  });
}

function build(windowMs, max) {
  return rateLimit({
    windowMs,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: keyByUser,
    handler: tooMany,
  });
}

// 테스트 실행에서는 끈다 — e2e가 짧은 시간에 같은 계정으로 많은 요청을 보낸다.
const isTest = process.env.NODE_ENV === 'test' || process.env.AI_RATE_LIMIT_DISABLED === '1';

const perMinute = isTest ? (req, res, next) => next() : build(60 * 1000, PER_MINUTE);
const perHour = isTest ? (req, res, next) => next() : build(60 * 60 * 1000, PER_HOUR);

// 두 창을 함께 적용한다.
const aiRateLimit = [perMinute, perHour];

module.exports = { aiRateLimit, PER_MINUTE, PER_HOUR };
