require('dotenv').config();
const express = require('express');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { instrumentSessionStore } = require('./lib/sessionStore');
const methodOverride = require('method-override');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { pool } = require('./db');
const { STATUS_COLORS } = require('./config');
const authRoutes = require('./routes/auth');
const dashboardRoutes = require('./routes/dashboard');
const branchRoutes = require('./routes/branches');
const groupRoutes = require('./routes/groups');
const vehicleModelRoutes = require('./routes/vehicleModels');
const alertRoutes = require('./routes/alerts');
const userRoutes = require('./routes/users');
const orderRoutes = require('./routes/orders');
const favoriteRoutes = require('./routes/favorites');
const noticeRoutes = require('./routes/notices');
const locationAliasRoutes = require('./routes/locationAliases');
const settingsRoutes = require('./routes/settings');
const driverRoutes = require('./routes/drivers');
const photoUploadRoutes = require('./routes/photoUpload');
const photoViewRoutes = require('./routes/photoView');
// 기사 위치 추적(로그인 없이 토큰으로 연다) — /photos와 같은 공개 링크 계열.
const driverTrackingRoutes = require('./routes/driverTracking');
const driverChatRoutes = require('./routes/driverChat');
const receiptUploadRoutes = require('./routes/receiptUpload');
const pushRoutes = require('./routes/push');
const kakaoRoutes = require('./routes/kakao');
const knowledgeBaseRoutes = require('./routes/knowledgeBase');
const ferryFareRoutes = require('./routes/ferryFares');
const faqRoutes = require('./routes/faq');
const chatRoutes = require('./routes/chat');
const inquiryRoutes = require('./routes/inquiries');
const accessLogRoutes = require('./routes/accessLogs');
const integrationErrorRoutes = require('./routes/integrationErrors');
const kakaoAccountRoutes = require('./routes/kakaoAccounts');
const quickReplyRoutes = require('./routes/quickReplies');
const callmanerSyncRoutes = require('./routes/callmanerSync');
const kakaoConsultRoutes = require('./routes/kakaoConsult');
const { accessLogMiddleware, getClientIp, writeAccessLog } = require('./lib/accessLog');

const app = express();
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const isTest = process.env.NODE_ENV === 'test';

if (isProduction && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'b2b-car-dev-secret-change-me')) {
  throw new Error('SESSION_SECRET 환경변수를 운영용 값으로 반드시 설정하세요.');
}

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('trust proxy', 1); // 리버스 프록시(Render/Fly/Heroku 등) 뒤에서 secure 쿠키가 동작하도록

// 보안 헤더 — X-Powered-By 제거(스택 지문 노출 방지), 클릭재킹/MIME 스니핑 방지 등.
// CSP는 기존 뷰 전반에 인라인 <script>가 이미 많아 그대로 켜면 대부분 깨지므로(별도의 nonce
// 리팩터링이 필요한 더 큰 작업) 이번 패스에서는 끄고, 카카오 지도 SDK 등 외부 스크립트 로드가
// crossOriginEmbedderPolicy에 막히지 않도록 그것도 끈다 — 나머지 보호(hidePoweredBy, 프레임 차단,
// 콘텐츠 타입 스니핑 방지, Referrer-Policy, HSTS 등)는 기본값 그대로 적용된다.
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
}));

