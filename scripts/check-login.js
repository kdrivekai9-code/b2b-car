#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = (args.baseUrl || process.env.LOGIN_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const loginId = args.loginId || process.env.LOGIN_ID || 'admin';
  const password = args.password || process.env.LOGIN_PASSWORD;

  if (!password) {
    console.error('LOGIN_PASSWORD(또는 --password)가 필요합니다.');
    console.error('예: LOGIN_PASSWORD=\'Admin!2345\' npm run check:login');
    process.exit(2);
  }

  const body = new URLSearchParams({
    login_id: loginId,
    password,
  });

  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    redirect: 'manual',
  });

  const location = response.headers.get('location') || '';
  const ok = response.status === 302 && location === '/';

  console.log(JSON.stringify({
    baseUrl,
    loginId,
    status: response.status,
    location,
    pass: ok,
  }, null, 2));

  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  const cause = error && error.cause ? {
    message: error.cause.message,
    code: error.cause.code,
    name: error.cause.name,
  } : null;
  console.error('로그인 스모크 체크 실패:', JSON.stringify({
    message: error.message,
    name: error.name,
    cause,
  }, null, 2));
  process.exit(1);
});
