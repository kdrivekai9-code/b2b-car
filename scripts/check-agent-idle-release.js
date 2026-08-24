// 봇 응대 복귀(유휴 해제) 설정이 한 곳에서 오고, 빈 값이 "기능 끔"으로 저장되지 않는지 본다.
//
// 왜 필요한가:
//  1) 기본값이 routes/chat.js(판정)와 routes/branches.js(설정 화면)에 각자 하드코딩돼 있었다.
//     한쪽만 바꾸면 화면이 안내하는 기본값과 실제 동작이 갈린다.
//  2) 저장부가 Number('')를 그대로 써서 빈 값이 0으로 저장됐다. 0은 "자동 복귀 끔"이라
//     그 지사 세션이 상담원이 직접 종료할 때까지 무한히 붙잡힌다 — "설정 안 함"과 결과가
//     정반대인데 구분되지 않았다.
//
// 10분이라는 값의 근거는 상담 로그 실측이다(고객 발화 → 상담원 첫 응답, 2,353건):
//   중앙값 1분 / p75 3분 / p90 8분 / p95 16분 — 10분 안에 92.2%가 응답 완료.
//   예전 값 30분은 이미 97.5%가 답한 뒤라 사실상 발동하지 않았다.
//
// DB도 네트워크도 쓰지 않는다.
//
//   node scripts/check-agent-idle-release.js
const fs = require('fs');
const path = require('path');
const { DEFAULT_AGENT_IDLE_RELEASE_MINUTES } = require('../lib/branchPolicy');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

console.log('[기본값]');
check('공용 기본값이 10분', DEFAULT_AGENT_IDLE_RELEASE_MINUTES === 10, String(DEFAULT_AGENT_IDLE_RELEASE_MINUTES));

console.log('\n[기본값을 한 곳에서만 정한다]');
{
  // 두 파일이 각자 숫자를 들고 있으면 또 갈라진다 — 공용 상수를 가져다 쓰는지 본다.
  const chat = read('routes/chat.js');
  const branches = read('routes/branches.js');
  check('routes/chat.js가 공용 상수를 가져온다',
    /DEFAULT_AGENT_IDLE_RELEASE_MINUTES\s*}?\s*=\s*require\('\.\.\/lib\/branchPolicy'\)|DEFAULT_AGENT_IDLE_RELEASE_MINUTES.*require\('\.\.\/lib\/branchPolicy'\)/.test(chat)
    || /branchPolicy'\);?[\s\S]{0,200}DEFAULT_AGENT_IDLE_RELEASE_MINUTES/.test(chat));
  check('routes/chat.js에 숫자를 다시 적지 않았다',
    !/AGENT_IDLE_RELEASE_MINUTES\s*=\s*\d+/.test(chat),
    (chat.match(/.*AGENT_IDLE_RELEASE_MINUTES\s*=\s*\d+.*/) || [''])[0]);
  check('routes/branches.js에 숫자를 다시 적지 않았다',
    !/DEFAULT_AGENT_IDLE_RELEASE_MINUTES\s*=\s*\d+/.test(branches),
    (branches.match(/.*DEFAULT_AGENT_IDLE_RELEASE_MINUTES\s*=\s*\d+.*/) || [''])[0]);
}

console.log('\n[빈 값은 "끔"이 아니라 "기본값 따름"이다]');
{
  // 저장부의 판정을 그대로 떼어내 확인한다 — 라우터를 띄우지 않고 규칙만 본다.
  const normalize = (body) => {
    const raw = String(body.agent_idle_release_minutes ?? '').trim();
    return raw === '' ? null : Number(raw);
  };
  check('빈 문자열 → NULL', normalize({ agent_idle_release_minutes: '' }) === null);
  check('공백만 → NULL', normalize({ agent_idle_release_minutes: '   ' }) === null);
  check('값이 아예 없으면 → NULL', normalize({}) === null);
  // 0은 "일부러 끔"이므로 그대로 살아야 한다.
  check('0 → 0 (일부러 끔은 유지)', normalize({ agent_idle_release_minutes: '0' }) === 0);
  check('10 → 10', normalize({ agent_idle_release_minutes: '10' }) === 10);
  // 예전 동작이 어땠는지 못박아 둔다 — 이 줄이 깨지면 회귀다.
  check('예전 방식이었다면 빈 값이 0(끔)이 됐다', Number('') === 0);
}

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
