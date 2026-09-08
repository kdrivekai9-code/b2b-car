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
check('말풍선 하나', t.length, 1);
check('요청한 세 항목이 표로', t[0].rows.map((r) => r.title), ['예약시간', '상태', '요금']);
check('값도 함께', t[0].rows.map((r) => r.description), ['2026-09-08 16:20', '운행시작', '40,000원']);
check('라벨 없는 문장은 본문', t[0].body, 'OID2075(182353721) 주문입니다.');

console.log('\n[오더가 여럿이면 말풍선을 나눈다]');
// 처음에는 접수번호가 둘 이상이면 통째로 포기했는데, 실사용 조회 답변은 대개 여러 건이라
// 표가 한 번도 안 나왔다(2026-09-08). 카카오는 한 요청에 말풍선을 여러 개 담을 수 있다.
const two = [
  '오늘 예약된 주문은 총 1건입니다.',
  '접수번호 OID2075(182353721)',
  '예약시간: 2026-09-08 15:20',
  '출발지: 서울 강서구 양천로53길 30 서서울모터리움 803호 KGM인증중고차 (010-****-1240)',
  '상태: 운행시작, 요금: 0원',
  '',
  '접수일이 오늘인 주문도 1건 있습니다(예약일은 다른 날).',
  '접수번호 OID2150(182432031)',
  '예약시간: 2026-09-09 18:30',
  '상태: 대기, 요금: 0원',
].join('\n');
const multi = k.splitForItemList(two);
check('안내 + 오더 둘 = 말풍선 셋', multi.length, 3);
check('첫 말풍선은 안내 문장', [multi[0].rows.length, multi[0].body], [0, '오늘 예약된 주문은 총 1건입니다.']);
check('접수번호도 표의 첫 행', multi[1].rows[0], { title: '접수번호', description: 'OID2075(182353721)' });
// 한 줄에 두 항목이 붙어 오면 쪼갠다("상태: 운행시작, 요금: 0원") — 안 쪼개면 표가 어긋난다.
check('한 줄 두 항목을 쪼갠다', multi[1].rows.map((r) => r.title), ['접수번호', '예약시간', '상태', '요금']);
// 라벨 붙은 긴 줄(주소)은 그 오더 값이라 같은 말풍선 본문에 남는다.
check('긴 주소는 그 말풍선 본문에', multi[1].body.includes('KGM인증중고차'), true);
// 라벨 없는 문장은 다음 오더의 머리말이다 — 앞 말풍선에 섞이면 안 된다.
check('다음 오더 머리말은 다음 말풍선으로', multi[2].body.startsWith('접수일이 오늘인 주문도'), true);
check('둘째 오더 값이 섞이지 않는다', multi[2].rows.map((r) => r.description),
  ['OID2150(182432031)', '2026-09-09 18:30', '대기', '0원']);

console.log('\n[잘릴 값은 표에 넣지 않는다]');
// 23자 제약. 주소를 표에 넣으면 번지가 잘려 못 읽는다 — 자르는 대신 본문으로 보낸다.
const t2 = k.splitForItemList('안내입니다.\n출발지: 서울 강서구 양천로53길 30 서서울모터리움 803호 KGM인증중고차\n상태: 운행시작\n요금: 0원');
check('긴 값은 표에서 빠진다', t2[0].rows.map((r) => r.title), ['상태', '요금']);
check('빠진 값은 본문에 온전히 남는다', t2[0].body.includes('KGM인증중고차'), true);
// 제목 6자 제약.
const t3 = k.splitForItemList('최종 운행 거리: 123km\n상태: 완료\n요금: 0원');
check('제목이 6자를 넘으면 본문으로', t3[0].rows.map((r) => r.title), ['상태', '요금']);
check('그 줄은 본문에 남는다', t3[0].body.includes('최종 운행 거리: 123km'), true);
// 링크는 표에 넣지 않는다(23자 초과 + 표에서는 누를 수 없다 — 링크는 버튼으로 나간다).
const t4 = k.splitForItemList('상태: 완료\n요금: 0원\n사진 보기: https://example.test/photos/abc');
check('링크는 표에 안 들어간다', t4[0].rows.length, 2);
check('링크 줄은 본문에', t4[0].body.includes('https://example.test/photos/abc'), true);

console.log('\n[표로 만들지 않는 경우]');
// 항목이 하나뿐이면 표가 될 수 없다(정의서 최소 2개) — 그 줄은 문장으로 되돌린다.
check('항목 하나는 평문', k.splitForItemList('안내\n상태: 완료'), null);
check('라벨이 없으면 평문', k.splitForItemList('접수하겠습니다.\n· 2026-09-20 18:30\n· 토레스'), null);
check('빈 글도 안전', k.splitForItemList(''), null);
// 말풍선이 너무 많으면(오더 다섯 건 초과) 표로 나누지 않는다 — 알림이 도배된다.
const manyOrders = Array.from({ length: 6 }, (_, i) =>
  `접수번호 OID${i}\n예약시간: 2026-09-0${i + 1} 10:00\n상태: 대기`).join('\n');
