// 상담원 응대 중에 들어온 "조회" 질문에도 답변 초안이 만들어지는지 확인한다.
//
// 실사용 사고(2026-08-24):
//   고객: 상담원연결
//   AI  : 상담원을 연결해드릴게요.
//   상담원: 안녕하세요 무엇을 도와드릴까요?      ← 여기서 세션이 agent_active
//   고객: 인천영종도 가는콜 배차가 되었나요?
//   (30초가 지나도 아무 일 없음)
//
// 자동 발송(30초)은 "초안이 대기 중일 때"만 돈다. 그런데 buildSuggestion은 접수·요금·운영시간·
// FAQ만 본다 — 주문 조회·취소 같은 배차 도우미 용건은 아예 다루지 않아서 초안이 만들어지지
// 않았고, 초안이 없으니 자동 발송도 봇 복귀도 걸리지 않았다.
//
// 봇 응대 경로는 같은 질문을 tryDispatchAgent로 답한다. 그 도우미를 초안 경로에서도 쓰되,
// **투기 실행(speculative)** 으로 돌려야 한다 — 채택될지 모르는 초안이 등록·취소를 실행하거나
// 확인 대기 상태를 저장하면, 고객의 다음 "네"가 엉뚱한 행위의 동의로 소비된다.
//
// 외부 호출과 DB는 전부 가짜로 바꾼다.
//
//   node scripts/check-agent-lookup-suggestion.js
require('dotenv').config();

function stub(relPath, exports) {
  const full = require.resolve(relPath);
  require.cache[full] = { id: full, filename: full, loaded: true, exports };
  return exports;
}

let dispatchArgs = null;
let dispatchResult = { handled: true, message: '진행 중인 주문 1건입니다.\n1. 접수번호 OID1459' };
stub('../lib/mcpDispatchAgent', {
  runDispatchAgent: async (args) => { dispatchArgs = args; return dispatchResult; },
  loadPending: async () => null,
  clearPending: async () => {},
  checkDispatchDelay: async () => null,
  isLocationQuestion: () => false,
  TOOL_DECLARATIONS: [],
});

// 이 검사에서 실제로 도는 건 buildDispatchSuggestion 하나뿐이라, 그 안에서 쓰는 조회만 채운다.
stub('../db', {
  get: async () => ({ id: 1, name: '검사용', phone: '01000000000', role: 'client', branch_id: null, group_id: null }),
  all: async () => [],
  run: async () => ({ rowCount: 0 }),
});

stub('../lib/kakaoIntakeService', {
  // 채널 매핑이 확정된 계정 — 조회 범위를 좁힐 필요가 없는(본인 자격) 형태.
  resolveIntakeContext: async () => ({
    user_id: 1, branch_id: null, requester_group_id: null,
    external_user_key: 'u1', matched_by: 'user_phone',
  }),
  findIntakeAccount: async () => null,
  findAccountByPhone: async () => null,
  linkUserKeyToAccount: async () => {},
  createOrdersFromIntake: async () => ({ ok: false }),
  describeMappedAccount: () => '',
});

const kakao = require('../routes/kakaoConsult');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok || !detail ? '' : `\n         ${detail}`}`);
}

const SESSION = { id: 1, status: 'agent_active', external_phone: '01000000000', external_user_key: 'u1' };

(async () => {
  console.log('[조회 질문에 초안이 만들어진다]');
  {
    dispatchArgs = null;
    const s = await kakao.buildDispatchSuggestion(SESSION, '인천영종도 가는콜 배차가 되었나요?');
    check('초안을 만든다', !!s, JSON.stringify(s));
    check('종류가 dispatch', s && s.kind === 'dispatch', s && s.kind);
    check('도우미 답변을 그대로 담는다', s && s.text === dispatchResult.message, s && s.text);
    // 핵심 안전장치 — 채택될지 모르는 초안이 상태를 건드리면 안 된다.
    check('투기 실행으로 돌린다(speculative)', dispatchArgs && dispatchArgs.speculative === true,
      JSON.stringify(dispatchArgs && { speculative: dispatchArgs.speculative }));
    check('세션을 그대로 넘긴다', dispatchArgs && dispatchArgs.sessionId === SESSION.id);
  }

  console.log('\n[도우미가 처리하지 못하면 초안을 만들지 않는다]');
  {
    // 투기 실행이 변경 도구를 만나 물러난 경우 등 — 빈 초안은 상담원 화면의 소음이다.
    dispatchResult = { handled: false, reason: 'speculative_mutation' };
    const s = await kakao.buildDispatchSuggestion(SESSION, '주문 취소해줘');
    check('초안 없음', s === null, JSON.stringify(s));
    dispatchResult = { handled: true, message: '진행 중인 주문 1건입니다.' };
  }

  console.log('\n[buildSuggestion은 여전히 조회를 다루지 않는다 — 이 초안이 그 구멍을 메운다]');
  {
    // 이 줄이 깨지면(= buildSuggestion이 조회까지 처리하게 되면) 위 폴백은 필요 없어진 것이니
    // 중복 초안이 생기지 않는지 다시 살펴야 한다.
    const { buildSuggestion } = require('../lib/agentAssist');
    const s = await buildSuggestion('내 주문 취소해줘', {}).catch(() => null);
    check('취소 요청에 초안을 만들지 않는다', s === null, JSON.stringify(s));
  }

  console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
