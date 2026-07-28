const express = require('express');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../db');
const asyncHandler = require('../middleware/asyncHandler');
const { hashSessionToken } = require('../middleware/auth');
const { getClientIp, writeAccessLog } = require('../lib/accessLog');

const router = express.Router();

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  const reason = String(req.query.reason || '');
  const expiredMessage = {
    replaced: '다른 곳에서 로그인되어 로그아웃되었습니다.',
    idle: '30분 이상 사용하지 않아 자동 로그아웃되었습니다.',
    absolute: '로그인 후 최대 사용 시간(8시간)이 지나 자동 로그아웃되었습니다.',
  };
  const error = req.query.expired ? (expiredMessage[reason] || '세션이 만료되어 로그아웃되었습니다.') : null;
  res.render('login', { title: '로그인', error });
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
  };
  await writeAccessLog({ ...logBase, userId: user.id, eventType: 'LOGIN_SUCCESS', workDetail: '로그인', subjectInfo: `사용자 ID ${user.id}` });
  res.redirect('/');
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