// robots.txt는 정직한 크롤러만 지켜주므로, 응답 헤더로도 색인/수집 거부 의사를 명시한다
// (로그인 없이는 실제 데이터를 볼 수 없는 내부 도구라 검색/AI 학습 대상이 될 이유가 없다).
app.use((req, res, next) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride('_method'));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  // disableTouch: express-session은 세션 데이터가 안 바뀐 요청에도 store.touch()를 매번 호출한다.
  // rolling:true라 매 응답에 Set-Cookie는 계속 나가지만(브라우저 쿠키 만료는 정상적으로 계속 연장됨),
  // DB의 session 테이블까지 매 요청마다 UPDATE할 필요는 없다 — requireAuth가 lastSeenAt을 디바운스해서
  // 데이터가 실제로 바뀔 때만(수십 초에 한 번) session.save()로 expire까지 같이 갱신해주기 때문에 안전하다.
  // createTableIfMissing은 끈다. 표는 마이그레이션이 만든다
  // (supabase/migrations/20260901010000_add_session_table.sql).
  //
  // 켜두면 실제로 서비스가 멈춘다: 이 옵션은 세션을 처음 건드릴 때 표 존재를 확인하고 그
  // 결과를 약속 하나에 캐시하는데, **실패한 약속도 지우지 않는다**
  // (node_modules/connect-pg-simple/index.js:197 — if (!this.#tableCreationPromise)).
  // 부팅 순간 DB가 잠깐 안 닿으면 그 거부된 약속이 프로세스가 사는 내내 재사용되어,
  // DB가 회복된 뒤에도 세션을 쓰는 모든 요청이 같은 에러로 영구히 실패한다. 재기동해야만 풀린다.
  // 2026-09-01에 그렇게 됐다 — 오더 목록·대시보드가 500이었고 favicon.ico까지 500이었다
  // (public에 없어서 세션 미들웨어까지 흘러간다). 그동안 /login만 200이라 멀쩡해 보였다
  // (saveUninitialized:false라 익명 GET은 세션을 만들지 않는다).
  // instrumentSessionStore: 저장소 실패를 integration_errors에 남긴다. 감싸지 않으면 실패가
  // console.error로만 나가 경보가 볼 수 없다 — 2026-09-01에 1시간 30분짜리 전면 장애가
  // 기록 한 줄 없이 지나갔다(lib/sessionStore.js).
  store: instrumentSessionStore(
    new pgSession({ pool, tableName: 'session', createTableIfMissing: false, disableTouch: true })
  ),
  secret: process.env.SESSION_SECRET || 'b2b-car-dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    maxAge: 1000 * 60 * 30,
    secure: isProduction,
    httpOnly: true, // express-session 기본값이지만, 감사 시 명확히 드러나도록 명시(자바스크립트로 세션 쿠키 접근 차단)
    sameSite: 'lax', // 대부분의 브라우저에서 크로스사이트 POST에 쿠키가 안 실려서 CSRF의 실질적 완화책이 됨
  },
}));

// req.session이 준비된 뒤에 등록해야 한다 — 이전에는 session() 미들웨어보다 먼저 등록돼 있어서
// req.session이 아직 없는 시점에 실행되는 바람에, 로그인/로그아웃(routes/auth.js의 직접 기록)을
// 제외한 일반 "접속기록"(상담 관리 조회/응답 등 ACCESS 이벤트)이 단 한 건도 기록되지 않고 있었다.
app.use(accessLogMiddleware);

// 모든 뷰에서 공통으로 사용할 값
app.use((req, res, next) => {
  res.locals.currentUser = req.session.user || null;
  res.locals.statusColor = (s) => STATUS_COLORS[s] || 'gray';
  res.locals.formatMoney = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';
  res.locals.path = req.path;
  // 뷰에서 서버 데이터를 <script> 블록 안에 JSON.stringify로 그대로 심는 곳들이 있는데(예: AI 챗봇
  // 대화 이력 복원), 그 데이터 안에 사용자가 입력한 텍스트가 리터럴로 "</script>"를 포함하면 그
  // 자리에서 태그가 끊겨 뒤에 임의의 스크립트가 주입될 수 있다(저장형 XSS). "<"를 유니코드
  // 이스케이프로 바꿔서 태그가 절대 끊기지 않게 하는 안전한 버전 — <script> 안에 데이터를 심을
  // 때는 반드시 이 함수를 통해서만 JSON.stringify해야 한다.
  res.locals.toScriptJson = (obj) => JSON.stringify(obj).replace(/</g, '\\u003c');
  next();
});

