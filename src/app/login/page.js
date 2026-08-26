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
        {/* 여기 있던 "데모 계정" 안내(관리자·지사장·고객사의 아이디와 비밀번호)를 걷어냈다.
            로그인하지 않은 누구나 보는 화면인데 조건 없이 렌더돼 프로덕션에도 노출돼 있었다.
            EJS 로그인 화면(views/login.ejs)도 같이 걷어냈다 — 한쪽만 지우면 다른 화면으로
            그대로 보인다. */}
      </div>
    </div>
  );
}
