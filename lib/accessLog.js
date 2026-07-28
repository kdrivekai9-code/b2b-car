const db = require('../db');

const WORK_LABELS = {
  orders: '오더 관리',
  users: '사용자 관리',
  branches: '지사 관리',
  groups: '그룹 관리',
  drivers: '기사 관리',
  settings: '설정 관리',
  notices: '공지사항',
  chat: '상담 관리',
  faq: 'FAQ 문의',
  'knowledge-base': '지식 관리',
  'location-aliases': '거점 별칭 관리',
  push: '알림 설정',
  kakao: '주소 검색',
};

function getClientIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').replace(/^::ffff:/, '') || 'unknown';
}

async function writeAccessLog({ userId = null, account, eventType, workDetail, subjectInfo = null, ipAddress, userAgent = null, success = true }) {
  await db.run(
    `INSERT INTO access_logs
      (user_id, account, event_type, work_detail, subject_info, ip_address, user_agent, success)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, account || '(unknown)', eventType, workDetail, subjectInfo, ipAddress || 'unknown', userAgent, success]
  );
}

// 브라우저 주소창 이동/링크 클릭 같은 실제 "화면 조회"는 Sec-Fetch-Mode: navigate로 온다.
// 페이지가 내부적으로 쏘는 fetch/폴링/SSE 연결(needs-agent-summary, agent-presence/stream 등)은
// navigate가 아니므로 걸러진다 — 이런 것까지 매번 access_logs에 남기면 실제 감사에는 도움이 안 되면서
// 테이블만 빠르게 커진다(며칠 만에 수천 건). 헤더가 없는 구형 클라이언트는 안전하게 그대로 기록한다.
function isPageNavigation(req) {
  const mode = req.get('sec-fetch-mode');
  return !mode || mode === 'navigate';
}

function accessLogMiddleware(req, res, next) {
  if (!req.session?.user) return next();
  // 실제 데이터 변경(등록/수정/삭제)은 항상 남기고, 단순 조회(GET)는 페이지 탐색일 때만 남긴다.
  if (req.method === 'GET' && !isPageNavigation(req)) return next();

  const startedUser = { ...req.session.user };
  const pathParts = req.path.split('/').filter(Boolean);
  const resource = pathParts[0] || 'dashboard';
  const targetId = pathParts.find((part, index) => index > 0 && /^\d+$/.test(part));
  const methodLabel = { GET: '조회', POST: '등록/변경', PUT: '변경', PATCH: '변경', DELETE: '삭제' }[req.method] || req.method;
  const workDetail = `${WORK_LABELS[resource] || '대시보드'} ${methodLabel}`;
  const subjectInfo = targetId ? `${resource} ID ${targetId}` : null;
  const ipAddress = getClientIp(req);
  const userAgent = req.get('user-agent') || null;

  res.on('finish', () => {
    writeAccessLog({
      userId: startedUser.id,
      account: startedUser.login_id,
      eventType: 'ACCESS',
      workDetail,
      subjectInfo,
      ipAddress,
      userAgent,
      success: res.statusCode < 400,
    }).catch((error) => console.error('접속기록 저장 실패:', error));
  });
  next();
}

module.exports = { accessLogMiddleware, getClientIp, writeAccessLog };