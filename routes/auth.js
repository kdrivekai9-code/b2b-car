const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { hashSessionToken } = require('../middleware/auth');
const { getClientIp, writeAccessLog } = require('../lib/accessLog');

const router = express.Router();

// 로그인 후 돌아갈 곳. 로그인 없이 열린 주소를 기억했다가 그리로 돌려보낸다 — 그러지 않으면
// 관리자가 링크를 받아 열었다가 로그인하면 대시보드로 떨어져 무엇을 보려 했는지 잃어버린다.
//
// **우리 사이트 안의 경로만** 받는다. 외부 주소를 그대로 쓰면 로그인 직후 남의 사이트로
// 보내는 통로가 된다(오픈 리다이렉트). '//'로 시작하는 것도 막는다 — 브라우저가 그걸
// 프로토콜 생략 절대주소로 읽어 //evil.com이 외부로 나간다.
function safeNext(raw) {
  const v = String(raw || '').trim();
  if (!v.startsWith('/') || v.startsWith('//')) return null;
  return v;
}

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect(safeNext(req.query.next) || '/');
  const reason = String(req.query.reason || '');
  const expiredMessage = {
    replaced: '다른 곳에서 로그인되어 로그아웃되었습니다.',
    idle: '30분 이상 사용하지 않아 자동 로그아웃되었습니다.',
    absolute: '로그인 후 최대 사용 시간(8시간)이 지나 자동 로그아웃되었습니다.',
  };
  const error = req.query.expired ? (expiredMessage[reason] || '세션이 만료되어 로그아웃되었습니다.') : null;
  res.render('login', { title: '로그인', error, nextPath: safeNext(req.query.next) });
});

router.post('/login', asyncHandler(async (req, res) => {
  const { login_id, password } = req.body;
  const user = await db.get('SELECT * FROM users WHERE login_id = ? AND status = ?', [login_id, 'active']);
  const logBase = {
    account: login_id || '(empty)',
    ipAddress: getClientIp(req),
    userAgent: req.get('user-agent') || null,
  };

  const passwordMatches = user ? await bcrypt.compare(password || '', user.password_hash) : false;
  if (!user || !passwordMatches) {
    await writeAccessLog({ ...logBase, userId: user?.id || null, eventType: 'LOGIN_FAILURE', workDetail: '로그인 실패', success: false });
    return res.status(401).render('login', { title: '로그인', error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  }

  // 동일 계정으로 이미 로그인 중이어도 막지 않고, 새 로그인을 그대로 진행시키면서 기존 세션의
  // 토큰을 덮어써 무효화한다 — 기존 세션 쪽은 다음 요청(requireAuth)에서 토큰 불일치를 감지해
  // 자동으로 로그아웃되고 "다른 곳에서 로그인되어 로그아웃되었습니다" 안내를 보게 된다.
  const wasAlreadyActive = await db.get(
    `SELECT id FROM users WHERE id = ? AND active_session_hash IS NOT NULL AND active_session_expires_at > now()`,
    [user.id]
  );
  const authToken = crypto.randomBytes(32).toString('base64url');
  const authTokenHash = hashSessionToken(authToken);
  await db.run(
    `UPDATE users SET active_session_hash = ?, active_session_expires_at = now() + interval '8 hours' WHERE id = ?`,
    [authTokenHash, user.id]
  );
  if (wasAlreadyActive) {
    await writeAccessLog({ ...logBase, userId: user.id, eventType: 'LOGIN_BLOCKED', workDetail: '동일 계정 중복 로그인 - 기존 세션 자동 로그아웃', success: true });
  }

  try {
    await new Promise((resolve, reject) => req.session.regenerate((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    await db.run(
      'UPDATE users SET active_session_hash = NULL, active_session_expires_at = NULL WHERE id = ? AND active_session_hash = ?',
      [user.id, authTokenHash]
    );
    throw error;
  }
  req.session.authToken = authToken;
  req.session.authIssuedAt = Date.now();
  req.session.lastSeenAt = Date.now();
  req.session.user = {
    id: user.id,
    login_id: user.login_id,
    name: user.name,
    phone: user.phone,
    role: user.role,
    branch_id: user.branch_id,
    group_id: user.group_id,
    grade: user.grade,
    // 법인 계정 구분 — 개인 딜러는 본인 오더만 본다(lib/clientScope.js).
    // 세션에 실어야 요청마다 users를 다시 읽지 않는다. 구분을 바꾸면 재로그인이 필요하다.
    client_type: user.client_type || null,
    separate_settlement: !!user.separate_settlement,
  };
  await writeAccessLog({ ...logBase, userId: user.id, eventType: 'LOGIN_SUCCESS', workDetail: '로그인', subjectInfo: `사용자 ID ${user.id}` });
  res.redirect(safeNext(req.body.next) || '/');
}));

router.post('/logout', asyncHandler(async (req, res) => {
  const user = req.session.user;
  const tokenHash = hashSessionToken(req.session.authToken);
  if (user) {
    await db.run(
      'UPDATE users SET active_session_hash = NULL, active_session_expires_at = NULL WHERE id = ? AND active_session_hash = ?',
      [user.id, tokenHash]
    );
    await writeAccessLog({
      userId: user.id,
      account: user.login_id,
      eventType: 'LOGOUT',
      workDetail: '로그아웃',
      subjectInfo: `사용자 ID ${user.id}`,
      ipAddress: getClientIp(req),
      userAgent: req.get('user-agent') || null,
    });
  }
  req.session.destroy(() => res.redirect('/login'));
}));

module.exports = router;