// 로그인 시도 무차별 대입 공격 방지 — IP당 15분에 10회로 제한.
// 차단이 실제로 발동하면 관리자가 "접속기록"(/access-logs) 메뉴에서 볼 수 있도록 남긴다 —
// 이 요청은 routes/auth.js까지 가지도 못하고 여기서 끊기므로, 거기 로그인 실패 로그와는 별개로
// 여기서 직접 기록해야 한다.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res /*, next, options */) => {
    writeAccessLog({
      account: (req.body && req.body.login_id) || '(unknown)',
      eventType: 'LOGIN_RATE_LIMITED',
      workDetail: '로그인 무차별 대입 차단',
      ipAddress: getClientIp(req),
      userAgent: req.get('user-agent') || null,
      success: false,
    }).catch((e) => console.error('로그인 차단 기록 실패:', e.message));
    res.status(429).render('login', { title: '로그인', error: '너무 많은 로그인 시도가 있었습니다. 잠시 후 다시 시도해주세요.' });
  },
});
// GET /login(폼 조회)은 세지 않는다 — 실제 위협은 비밀번호를 대입하는 POST뿐이고,
// GET까지 같이 세면 로그인 페이지를 몇 번 새로고침한 정상 사용자도 금방 한도에 걸린다.
if (!isTest) {
  app.post('/login', loginLimiter);
}

// 로그인 없이 접근하는 기사 사진 업로드 페이지는 '/'에 마운트된(내부적으로 모든 경로를 가로채는)
// authRoutes/dashboardRoutes보다 반드시 먼저 등록해야 requireAuth에 걸리지 않는다.
app.use('/upload', photoUploadRoutes);
// 고객용 사진 모아보기 — 로그인 없이 토큰으로 연다(카카오톡 버튼이 여는 페이지).
// 업로드와 열람은 권한이 달라 토큰도 라우터도 분리한다.
app.use('/photos', photoViewRoutes);
app.use('/track', driverTrackingRoutes);
// 기사 챗봇 — 콜마너 앱이 서명한 토큰으로 들어온다. 로그인이 없으므로 같은 이유로 먼저 등록한다
// (routes/driverChat.js). 세션은 req.session.driver에 따로 두어 관리자 세션과 섞이지 않는다.
app.use('/driver', driverChatRoutes.router);
// 우편발송 인수증 업로드 — 경로가 짧은 이유는 lib/postalReceipt.js 주석 참고(적요1 100Byte).
app.use('/r', receiptUploadRoutes);
// 콜마너 상태동기화 크론도 세션 로그인 없는 서버 대 서버 호출이라 같은 이유로 먼저 등록한다
// (자체 CRON_SECRET 검증은 routes/callmanerSync.js 안에서 한다).
app.use('/callmaner', callmanerSyncRoutes);
// 카카오 상담톡 수신 웹훅(ConsulTalk 중계서버 → b2b-car) — 같은 이유로 세션 없이 먼저 등록한다
// (자체 공유시크릿 검증은 routes/kakaoConsult.js 안에서 한다).
app.use('/kakao-consult', kakaoConsultRoutes);
// 상담원 무응답 시 AI 초안 자동 발송 크론 — 같은 이유로 세션 없이 먼저 등록한다
// (자체 CRON_SECRET 검증은 routes/chat.js의 checkCronAuth에서 한다).
app.use('/chat', chatRoutes.cronRouter);
// 감사 로그 보관 정책 크론도 같은 이유로 requireAuth보다 먼저 등록한다.
app.use('/access-logs', accessLogRoutes.cronRouter);
// 장애 알림 점검 크론도 같은 이유로 먼저 등록한다(화면 라우터는 아래에 따로 둔다).
app.use('/alerts', alertRoutes.cronRouter);

