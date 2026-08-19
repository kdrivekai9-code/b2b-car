// AI(Vertex/Gemini)를 호출하는 엔드포인트의 사용량 제한.
//
// 왜 필요한가: 로그인만 되어 있으면 이 엔드포인트들을 무한히 부를 수 있었다. 한 번 부를 때마다
// Gemini 호출이 일어나므로(접수 분류 2.5초, 도우미 한 판 3.4초), 스크립트 하나로 비용을 계속
// 태울 수 있다. 로그인 제한(IP당 15분 10회)은 로그인 자체만 막을 뿐 로그인 이후를 막지 않는다.
//
// IP가 아니라 **로그인 계정**으로 센다. 고객사는 사무실 한 회선을 여럿이 함께 쓰는 경우가 많아
// IP로 묶으면 정상 사용자끼리 서로의 한도를 깎아먹는다. 로그인 전(세션 없음)에는 IP로 떨어진다.
//
// 카운터는 DB에 둔다(lib/aiUsageCounter.js). 예전에는 express-rate-limit의 기본 저장소(프로세스
// 메모리)를 썼는데, 서버리스는 인스턴스가 여럿이라 카운터가 인스턴스마다 따로 살았다 — 실제
// 허용량이 설정값의 몇 배가 되고 콜드스타트마다 0으로 돌아갔다. 조회할 수도 없어서 "지금 얼마나
// 쓰고 있는지"를 화면에 보여줄 방법도 없었다.
//
// 한도는 접속기록 화면(/access-logs)에서 관리자가 바꾼다(app_settings). 값을 안 정했으면
// 환경변수 → 코드 기본값 순으로 내려간다. 사람이 쓰는 속도보다 넉넉하게 잡혀 있다 — 고객이
// 한 문장을 보내면 이 계열 호출이 2~3번 일어나므로(분류 → 접수턴 → 도우미), 분당 60이면
// 사람 기준으로는 사실상 걸리지 않고 자동화된 반복 호출만 걸린다. 시간당 한도를 따로 두는
// 이유: 분당 한도만 있으면 분당 59회를 쉬지 않고 이어붙여 하루 종일 태울 수 있다.
const appSettings = require('../lib/appSettings');
const aiUsageCounter = require('../lib/aiUsageCounter');
const { writeAccessLog, getClientIp } = require('../lib/accessLog');

const KEY_PER_MINUTE = 'ai_rate_limit_per_minute';
const KEY_PER_HOUR = 'ai_rate_limit_per_hour';

// 0으로 저장하면 "제한 없음"이다 — 사고가 났을 때 관리자가 배포 없이 즉시 풀 수 있어야 한다.
const NO_LIMIT = 0;
const MAX_ALLOWED = 100000;

const DEFAULT_PER_MINUTE = Number(process.env.AI_RATE_LIMIT_PER_MINUTE) || 60;
const DEFAULT_PER_HOUR = Number(process.env.AI_RATE_LIMIT_PER_HOUR) || 600;

// 차단이 실제로 일어났는지 관리자가 확인할 수 있어야 한다 — 로그인 차단(LOGIN_RATE_LIMITED)과
// 같은 자리(접속기록)에 남긴다. 조회 화면이 이미 있으니 별도 화면을 만들 이유가 없다.
const BLOCK_EVENT_TYPE = 'AI_RATE_LIMITED';

async function currentLimits() {
  const [perMinute, perHour] = await Promise.all([
    appSettings.getNumber(KEY_PER_MINUTE, DEFAULT_PER_MINUTE, { min: NO_LIMIT, max: MAX_ALLOWED }),
    appSettings.getNumber(KEY_PER_HOUR, DEFAULT_PER_HOUR, { min: NO_LIMIT, max: MAX_ALLOWED }),
  ]);
  return { perMinute, perHour };
}

function exceeded(used, limit) {
  return limit !== NO_LIMIT && used > limit;
}

async function aiRateLimitMiddleware(req, res, next) {
  const limits = await currentLimits().catch(() => ({ perMinute: DEFAULT_PER_MINUTE, perHour: DEFAULT_PER_HOUR }));
  // 둘 다 풀려 있으면 셀 이유도 없다.
  if (limits.perMinute === NO_LIMIT && limits.perHour === NO_LIMIT) return next();

  const subject = aiUsageCounter.subjectOf(req);
  const used = await aiUsageCounter.hit(subject);
  // 셀 수 없으면(테이블 없음 등) 통과시킨다 — 집계 하나 때문에 챗봇이 멈추면 안 된다.
  if (!used) return next();

  const overMinute = exceeded(used.minute, limits.perMinute);
  const overHour = exceeded(used.hour, limits.perHour);
  if (!overMinute && !overHour) {
    // 남은 양을 헤더로도 알려준다(표준 헤더와 같은 취지 — 클라이언트가 스스로 조절할 수 있다).
    if (limits.perMinute !== NO_LIMIT) {
      res.setHeader('RateLimit-Limit', limits.perMinute);
      res.setHeader('RateLimit-Remaining', Math.max(0, limits.perMinute - used.minute));
    }
    return next();
  }

  const window = overMinute ? '분당' : '시간당';
  const limit = overMinute ? limits.perMinute : limits.perHour;
  const usedCount = overMinute ? used.minute : used.hour;
  writeAccessLog({
    userId: (req.session && req.session.user && req.session.user.id) || null,
    account: (req.session && req.session.user && req.session.user.login_id) || subject,
    eventType: BLOCK_EVENT_TYPE,
    workDetail: `AI 사용량 한도 초과 차단(${window} ${limit}회, 현재 ${usedCount}회)`,
    subjectInfo: req.originalUrl,
    ipAddress: getClientIp(req),
    userAgent: req.get('user-agent') || null,
    success: false,
  }).catch((e) => console.error('AI 차단 기록 실패:', e.message));

  // 챗봇 클라이언트는 JSON을 기대하므로 JSON으로 답한다. 내부 한도 수치는 노출하지 않는다.
  return res.status(429).json({
    error: '요청이 많아 잠시 처리할 수 없습니다. 잠시 후 다시 시도해주세요.',
    reason: 'ai_rate_limited',
  });
}

// 테스트 실행에서는 끈다 — e2e가 짧은 시간에 같은 계정으로 많은 요청을 보낸다.
const isTest = process.env.NODE_ENV === 'test' || process.env.AI_RATE_LIMIT_DISABLED === '1';
const passThrough = (req, res, next) => next();

const aiRateLimit = isTest ? passThrough : aiRateLimitMiddleware;

module.exports = {
  aiRateLimit,
  currentLimits,
  KEY_PER_MINUTE,
  KEY_PER_HOUR,
  DEFAULT_PER_MINUTE,
  DEFAULT_PER_HOUR,
  MAX_ALLOWED,
  NO_LIMIT,
  BLOCK_EVENT_TYPE,
};
