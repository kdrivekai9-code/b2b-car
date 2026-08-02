export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export const metadata = { title: '로그인 · B2B-CAR' };

const EXPIRED_MESSAGES = {
  replaced: '다른 곳에서 로그인되어 로그아웃되었습니다.',
  idle: '30분 이상 사용하지 않아 자동 로그아웃되었습니다.',
  absolute: '로그인 후 최대 사용 시간(8시간)이 지나 자동 로그아웃되었습니다.',
};

export default async function LoginPage({ searchParams }) {
  const sp = await searchParams;
  const reason = String(sp?.reason || '');
  const error = sp?.expired
    ? (EXPIRED_MESSAGES[reason] || '세션이 만료되어 로그아웃되었습니다.')
    : null;

  return (
    <div className="login-wrap">
      <div className="login-card">
        <h1>🚚 B2B-CAR</h1>
        <p>탁송 B2B 통합·운영 플랫폼</p>
        {error && <div className="error-msg">{error}</div>}
        <form method="POST" action="/login">
          <div className="field">
            <label htmlFor="loginId">아이디</label>
            <input type="text" id="loginId" name="login_id" autoComplete="username" required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="loginPassword">비밀번호</label>
            <input type="password" id="loginPassword" name="password" autoComplete="current-password" required />
          </div>
          <button className="btn" type="submit">로그인</button>
        </form>
        <p className="login-session-notice">⚠️ 계속 로그인하시면 기존 세션이 자동 로그아웃됩니다.</p>
        <div className="hint-box">
          데모 계정<br />
          관리자: admin / Admin!2345<br />
          지사장: seoul_manager / Manager!2345<br />
          고객사: seoulmotors / Client!2345
        </div>
      </div>
    </div>
  );
}