check('말풍선 다섯 개 초과는 평문', k.splitForItemList(manyOrders), null);
// 한 오더의 항목이 열 개를 넘으면 그 오더는 표로 만들지 않는다(정의서 최대 10개).
const manyRows = ['접수번호 OID1'].concat(Array.from({ length: 11 }, (_, i) => `항목${i}: 값${i}`)).join('\n');
const over = k.splitForItemList(manyRows);
check('항목 열 개 초과는 표 없음', over, null);

console.log('\n[발송 규약]');
// 제약 값은 정의서에서 온 것이라 코드에 근거를 남긴다.
check('제목·설명 한도가 상수로', /ITEM_TITLE_MAX = 6/.test(src) && /ITEM_DESC_MAX = 23/.test(src), true);
check('최소·최대 개수도', /ITEM_MIN = 2/.test(src) && /ITEM_MAX = 10/.test(src), true);
// 리치 발송이 실패해도 통보는 나가야 한다 — 서식 하나 때문에 통째로 안 나가는 쪽이 훨씬 나쁘다.
// 성공 경로에 진단 로그가 끼어들어도(2026-09-08) 이 관계는 유지돼야 한다 — 리치를 먼저
// 시도하고, 실패하면 같은 함수 안에서 평문으로 되돌아간다.
check('리치 실패 시 평문으로 다시 보낸다',
  /postJson\('\/send\/rich'[\s\S]{0,1200}postJson\('\/send\/plain'/.test(src)
  && /return postJson\('\/send\/plain', session, textBody\(text, buttons\)\);/.test(src), true);
// 실패 이유를 DB에 남겨야 운영에서 읽을 수 있다 — 콘솔만 남기면 "표가 안 나온다"의 원인을
// 알 수 없다(실제로 그 상태였다).
check('실패 이유를 DB에 남긴다', /operation: 'send_item_list'/.test(src), true);
// 성공도 한 번은 남긴다: 카카오가 받아줬는데 평문으로 보이는 경우와 거절당한 경우를 가른다.
check('성공도 한 번은 남긴다', /operation: 'send_item_list_ok'/.test(src) && /loggedRichAccepted/.test(src), true);
check('평문 강제 옵션이 있다', /options && options\.plain/.test(src), true);
// 리치 섹션 모양이 정의서와 같아야 한다(attachment.item.list).
const body = k.itemListBody([{ body: '본문', rows: [{ title: '상태', description: '완료' }, { title: '요금', description: '0원' }] }]);
check('섹션 타입', body.chapters[0].sections[0].type, 'item_list');
check('항목이 attachment.item.list에', body.chapters[0].sections[0].attachment.item.list.length, 2);
check('본문은 data에', body.chapters[0].sections[0].data, '본문');
// 말풍선 여러 개 = chapters 여러 개(명세: chapters[]는 "메시지 목록").
const multiBody = k.itemListBody([
  { body: '안내', rows: [] },
  { body: '', rows: [{ title: 'a', description: 'b' }, { title: 'c', description: 'd' }] },
]);
check('안내는 평문 말풍선', multiBody.chapters[0].sections[0].type, 'text');
check('표는 그다음 말풍선', multiBody.chapters[1].sections[0].type, 'item_list');
// 버튼은 그대로 붙는다(사진 보기·실시간 위치 링크가 버튼으로 나가는 자리).
const withBtn = k.itemListBody(
  [{ body: '본문', rows: [{ title: 'a', description: 'b' }, { title: 'c', description: 'd' }] }],
  [{ name: '열기', type: 'WL', url_pc: 'https://x.test', url_mobile: 'https://x.test' }]
);
check('버튼을 붙일 수 있다', withBtn.chapters[0].sections[0].attachment.buttons.length, 1);
// 한도를 넘긴 값이 들어와도 카카오가 거절하지 않게 잘라 담는다(마지막 방어선).
const clipped = k.itemListBody([{ body: '본문', rows: [
  { title: '아주아주긴제목', description: 'x'.repeat(40) },
  { title: '상태', description: '완료' },
] }]);
check('제목을 6자로 자른다', clipped.chapters[0].sections[0].attachment.item.list[0].title.length, 6);
check('설명을 23자로 자른다', clipped.chapters[0].sections[0].attachment.item.list[0].description.length, 23);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
