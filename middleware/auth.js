const crypto = require('crypto');
const db = require('../db');
const { getClientIp, writeAccessLog } = require('../lib/accessLog');

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const ABSOLUTE_TIMEOUT_MS = 8 * 60 * 60 * 1000;
// lastSeenAt을 매 요청마다 갱신하면 세션 데이터가 매번 "변경됨"으로 표시되어 express-session이
// 매 요청마다 세션 저장소(Postgres)에 UPDATE를 날린다. 30분 idle 타임아웃 판정에는 1분 단위
// 정확도면 충분하므로, 이 간격 이상 지났을 때만 갱신한다(그래야 실제 저장이 그만큼 뜸해진다).
const LAST_SEEN_UPDATE_INTERVAL_MS = 60 * 1000;

function isAiIntakeRequest(req) {
  return String(req.path || '').indexOf('/ai-intake') === 0;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(String(token || '')).digest('hex');
}

async function getSessionProblem(req) {
  if (!req.session?.user) {
    return { reason: 'session_missing', message: '로그인이 필요합니다. 다시 로그인해주세요.' };
  }

  const now = Date.now();
  if (!req.session.authIssuedAt) req.session.authIssuedAt = now;
  if (!req.session.lastSeenAt) req.session.lastSeenAt = now;

  const issuedAt = Number(req.session.authIssuedAt || 0);
  const idleAnchor = isAiIntakeRequest(req)
    ? Number(req.session.aiLastInputAt || req.session.lastSeenAt || 0)
    : Number(req.session.lastSeenAt || 0);

  if (issuedAt > 0 && now - issuedAt > ABSOLUTE_TIMEOUT_MS) {
    return { reason: 'absolute', message: '장시간 사용하지 않아 세션이 만료되었습니다. 다시 로그인해주세요.' };
  }
  if (idleAnchor > 0 && now - idleAnchor > IDLE_TIMEOUT_MS) {
    return { reason: 'idle', message: '세션이 만료되었습니다. 다시 로그인해주세요.' };
  }

  const tokenHash = hashSessionToken(req.session.authToken);
  const activeUser = await db.get(
    `SELECT id FROM users
     WHERE id = ? AND status = 'active' AND active_session_hash = ?
       AND active_session_expires_at > now()`,
    [req.session.user.id, tokenHash]
  );
  if (!activeUser) {
    return { reason: 'replaced', message: '다른 곳에서 로그인되어 종료되었습니다.' };
  }

  return null;
}

async function clearUserActiveSession(req) {
  if (!req.session?.user || !req.session?.authToken) return;
  await db.run(
    'UPDATE users SET active_session_hash = NULL, active_session_expires_at = NULL WHERE id = ? AND active_session_hash = ?',
    [req.session.user.id, hashSessionToken(req.session.authToken)]
  );
}

async function destroyWithReason(req, res, reason, eventType, workDetail) {
  try {
    if (req.session?.user) {
      await writeAccessLog({
        userId: req.session.user.id,
        account: req.session.user.login_id,
        eventType,
        workDetail,
        subjectInfo: `사용자 ID ${req.session.user.id}`,
        ipAddress: getClientIp(req),
        userAgent: req.get('user-agent') || null,
        success: true,
      });
    }
    await clearUserActiveSession(req);
  } catch (error) {
    console.error('세션 만료 처리 실패:', error);
  }
  return req.session.destroy(() => res.redirect(`/login?expired=1&reason=${reason}`));
}

async function requireAuth(req, res, next) {
  try {
    const problem = await getSessionProblem(req);
    if (problem) {
      if (problem.reason === 'session_missing') return res.redirect('/login');
      if (problem.reason === 'replaced') {
        return req.session.destroy(() => res.redirect('/login?expired=1&reason=replaced'));
      }
      return destroyWithReason(req, res, problem.reason, problem.reason === 'absolute' ? 'SESSION_EXPIRED_ABSOLUTE' : 'SESSION_EXPIRED_IDLE', problem.message);
    }

    const now = Date.now();
    if (now - Number(req.session.lastSeenAt || 0) > LAST_SEEN_UPDATE_INTERVAL_MS) {
      req.session.lastSeenAt = now;
    }
    next();
  } catch (error) {
    next(error);
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session.user || !roles.includes(req.session.user.role)) {
      return res.status(403).render('403', { title: '접근 권한 없음' });
    }
    next();
  };
}

// client 역할은 자기 그룹으로 스코프 제한, branch_manager는 자기 지사로 제한
function scopeFilter(req) {
  const u = req.session.user;
  if (u.role === 'admin') return {};
  if (u.role === 'branch_manager') return { branch_id: u.branch_id };
  if (u.role === 'client') return { branch_id: u.branch_id, group_id: u.group_id };
  return {};
}

module.exports = { hashSessionToken, requireAuth, requireRole, scopeFilter, getSessionProblem, isAiIntakeRequest };
