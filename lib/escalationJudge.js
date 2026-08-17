// "이건 사람이 봐야 하는 대화인가" 판정.
//
// 왜 따로 떼어냈나: 원래 routes/kakaoConsult.js 안에 정규식 하나(ESCALATION_RE)만 있었는데,
// 실제 상담 로그(핸들모빌리티 탁송 상담톡 2024-04 ~ 2026-08, 고객 발화 2,889건)로 재현해보니
// 불만·사고류로 읽히는 발화 61건 중 그 정규식이 잡는 것은 2건뿐이었다. 놓친 것들:
//
//   · "각 차량별 주유 5천원 전달 드렸는데 5건 중 3건 미진행입니다. … 컴플레인 들어왔습니다"
//   · "실내외관 스크레치나 하자 발생 시" — 정규식에는 `스크래치`만 있고 `스크레치`가 없다
//   · "5월 정산내역 중 138고8805 주유영수증이 누락되었습니다"
//
// 키워드를 더 넣는 것만으로는 끝나지 않는다. 넓히면 이번엔 반대로 샌다 — "사진 누락됐어요"는
// 사진 핸들러가 답하면 되는 일이고, "아직 배정 안 되었을까요"는 배차 도우미가 답해야 하는
// 정상 조회다. 이 둘을 사람에게 넘기면 자동화가 오히려 후퇴한다.
//
// 그래서 둘로 나눴다:
//   1) 키워드(needsHumanByKeyword) — 오탐이 거의 없는 말만. 빠르고 LLM을 안 쓰므로 대화의
//      어느 단계에서든(확인 대기 중이라도) 맨 앞에서 볼 수 있다.
//   2) LLM(judgeNeedsHuman) — 나머지. "누락"이 정산 누락인지 사진 누락인지, "아직"이 재촉인지
//      항의인지는 문장을 읽어야 갈린다.
const { generateJson } = require('./vertexAi');

// 오탐이 사실상 없는 말만 넣는다 — 이 목록에 걸리면 되묻지 않고 바로 사람에게 넘긴다.
// 추가한 것은 전부 로그 실측 표현이다: `스크레치`(오타가 반복해서 나온다), `컴플레인`,
// `하자`, `탈거`(부품 임의 탈거), `흠집`/`찌그`, `훼손`, `민원`.
//
// 일부러 넣지 않은 것: `누락`, `미진행`, `아직`, `늦`. 정상 요청에도 흔해서 여기 넣으면
// 사진 요청·배차 조회가 통째로 상담원 연결로 샌다. 이런 것은 아래 LLM 판정이 본다.
const ESCALATION_RE = /(사고|파손|스크래치|스크레치|기스|찍힘|긁힘|흠집|찌그|훼손|하자|탈거|클레임|컴플레인|민원|분실|도난|고장|침수|변상|보상|항의|불만)/;

function needsHumanByKeyword(text) {
  return ESCALATION_RE.test(String(text || ''));
}

const JUDGE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    needsHuman: { type: 'BOOLEAN' },
    category: {
      type: 'STRING',
      enum: ['accident', 'complaint', 'settlement', 'policy', 'none'],
    },
    reason: { type: 'STRING' },
  },
  required: ['needsHuman', 'category'],
};

// 판정 기준은 "봇이 답할 수 있는 일인가"이지 "고객이 기분이 나쁜가"가 아니다. 재촉은 기분이
// 나빠도 봇이 실제로 답할 수 있고(조회하면 된다), 정산 누락은 말투가 정중해도 봇이 답할 수 없다.
const INSTRUCTION = `당신은 탁송 B2B 상담톡의 분류기입니다. 고객 메시지 하나를 보고 "챗봇이 자동 응대하면 안 되고 담당자(사람)가 직접 봐야 하는가"만 판정하세요.

needsHuman=true 로 판정할 것:
- accident: 차량 손상·사고·부품 임의 탈거·분실·도난 등 차량이나 물건에 문제가 생겼다는 언급
- complaint: 기사나 서비스에 대한 항의·불만·재발 방지 요구. 요청한 작업이 이행되지 않았다는 지적(예: "주유를 부탁했는데 안 됐다", "고객에게 컴플레인이 들어왔다")도 포함
- settlement: 정산·청구·세금계산서·영수증·월 마감·과태료·통행료의 금액이나 누락에 대한 문의
- policy: 앞으로의 작업 방식이나 사내 규칙을 바꿔달라는 요구(예: "이제부터 이렇게 처리해 주세요")

needsHuman=false 로 판정할 것 (category="none"):
- 배차·기사 배정·도착 여부를 묻거나 재촉하는 것. 답답해하는 말투라도 조회하면 답이 나오므로 false입니다.
- 접수·변경·취소 요청, 요금 견적 문의
- 사진이나 주행거리를 보내달라는 요청. "사진이 안 왔다", "사진이 누락됐다"도 여기에 해당합니다.
- 단순 확인·인사·감사 표현
- 고객이 자기 실수를 정정하는 것(예: "요일을 잘못 기재했네요")

애매하면 false로 두세요. 사람이 봐야 하는 것이 확실할 때만 true입니다.
reason에는 그렇게 본 근거를 한국어 15자 내외로 적으세요.`;

// 판정이 안 되면(모델 오류·타임아웃) false로 떨어진다 — 이 함수는 키워드 판정 뒤에 오는
// 보강이라, 실패했다고 대화를 막거나 사람을 부르지 않는다. 놓치면 예전 동작(키워드만)과 같다.
async function judgeNeedsHuman(text) {
  const s = String(text || '').trim();
  if (!s) return { needsHuman: false, category: 'none' };
  // 짧은 되받기("네", "확인했습니다")까지 모델에 보내지 않는다 — 호출부가 이미 스몰토크를
  // 걸러내지만, 이 함수를 다른 곳에서 부를 때도 같은 값이 나와야 한다.
  if (s.length < 6) return { needsHuman: false, category: 'none' };

  const out = await generateJson(INSTRUCTION, s, JUDGE_SCHEMA, { thinking: false, op: 'escalation_judge' });
  if (!out || typeof out.needsHuman !== 'boolean') return { needsHuman: false, category: 'none' };
  return { needsHuman: out.needsHuman, category: out.category || 'none', reason: out.reason || null };
}

const CATEGORY_LABEL = {
  accident: '사고·차량 손상',
  complaint: '불만·항의',
  settlement: '정산·비용',
  policy: '작업방식 변경 요청',
};

function categoryLabel(category) {
  return CATEGORY_LABEL[category] || '사람 확인 필요';
}

module.exports = { ESCALATION_RE, needsHumanByKeyword, judgeNeedsHuman, categoryLabel };