app.use('/', authRoutes);
app.use('/', dashboardRoutes);
app.use('/branches', branchRoutes);
app.use('/groups', groupRoutes);
// 법인 계정용 「내 정산내역」 — /groups는 관리자 전용이라 같은 화면을 여기로 연다.
// 개인 딜러는 본인 접수분만, 본사 직원은 법인 전체를 본다(lib/clientScope.js).
app.use('/my/settlement', groupRoutes.myRouter);
// 차종 마스터 — 수입차/대형·화물/전기차 할증의 판정 근거를 관리한다.
app.use('/vehicle-models', vehicleModelRoutes);
// 장애 알림 — 연동 오류 급증·동기화 지연을 웹푸시로 알린다(자체 CRON_SECRET 검증은 라우트 안에서).
app.use('/alerts', alertRoutes.router);
app.use('/users', userRoutes);
app.use('/orders', orderRoutes);
app.use('/favorites', favoriteRoutes);
app.use('/notices', noticeRoutes);
app.use('/location-aliases', locationAliasRoutes);
app.use('/settings', settingsRoutes);
app.use('/drivers', driverRoutes);
app.use('/push', pushRoutes);
app.use('/kakao', kakaoRoutes);
app.use('/knowledge-base', knowledgeBaseRoutes);
app.use('/ferry-fares', ferryFareRoutes);
app.use('/faq', faqRoutes);
app.use('/chat', chatRoutes);
app.use('/inquiries', inquiryRoutes);
app.use('/access-logs', accessLogRoutes);
app.use('/integration-errors', integrationErrorRoutes);
app.use('/kakao-accounts', kakaoAccountRoutes);
app.use('/quick-replies', quickReplyRoutes);

app.use((req, res) => {
  // fetch(X-Requested-With: fetch)로 온 AJAX 요청에 HTML 404 페이지를 그대로 돌려주면
  // 클라이언트가 res.json() 파싱에 실패해 실제 원인("경로 없음") 대신 뭉뚱그린 일반 에러
  // 메시지만 보게 된다 — 아래 500 핸들러와 동일한 기준으로 JSON 요청은 JSON으로 응답한다.
  const wantsJson = req.xhr || req.get('X-Requested-With') === 'fetch' || (req.get('accept') || '').indexOf('application/json') >= 0;
  if (wantsJson) return res.status(404).json({ error: '요청하신 경로를 찾을 수 없습니다.' });
  res.status(404).render('404', { title: '페이지를 찾을 수 없음' });
});

app.use((err, req, res, next) => {
  console.error(err);
  // 운영 환경에서는 원본 에러 메시지(내부 구현/DB 세부사항이 드러날 수 있음)를 그대로 보여주지
  // 않는다 — 로그에는 남기되, 사용자에게는 일반 메시지만 노출한다.
  const message = isProduction ? '서버 오류가 발생했습니다. 잠시 후 다시 시도해주세요.' : '서버 오류가 발생했습니다: ' + err.message;
  // fetch(X-Requested-With: fetch)로 온 AJAX 요청은 클라이언트가 응답을 항상 res.json()으로
  // 파싱한다 — 여기서 순수 텍스트를 그대로 보내면 "JSON이 아니다"라는 파싱 에러가 실제 에러
  // 메시지 대신 사용자에게 노출되는 문제가 있었다(AI 챗봇 오더 등록에서 실제로 겪음).
  const wantsJson = req.xhr || req.get('X-Requested-With') === 'fetch' || (req.get('accept') || '').indexOf('application/json') >= 0;
  if (wantsJson) return res.status(500).json({ error: message });
  res.status(500).send(message);
});

// 어디에도 잡히지 않은 비동기 실패로 프로세스가 죽지 않게 한다.
//
// Node 22의 기본 동작은 처리되지 않은 거부(unhandled rejection)를 만나면 프로세스를 끝내는
// 것이다. 실제로 구글 호출이 10초 타임아웃 났을 때 서버가 통째로 내려갔고, 그동안 들어온
// 요청은 전부 실패했다(오더 목록 500). 개별 원인은 그때그때 고치되, 원인 하나가 서비스
// 전체를 멈추는 구조는 두지 않는다 — 접수 한 건이 실패하는 것과 모두가 못 쓰는 것은 다르다.
//
// 삼키지는 않는다. 스택까지 남겨 다음 사람이 원인을 찾을 수 있게 한다.
process.on('unhandledRejection', (reason) => {
  console.error('처리되지 않은 거부(프로세스는 계속 실행):', reason);
});
process.on('uncaughtException', (err) => {
  console.error('잡히지 않은 예외(프로세스는 계속 실행):', err);
});

// Vercel 등 서버리스 환경에서는 핸들러(app)만 내보내고 listen은 호출하지 않는다.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`B2B-CAR 서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
  });
}

module.exports = app;
