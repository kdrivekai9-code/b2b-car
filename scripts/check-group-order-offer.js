// "법인 전체에서도 확인해드릴까요?" 제안 검사.
//
// 왜 필요한가: MCP 조회는 **연락처 기준**이다(primaryCid + 이용고객 번호 + 연결 번호).
// 그래서 본사 직원이 물어도 자기 번호로 나간 건만 나오고 옆자리 동료 건은 안 보인다.
// 그런데 웹 화면에서는 본사 직원이 법인 전체를 본다(lib/clientScope.js) — 같은 사람이
// 같은 회사 일을 묻는데 채널에 따라 답이 다르면 안 된다.
//
// 자동으로 넓히지는 않는다. "내 주문"을 물은 사람에게 남의 주문을 섞으면 목록이 길어져
// 정작 자기 건을 못 찾는다. 그래서 본인 것을 먼저 답하고 그다음에 묻는다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok || !detail ? '' : `  (${detail})`}`);
}
const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const src = read('lib/mcpDispatchAgent.js');
const access = read('lib/mcpDispatchAccess.js');

console.log('[두 경로가 같은 규칙을 쓴다]');
// 빠른 경로(정해진 문장)와 모델 경로가 따로 문장을 만들면, 같은 질문에 표현만 달라도 답이 갈린다.
check('목록 답변을 한 함수가 만든다', /async function buildListAnswer/.test(src));
check('빠른 경로가 그 함수를 쓴다',
  /get_my_orders\(fast\)[\s\S]{0,120}offerGroup/.test(src)
  || /buildListAnswer\(ctx, sessionId, quick/.test(src));
check('모델 경로도 그 함수를 쓴다', /buildListAnswer\(ctx, sessionId, lastOrderList/.test(src));

console.log('\n[언제 묻나]');
// 이어보기가 걸린 턴에는 묻지 않는다 — 한 번에 두 가지를 물으면 "네"가 어느 쪽인지 모른다.
check('5건 이하일 때만 묻는다', /offerGroup && total <= LIST_PAGE_SIZE/.test(src));
// 다른 담당자 건이 없으면 물어봐야 줄 것이 없다.
check('다른 담당자 건이 있을 때만', /if \(others > 0\)/.test(src));
// 초안·투기 실행은 대기 상태를 남기면 안 된다(채택되지 않은 초안이 고객의 "네"를 삼킨다).
check('초안·투기 실행에서는 묻지 않는다', /offerGroup: !speculative && !draftMode/.test(src));

console.log('\n[개인 딜러는 제외]');
// 딜러는 본인 오더만 보는 자격이라 물어봐도 줄 것이 없고, 물음 자체가 "볼 수 있는 게 더
// 있다"는 잘못된 신호가 된다.
check('딜러면 0을 돌려준다', /clientScope\.isDealer\([\s\S]{0,80}return 0;/.test(src));
check('컨텍스트가 구분을 싣는다', /clientType: user\.client_type/.test(access));
check('컨텍스트가 법인을 싣는다', /requesterGroupId: \(options && options\.requesterGroupId\) \|\| user\.group_id/.test(access));

console.log('\n[법인 목록은 우리 DB에서]');
// 연락처가 아니라 법인이 기준이라 MCP 도구로는 애초에 물어볼 수 없고, 우리 DB에는
// 접수한 순간부터 다 있다.
check('법인 기준으로 읽는다', /WHERE o\.requester_group_id = \? AND o\.status NOT IN/.test(src));
check('끝난 건은 뺀다', /requester_group_id = \?[\s\S]{0,80}NOT IN \('완료', '취소'\)/.test(src));
// 누가 접수했는지가 이 목록의 핵심이다 — 본인 것과 구분되지 않으면 넓힌 의미가 없다.
check('접수자를 함께 보여준다', /requester_name/.test(src) && /접수자:/.test(src));
check('건수를 제한한다', /Math\.min\(Number\(limit\) \|\| 10, 30\)/.test(src));

console.log('\n[상태 출처를 숨기지 않는다]');
// 본인 목록은 콜마너에 실시간으로 묻고(get_my_orders), 법인 목록은 우리 DB 사본을 읽는다.
// 사본은 매분 동기화가 갱신하므로 늦을 수 있다 — 같은 주문이 한 대화 안에서 다른 상태로
// 보일 수 있다는 뜻이다. 숨기면 고객이 두 답을 대조하다 우리를 못 믿게 된다.
check('사본이라는 사실을 밝힌다', /접수 기록 기준입니다/.test(src));
check('늦을 수 있다고 말한다', /최대 1분 늦을 수 있습니다/.test(src));
// 실측: 법인 1의 진행 중 48건 중 콜마너에 올라간 건은 2건뿐이었다. 기다리는 사람에게는
// "아직 안 올라갔다"가 상태보다 중요한 정보다.
check('콜마너에 없는 건은 그 사실을 적는다', /아직 배차 시스템에 올라가지 않았습니다/.test(src));
// "담당자 확정 대기"라고 쓰면 확정만 하면 진행되는 것처럼 읽힌다. 실제로는 전송이 실패했거나
// 아예 나가지 않은 것이다 — 우리는 접수 즉시 콜마너에 올리고 항상 대기로 등록한다.
check('"확정 대기"라고 하지 않는다', !/담당자 확정 대기/.test(src));
check('전송 실패는 따로 말한다', /배차 시스템 전송이 실패해/.test(src));
check('올라간 건은 마지막 확인 시각을 붙인다', /최종 확인: \$\{o\.callmaner_synced_at\}/.test(src));
// 콜마너가 쓰는 말과 우리 말이 다르다(배차 / 기사배정). 다른 단어면 다른 상태로 읽힌다.
check('콜마너 표현을 함께 보여준다', /배차 시스템: \$\{o\.callmaner_status\}/.test(src));

console.log('\n[응답 처리]');
check('제안 대기를 따로 둔다', /action: 'group_list_offer'/.test(src));
// 목록 흐름의 이어짐이라 변경 확인 대기와 섞이면 안 된다.
check('변경 확인보다 먼저 처리한다',
  src.indexOf("action === 'group_list_offer'") < src.indexOf('// 1) 확인 대기 중이면'));
// 여기만 다른 규칙을 두면 "네 보여주세요"가 한쪽에서만 통한다.
check('기존 긍정 판정을 쓴다', /isAffirmativeReply\(text, null\)/.test(src));
// 아니라고 했으면 대기만 지우고 다른 용건으로 흘려보낸다.
check('거절해도 대화를 끊지 않는다',
  /group_list_offer'\)[\s\S]{0,700}아래 정상 경로로/.test(src));

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
