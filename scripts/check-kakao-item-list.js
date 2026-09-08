// 카카오 상담톡 항목표(item_list) — 항목 이름을 도드라지게 보이려는 것과, 그 대가.
//
// 왜 이렇게 만들었나(사용자 요청 2026-09-08): 예약시간·상태·요금의 항목과 값을 굵게 보이게
// 해달라. 카카오 평문에는 굵게가 없다(마크다운·HTML 미지원). 한글은 유니코드 굵은 글자도
// 없어서 문자 트릭도 못 쓴다. 남은 길은 리치 메시지의 아이템 리스트 유형 하나뿐이고,
// 그건 카카오가 항목/값을 표처럼 정렬해 항목에 강조를 넣어 준다(굵기는 카카오가 정한다).
//
// 정의서 제약이 이 기능의 한계를 정한다(명세 "5. 아이템 리스트"):
//   · 리스트 최소 2개, 최대 10개 · **제목 최대 6자, 설명 최대 23자**
//
// 그래서 "전부 표로"는 불가능하다. 실측: 출발지 "서울 강서구 양천로53길 30 서서울모터리움
// 803호 KGM인증중고차"는 38자라 표에 넣으면 "…서서울모터리"에서 잘린다. 통보의 핵심 정보를
// 잘라 보낼 수는 없으므로 **긴 값은 표에 넣지 않고 본문에 문장으로 남긴다.**
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const k = require('../lib/kakaoConsult');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const src = fs.readFileSync(path.join(__dirname, '../lib/kakaoConsult.js'), 'utf8');

console.log('[항목과 값을 표로 올린다]');
const answer = [
  'OID2075(182353721) 주문입니다.',
  '예약시간: 2026-09-08 16:20',
  '상태: 운행시작',
  '요금: 40,000원',
].join('\n');
const t = k.splitForItemList(answer);
check('요청한 세 항목이 표로', t.rows.map((r) => r.title), ['예약시간', '상태', '요금']);
check('값도 함께', t.rows.map((r) => r.description), ['2026-09-08 16:20', '운행시작', '40,000원']);
// 라벨이 없는 문장은 표가 아니라 본문이다.
check('문장은 본문에 남는다', t.body, 'OID2075(182353721) 주문입니다.');

console.log('\n[잘릴 값은 표에 넣지 않는다]');
// 23자 제약. 주소를 표에 넣으면 번지가 잘려 못 읽는다 — 자르는 대신 본문으로 보낸다.
const longAddr = '출발지: 서울 강서구 양천로53길 30 서서울모터리움 803호 KGM인증중고차';
const t2 = k.splitForItemList(`안내입니다.\n${longAddr}\n상태: 운행시작\n요금: 0원`);
check('긴 값은 표에서 빠진다', t2.rows.map((r) => r.title), ['상태', '요금']);
check('빠진 값은 본문에 온전히 남는다', t2.body.includes('KGM인증중고차'), true);
// 제목 6자 제약. 넘으면 표 제목이 될 수 없다.
const t3 = k.splitForItemList('최종 운행 거리: 123km\n상태: 완료\n요금: 0원');
check('제목이 6자를 넘으면 본문으로', t3.rows.map((r) => r.title), ['상태', '요금']);
check('그 줄은 본문에 남는다', t3.body.includes('최종 운행 거리: 123km'), true);
// 링크는 표에 넣지 않는다 — 23자를 넘고 표에서는 누를 수도 없다(링크는 버튼으로 나간다).
const t4 = k.splitForItemList('상태: 완료\n요금: 0원\n사진 보기: https://example.test/photos/abc');
check('링크는 표에 안 들어간다', t4.rows.length, 2);
check('링크 줄은 본문에', t4.body.includes('https://example.test/photos/abc'), true);

console.log('\n[표로 만들지 않는 경우]');
// 오더가 여럿인 목록 답변은 표가 한 덩이라 어느 값이 어느 오더 것인지 알 수 없게 된다.
check('여러 건 목록은 평문',
  k.splitForItemList('총 2건입니다.\n접수번호 OID1\n예약시간: 1\n접수번호 OID2\n예약시간: 2'), null);
// 항목이 하나뿐이면 표가 될 수 없다(정의서 최소 2개).
check('항목 하나는 평문', k.splitForItemList('안내\n상태: 완료'), null);
check('라벨이 없으면 평문', k.splitForItemList('접수하겠습니다.\n· 2026-09-20 18:30\n· 토레스'), null);
check('빈 글도 안전', k.splitForItemList(''), null);
// 열 개를 넘으면 표로 만들지 않는다(정의서 최대 10개) — 잘라서 일부만 보내면 정보가 사라진다.
const many = Array.from({ length: 11 }, (_, i) => `항목${i}: 값${i}`).join('\n');
check('열 개 초과는 평문', k.splitForItemList(many), null);

console.log('\n[발송 규약]');
// 제약 값은 정의서에서 온 것이라 코드에 근거를 남긴다.
check('제목·설명 한도가 상수로', /ITEM_TITLE_MAX = 6/.test(src) && /ITEM_DESC_MAX = 23/.test(src), true);
check('최소·최대 개수도', /ITEM_MIN = 2/.test(src) && /ITEM_MAX = 10/.test(src), true);
// 리치 발송이 실패해도 통보는 나가야 한다 — 서식 하나 때문에 통째로 안 나가는 쪽이 훨씬 나쁘다.
check('리치 실패 시 평문으로 다시 보낸다',
  /postJson\('\/send\/rich'[\s\S]{0,200}if \(rich\.ok\) return rich;[\s\S]{0,200}postJson\('\/send\/plain'/.test(src), true);
check('평문 강제 옵션이 있다', /options && options\.plain/.test(src), true);
// 리치 섹션 모양이 정의서와 같아야 한다(attachment.item.list).
const body = k.itemListBody('본문', [{ title: '상태', description: '완료' }, { title: '요금', description: '0원' }]);
check('섹션 타입', body.chapters[0].sections[0].type, 'item_list');
check('항목이 attachment.item.list에', body.chapters[0].sections[0].attachment.item.list.length, 2);
check('본문은 data에', body.chapters[0].sections[0].data, '본문');
// 버튼은 그대로 붙는다(사진 보기·실시간 위치 링크가 버튼으로 나가는 자리).
const withBtn = k.itemListBody('본문', [{ title: 'a', description: 'b' }, { title: 'c', description: 'd' }],
  [{ name: '열기', type: 'WL', url_pc: 'https://x.test', url_mobile: 'https://x.test' }]);
check('버튼을 붙일 수 있다', withBtn.chapters[0].sections[0].attachment.buttons.length, 1);
// 한도를 넘긴 값이 들어와도 카카오가 거절하지 않게 잘라 담는다(마지막 방어선).
const clipped = k.itemListBody('본문', [
  { title: '아주아주긴제목', description: 'x'.repeat(40) },
  { title: '상태', description: '완료' },
]);
check('제목을 6자로 자른다', clipped.chapters[0].sections[0].attachment.item.list[0].title.length, 6);
check('설명을 23자로 자른다', clipped.chapters[0].sections[0].attachment.item.list[0].description.length, 23);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
