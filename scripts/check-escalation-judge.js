// "사람이 봐야 하는 대화인가" 판정을 실제 상담 발화로 확인한다.
//
// 표본은 핸들모빌리티 탁송 상담톡 로그(2024-04 ~ 2026-08)에서 그대로 가져온 문장이다. 원본
// 로그는 실명·번호가 들어 있어 저장소 밖에 있으므로, 여기에는 개인정보가 없는 문장만 옮겨
// 적었다(차량번호는 지웠다).
//
// 왜 이 확인이 필요한가: 예전에는 정규식 하나가 전부였는데, 그 정규식으로 로그를 재생해보니
// 불만·사고류로 읽히는 발화 61건 중 2건만 잡혔다. 나머지는 봇이 그대로 자동 응대로 가져갔다.
// 반대 방향도 똑같이 위험하다 — "아직 배정 안 되었을까요"까지 사람에게 넘기면 배차 도우미가
// 할 일이 없어진다. 두 방향을 같이 본다.
//
// Gemini를 실제로 부른다(판정 자체가 확인 대상이라 흉내 낼 수 없다). 발신도 DB 쓰기도 없다.
//
//   node scripts/check-escalation-judge.js
require('dotenv').config();
const judge = require('../lib/escalationJudge');

// [문장, 사람이 봐야 하는가]
const CASES = [
  // --- 키워드가 이미 잡던 것 ---
  ['탁송 중 차량에 파손이 생겼습니다', true],
  ['블랙박스를 탈거해서 고객에게 드렸다고 하네요', true],

  // --- 키워드가 놓치던 것(이번에 표기 변형으로 메운 것) ---
  ['군포에서 이동되는 차량들은 상품화가 완료된 차량으로 실내외관 스크레치나 하자 발생 시 문제가 됩니다', true],
  ['기사님에게 구두로 설명도 드렸는데도 누락되어 컴플레인 들어왔습니다', true],

  // --- 키워드로는 못 잡고 LLM이 읽어야 하는 것 ---
  ['각 차량별 주유 5천원 전달 드렸는데 5건 중 3건 미진행입니다. 앞으로 누락 없이 잘 부탁드리겠습니다', true],
  ['5월 정산내역 중 주유영수증이 누락되었습니다. 확인부탁드립니다', true],
  ['발송요금을 영수증 내역보다 3000원 더 부가하는 이유가? 보내신 내용이 이해가 안 되서요', true],
  ['주유 진행하실 때 당분간 현금영수증(지출증빙) 중단 부탁 드립니다. 회계팀 확인 후 다시 요청드리겠습니다', true],
  ['연락도 없이 알아서 가셨네요', true],

  // --- 사람에게 넘기면 안 되는 것(봇이 답할 수 있다) ---
  ['아직 배정 안 되었을까요', false],
  ['기사님 배정되었나요?', false],
  ['탁송 출발사진 좀 확인부탁드립니다', false],
  ['이 차량에 대한 출발 도착사진이 없네요', false],
  ['요일을 잘못 기재하였네요. 오늘 17일 요청 차량입니다', false],
  ['15시 도착예정으로 변경 가능할까요?', false],
  ['이 차 아직 배정 전이면 취소 부탁드립니다', false],
  ['제주도에서 군포로 탁송 진행 가능할까요? 비용은 어느정도 될까요', false],
];

let failed = 0;

async function main() {
  console.log('[키워드 판정] — 오탐이 없는 말만. 여기 걸리면 되묻지 않고 바로 사람에게 넘어간다.');
  // 키워드는 "확실한 것만" 담당한다. false여도 아래 LLM이 받으므로 실패가 아니다 —
  // 반대로 false여야 할 문장을 키워드가 잡으면 그건 바로 회귀다.
  for (const [text, want] of CASES) {
    const hit = judge.needsHumanByKeyword(text);
    if (!want && hit) {
      failed += 1;
      console.log(`  실패 정상 요청을 키워드가 잡았다: "${text}"`);
    } else if (hit) {
      console.log(`  잡음 "${text.slice(0, 40)}…"`);
    }
  }
  console.log(`  → 키워드가 잡은 것 ${CASES.filter(([t]) => judge.needsHumanByKeyword(t)).length}건 / 전체 ${CASES.length}건`);

  console.log('\n[최종 판정] — 키워드 또는 LLM 중 하나라도 사람이 봐야 한다고 하면 넘긴다.');
  // 실제 라우트가 하는 것과 같은 합성이다(routes/kakaoConsult.js): 맨 앞에서 키워드로 한 번
  // 걸러내고, 통과한 것만 분류와 나란히 LLM 판정에 태운다.
  for (const [text, want] of CASES) {
    const byKeyword = judge.needsHumanByKeyword(text);
    const judged = byKeyword ? null : await judge.judgeNeedsHuman(text).catch((e) => {
      console.log(`  (판정 호출 실패: ${e.message})`);
      return null;
    });
    const got = byKeyword || !!(judged && judged.needsHuman);
    const ok = got === want;
    if (!ok) failed += 1;
    const how = byKeyword ? '키워드' : (judged ? `LLM/${judged.category}` : 'LLM실패');
    console.log(`  ${ok ? 'OK  ' : '실패'} [${how}] ${got ? '인계' : '자동응대'} ← "${text.slice(0, 46)}${text.length > 46 ? '…' : ''}"`);
    if (!ok) console.log(`         기대: ${want ? '인계' : '자동응대'}${judged && judged.reason ? ` / 모델 근거: ${judged.reason}` : ''}`);
  }

  console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
