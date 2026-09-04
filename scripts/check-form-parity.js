// EJS 폼과 Next 폼이 같은 입력 칸을 갖는지 검사한다.
//
// 왜 필요한가(2026-09-04 실측): 법인 수정 화면의 "소속 사용자 공유" 체크박스가 EJS에는 있고
// Next에는 없었다. NEXT_GROUPS_ENABLED가 켜진 환경에서는 Next 화면만 뜨므로, 그 설정을
// **켤 방법 자체가 없었다.** 기능은 다 만들어져 있었다(lib/groupActivityFeed.js,
// /orders/team-feed 화면, DB 칸까지) — 스위치만 화면에서 사라진 상태였다.
//
// 이 어긋남은 조용하다. 오류도 안 나고 빈 화면도 아니다. 그냥 칸 하나가 없을 뿐이라,
// 쓰는 사람은 "이 기능이 어디 있지"라고 묻게 된다. 그래서 이름 목록을 기계로 맞춘다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

// name="..." 을 전부 뽑는다. 서버가 받는 이름이라 이게 곧 계약이다.
function fieldNames(src) {
  return [...new Set([...src.matchAll(/name="([a-zA-Z_][a-zA-Z0-9_]*)"/g)].map((m) => m[1]))].sort();
}

// 짝지어 볼 화면들. 새 화면을 만들 때 여기 한 줄을 더하면 그때부터 갈리지 않는다.
const PAIRS = [
  ['법인', 'views/groups/form.ejs', 'src/app/groups/_components/GroupForm.js'],
];

PAIRS.forEach(([label, ejsPath, nextPath]) => {
  console.log(`[${label}]`);
  const a = fieldNames(read(ejsPath));
  const b = fieldNames(read(nextPath));
  const onlyEjs = a.filter((x) => !b.includes(x));
  const onlyNext = b.filter((x) => !a.includes(x));
  check(`EJS에만 있는 칸이 없다`, onlyEjs.length === 0, onlyEjs.join(', '));
  check(`Next에만 있는 칸이 없다`, onlyNext.length === 0, onlyNext.join(', '));
  check(`칸이 하나 이상 잡힌다`, a.length > 0, '정규식이 안 맞으면 항상 통과해버린다');
});

console.log('\n[체크박스 기본값 규칙]');
// 체크를 풀면 브라우저는 그 필드를 아예 안 보낸다. 그래서 "안 보냄"이 무엇을 뜻하는지가
// 기본값에 따라 갈린다 — 반대로 다루면 저장할 때마다 값이 뒤집힌다.
const routes = read('routes/groups.js');
const nextForm = read('src/app/groups/_components/GroupForm.js');
const ejsForm = read('views/groups/form.ejs');

// 기본 꺼짐: 안 보냄 = 꺼짐. 숨은 필드를 두면 체크했을 때 배열이 되어 === '1'이 깨진다.
check("share_activity_feed는 === '1'로 받는다", /share_activity_feed === '1'/.test(routes));
[['Next', nextForm], ['EJS', ejsForm]].forEach(([name, src]) => {
  check(`${name} — share_activity_feed에 숨은 필드가 없다`,
    !/type="hidden"[^>]*name="share_activity_feed"/.test(src)
    && !/name="share_activity_feed"[^>]*type="hidden"/.test(src),
    "숨은 필드를 두면 체크해도 꺼진다");
});

// 기본 켜짐: 안 보냄과 꺼짐을 구분해야 하므로 숨은 필드가 **있어야** 한다.
check('route_search_enabled는 기본 켜짐 처리', /checkboxDefaultOn\(req\.body\.route_search_enabled\)/.test(routes));
[['Next', nextForm], ['EJS', ejsForm]].forEach(([name, src]) => {
  ['route_search_enabled', 'fare_search_enabled'].forEach((f) => {
    check(`${name} — ${f}에 숨은 필드가 있다`,
      new RegExp(`type="hidden"[^>]*name="${f}"`).test(src),
      '없으면 체크를 풀어도 다시 켜진다');
  });
});

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
