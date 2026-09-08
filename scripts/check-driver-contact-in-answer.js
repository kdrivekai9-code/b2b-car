// 배차 이후에는 조회 답변에 기사 이름·연락처가 함께 나오는가.
//
// 왜(사용자 지정 2026-09-08): 상태가 배차·운행시작·완료면 그 상태에서 고객이 가장 먼저 찾는
// 값이 기사 연락처다. 없으면 "기사님 연락처요"를 한 번 더 묻게 된다 — 상담원 발화의 2.8%가
// 그 질문이었다.
//
// 배차 전(접수·대기·예약)에는 넣지 않는다. 그때는 기사가 없는 것이지 연락처가 없는 것이
// 아니라, 빈 줄을 내보내면 "연락처가 없다"로 읽힌다.
//
// 카카오 항목표의 설명 칸이 23자라 "이름 + 안심번호"가 한 줄에 들어가야 한다
// (이름 6자 + 공백 + 050-8324-6939 13자 = 20자).
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { normalizePhone } = require('../lib/kakaoIntakeParser');
const kakao = require('../lib/kakaoConsult');

let failures = 0;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${name}${ok ? '' : ` — 기대 ${JSON.stringify(want)} / 실제 ${JSON.stringify(got)}`}`);
}
const src = fs.readFileSync(path.join(__dirname, '../lib/mcpDispatchAgent.js'), 'utf8');

console.log('[어느 상태에서 보여주는가]');
// 우리 상태('기사배정')와 콜마너 표기('배차')가 다르다 — 한쪽만 보면 콜마너에만 있는 건에서
// 기사 줄이 빠진다.
check('배차 이후 상태 목록',
  /DRIVER_SHOWN_STATUSES = new Set\(\['배차', '기사배정', '운행시작', '완료'\]\)/.test(src), true);
// 배차 전 상태가 목록에 있으면 빈 기사 줄이 나간다.
const shownList = (src.match(/DRIVER_SHOWN_STATUSES = new Set\(\[([^\]]*)\]\)/) || [, ''])[1];
['접수', '대기', '예약', '취소'].forEach((st) => {
  check(`${st}는 목록에 없다`, shownList.includes(`'${st}'`), false);
});

console.log('\n[한 줄로 만든다]');
check('이름과 연락처를 한 줄로', /const parts = \[order\.기사명, order\.기사연락처\]/.test(src), true);
// 둘 중 하나만 있으면 있는 것만 적는다(지어내지 않는다).
check('빈 값은 걸러낸다', /\.filter\(Boolean\)/.test(src.slice(src.indexOf('function driverLine'), src.indexOf('function summarizeOrders'))), true);
// 상태가 배차 전이면 아예 빈 문자열을 돌려준다 — 호출부가 줄을 안 넣는다.
check('상태를 먼저 본다', /if \(!order \|\| !DRIVER_SHOWN_STATUSES\.has/.test(src), true);

console.log('\n[전화번호 형식]');
// 콜마너는 "05083246939"처럼 붙여서 준다 — 읽기 어렵고 카카오톡에서 눌러 걸 수도 없다.
check('안심번호에 하이픈', normalizePhone('05083246939'), '050-8324-6939');
check('휴대폰도 같은 규칙', normalizePhone('01050832243'), '010-5083-2243');
check('이미 하이픈이면 그대로', normalizePhone('0503-1234-5678'), '0503-1234-5678');
check('형식을 답변에서 적용한다', /기사연락처: phone \? normalizePhone\(phone\) : null/.test(src), true);
// 규칙이 두 벌이 되면 화면마다 번호 모양이 달라진다.
check('접수 파서와 같은 함수', /const \{ normalizePhone \} = require\('\.\/kakaoIntakeParser'\)/.test(src), true);

console.log('\n[답변에 실제로 들어간다]');
// 고정 목록 답변(서버가 문장을 만드는 경로)
check('목록 답변이 기사 줄을 넣는다', /const driver = driverLine\(o\);[\s\S]{0,120}기사: \$\{driver\}/.test(src), true);
// 모델이 쓰는 답변(프롬프트 규칙)
check('프롬프트가 형식을 지정한다', /"기사: \{기사명\} \{기사연락처\}" 한 줄입니다/.test(src), true);
check('프롬프트가 배차 전에는 빼라고 한다', /배차 전 상태\(접수·대기·예약\)에서도 이 줄을 넣지 마세요/.test(src), true);
check('상세 안내 순서에도 자리가 있다', /상태 →\n  기사\(배차 이후에만\) → 요금/.test(src), true);

console.log('\n[질문에 맞는 답이 나가는가]');
// 실사용 사고(2026-09-08): "OID2075 배차기사 전화번호와 이름은?", "첫번째오더 배차기사정보
// 알려줘"에 **진행 중 주문 목록 전체**가 답으로 왔다. 기사 정보는 get_my_orders 결과에 있어
// 모델이 그 도구를 부른 것은 옳았는데, 서버가 "목록만 물어본 턴"으로 보고 모델 답변을 버리고
// 목록 문장으로 갈아치웠다. 그 장치 자체는 필요하다(모델이 기사배정 여부를 뒤집은 사고가
// 있었다) — 다만 **목록을 물어본 턴에만** 적용해야 한다.
check('특정 항목을 물은 턴은 모델이 답한다',
  /const askedSomethingSpecific = FIXED_QUERY_BLOCKERS_RE\.test\(String\(text \|\| ''\)\);/.test(src), true);
check('목록 갈아치우기에 그 조건이 걸려 있다',
  /const listOnly = lastOrderList && usedTools\.length > 0[\s\S]{0,160}&& !askedSomethingSpecific;/.test(src), true);
// 판정 규칙을 새로 만들지 않고 고정 빠른 응답이 쓰는 것을 재사용한다 — 두 벌이 되면 한쪽만
// 고쳐져서 "어떤 질문이 목록이냐"가 화면마다 달라진다.
check('판정 규칙을 재사용한다', /FIXED_QUERY_BLOCKERS_RE = new RegExp/.test(src), true);
// 그 규칙에 기사·연락처·요금·위치·순번·접수번호가 들어 있어야 이 사고가 다시 안 난다.
const blockers = (src.match(/FIXED_QUERY_BLOCKERS_RE = new RegExp\(\[([\s\S]*?)\]\.join/) || [, ''])[1];
['기사', '연락처', '전화번호', '요금', '위치', '접수번호'].forEach((w) => {
  check(`"${w}"가 판정에 들어 있다`, blockers.includes(w), true);
});

console.log('\n[순번 지목은 직전 답변 기준]');
// 도구가 돌려주는 목록 순서는 직전 답변 순서와 다르다. 실측에서 "두번째 오더"를 물었을 때
// 도구 결과의 두 번째(=직전 답변의 첫 번째)를 골라 **엉뚱한 오더의 기사 연락처**를 안내했다.
check('도구 순서와 다르다고 못 박는다',
  /\*\*도구가 돌려주는 목록의 순서는 직전 답변의 순서와 다릅니다\.\*\*/.test(src), true);
check('방금 보낸 답변 기준으로 세라고 한다', /당신이 방금\n  보낸 답변에 적은 순서로 세세요/.test(src), true);
check('고른 접수번호를 밝히라고 한다', /답변 첫머리에 그 주문의\n  접수번호를 밝혀/.test(src), true);

console.log('\n[카카오 항목표에 한 행으로 들어간다]');
const bubbles = kakao.splitForItemList([
  '오늘 예약된 주문은 총 1건입니다.',
  '접수번호 OID2075(182353721)',
  '예약시간: 2026-09-08 15:20',
  '상태: 운행시작',
  '기사: 채정식 050-8324-6939',
  '요금: 0원',
].join('\n'));
const rows = bubbles[bubbles.length - 1].rows;
check('상태 다음 행이 기사', rows.map((r) => r.title), ['접수번호', '예약시간', '상태', '기사', '요금']);
check('이름과 번호가 한 칸에', rows.find((r) => r.title === '기사').description, '채정식 050-8324-6939');
// 23자 한도 안이어야 표에 남는다 — 넘으면 본문으로 밀려 표에서 사라진다.
check('23자 한도 안', rows.find((r) => r.title === '기사').description.length <= 23, true);
// 이름이 긴 경우까지 여유가 있는지(6자 + 공백 + 13자 = 20자).
const long = kakao.splitForItemList('접수번호 X1\n상태: 완료\n기사: 김하늘별님 050-8324-6939\n요금: 0원');
check('긴 이름도 표에 남는다', long[long.length - 1].rows.some((r) => r.title === '기사'), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
