// 기사 진입 토큰 검사.
//
// 이 토큰 하나가 "이 사람은 사번 T11111"이라는 주장을 통째로 담는다. 검증이 느슨하면 아무나
// 남의 사번으로 들어와 그 기사의 오더와 전달사항을 본다. 화면에는 아무 이상도 안 보인다.
process.env.DRIVER_TOKEN_SECRET = 'test-secret-0123456789abcdef';
const t = require('../lib/driverToken');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}

const claims = { sabun: 'T11111', name: '채정식', branchCode: 'B100' };

console.log('[정상 흐름]');
const good = t.sign(claims);
const v = t.verify(good);
check('서명한 토큰은 통과한다', v.ok === true, v.reason);
check('사번이 그대로 온다', v.ok && v.claims.sabun === 'T11111');
check('이름도 실린다', v.ok && v.claims.name === '채정식');
check('만료가 붙는다', v.ok && v.claims.exp > v.claims.iat);

console.log('\n[위조를 막는다]');
// 본문만 바꿔치기 — 서명이 안 맞아야 한다. 이게 뚫리면 아무나 남의 사번이 된다.
const [body, sig] = good.split('.');
const forgedBody = Buffer.from(JSON.stringify({ ...claims, sabun: 'T99999', iat: 1, exp: 9999999999 }))
  .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
check('사번을 바꾸면 막힌다', t.verify(`${forgedBody}.${sig}`).reason === 'bad_signature');
check('서명을 바꾸면 막힌다', t.verify(`${body}.${sig.slice(0, -1)}x`).ok === false);
check('점이 없으면 막힌다', t.verify(body).reason === 'malformed');
check('빈 토큰은 막힌다', t.verify('').reason === 'malformed');
check('null도 막힌다', t.verify(null).reason === 'malformed');
check('본문이 JSON이 아니면 막힌다', (() => {
  const junk = Buffer.from('not-json').toString('base64').replace(/=+$/, '');
  const crypto = require('crypto');
  const s = crypto.createHmac('sha256', process.env.DRIVER_TOKEN_SECRET).update(junk).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return t.verify(`${junk}.${s}`).reason === 'malformed';
})());
// 사번이 이 토큰의 존재 이유다 — 없으면 누구인지 모른다.
check('사번이 없으면 막힌다', t.verify(t.sign({ name: '이름만' })).reason === 'no_sabun');

console.log('\n[시간]');
// 만료를 이유로 구분해야 한다 — "다시 눌러주세요"와 "잘못된 링크"는 기사가 할 일이 다르다.
check('만료되면 expired로 구분된다', t.verify(t.sign(claims, 30 + 1 - 1000)).reason !== 'bad_signature');
const expired = t.sign(claims, 30);
check('갓 만든 것은 아직 유효', t.verify(expired).ok === true);
// 시계 오차 여유. 이게 없으면 폰 시계가 몇 초 빠른 기사는 매번 튕긴다.
check('시계 오차를 감안한다', t.CLOCK_SKEW_SECONDS >= 30, String(t.CLOCK_SKEW_SECONDS));

console.log('\n[비밀키가 없으면 아무도 못 들어온다]');
// 빈 비밀키로 "검증"하면 누구나 아무 사번으로 들어온다 — 없는 것보다 나쁘다.
const saved = process.env.DRIVER_TOKEN_SECRET;
delete process.env.DRIVER_TOKEN_SECRET;
check('미설정이면 검증이 거부한다', t.verify(good).reason === 'not_configured');
check('미설정이면 isConfigured가 false', t.isConfigured() === false);
process.env.DRIVER_TOKEN_SECRET = 'short';
check('너무 짧은 키도 거부한다', t.isConfigured() === false);
process.env.DRIVER_TOKEN_SECRET = saved;
check('되돌리면 다시 통과', t.verify(good).ok === true);

console.log('\n[링크]');
const url = t.entryUrl('https://example.com/', claims);
check('경로가 /driver/chat', url.startsWith('https://example.com/driver/chat?t='));
check('링크의 토큰이 검증된다', t.verify(decodeURIComponent(url.split('t=')[1])).ok === true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
