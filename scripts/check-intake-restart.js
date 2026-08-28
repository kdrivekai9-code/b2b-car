// 접수 도중 다른 오더로 갈아탈 때 앞 내용과 섞이지 않는지.
//
// 사용자 지적(2026-08-28): "챗봇에서 오더 접수하다가 다른 오더로 변경할 때 이 부분이 정리가
// 안 되면 기존 오더랑 혼재가 될 것 같다." 실제로 그랬다.
//
// 되묻기 중에는 이번 발화를 앞 원문에 이어붙인다 — "차량번호는 12가3456이요"만 와도 앞서 받은
// 출발지·도착지가 사라지지 않게 하려는 장치다. 그런데 고객이 도중에 다른 오더로 갈아타면 그
// 이어붙이기가 두 주문을 한 문장으로 만든다. 실제 분류기로 확인한 결과:
//
//   "강남역→판교역 탁송" + "판교역에서 인천공항으로 하나 더 접수해줘"
//     → 출발지 강남역(옛 것), 도착지 없음. 새 주문의 출발지(판교역)가 아니다.
//   "강남역→판교역 탁송" + "아니요 사당역에서 서초동으로 바꿔주세요"
//     → 출발지·도착지가 둘 다 사라진다(모순된 두 경로를 읽다 아무것도 못 뽑는다).
//
// 그래서 "이번 발화 하나에 출발과 도착이 다 있으면 갈아타기"로 보고 앞 내용을 버린다.
// 이 검사는 그 판정이 양쪽으로 치우치지 않는지 본다 — 보충 답변을 갈아타기로 잘못 보면
// 멀쩡히 받아둔 출발·도착이 날아가고, 갈아타기를 보충으로 잘못 보면 두 주문이 섞인다.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { looksLikeRouteRestart, looksSelfContained } = require('../lib/intakeSlotState');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}
function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

console.log('[갈아타기 — 앞 내용을 버려야 한다]');
// 실측 사례 두 가지.
check('다른 경로로 하나 더', looksLikeRouteRestart('판교역에서 인천공항으로 탁송 하나 더 접수해줘'), true);
check('정정(아니요 …로 바꿔주세요)', looksLikeRouteRestart('아니요 사당역에서 서초동으로 바꿔주세요'), true);
check('화살표 표기', looksLikeRouteRestart('사당역 → 서초동'), true);
check('까지 표기', looksLikeRouteRestart('강남역에서 인천공항까지요'), true);

console.log('[보충 답변 — 이어붙여야 한다]');
// 여기서 하나라도 true가 되면 이미 받아둔 출발·도착이 날아간다. 이쪽이 더 비싼 실수다.
check('도착지만 답함', looksLikeRouteRestart('판교역이요'), false);
check('차량번호만 답함', looksLikeRouteRestart('차량번호는 12가3456이요'), false);
check('시각만 답함', looksLikeRouteRestart('내일 오후 3시요'), false);
// looksSelfContained는 이걸 완결로 본다(만료 안내를 건너뛰는 용도) — 갈아타기 판정에 그걸
// 그대로 쓰면 시각만 보충한 답에서 출발·도착이 날아간다. 두 판정이 달라야 하는 이유다.
check('시각+요청동사(완결로는 보이지만 보충이다)', looksLikeRouteRestart('내일 오후 3시에 탁송 예약해주세요'), false);
check('  (참고) 같은 문장을 looksSelfContained는 완결로 본다', looksSelfContained('내일 오후 3시에 탁송 예약해주세요'), true);
check('연락처만 답함', looksLikeRouteRestart('010-1234-5678'), false);
check('짧은 확인', looksLikeRouteRestart('네'), false);
check('출발지만 답함', looksLikeRouteRestart('강남역에서 출발해요'), false);
check('빈 입력', looksLikeRouteRestart(''), false);

console.log('[두 채널 모두 적용됐다]');
// 웹만 고치고 카카오를 빠뜨리면 카카오 고객만 계속 섞인 접수를 받는다(예전에 실제로 그랬다 —
// "되묻기 만료 안내"를 카카오에만 먼저 넣었다가 웹에도 같은 문제가 있는 걸 뒤늦게 알았다).
const web = read('lib/webIntakeTurn.js');
const kakao = read('routes/kakaoConsult.js');
check('웹 — 갈아타기면 이어붙이지 않는다',
  /const mergedRaw = \(pending && pending\.raw && !restarting\)/.test(web), true);
check('카카오 — 갈아타기면 이어붙이지 않는다',
  /mergedRaw = restarting \? text : \(pending\.raw \+ '\\n' \+ text\)/.test(kakao), true);
// 조용히 버리면 "아까 말한 건 어디 갔냐"가 된다.
check('웹 — 갈아탄 사실을 알린다', /restartNotice/.test(web), true);
check('카카오 — 갈아탄 사실을 알린다', /restartNotice/.test(kakao), true);
check('안내 문구가 한 곳에 있다', /INTAKE_RESTARTED_NOTICE/.test(read('lib/intakeSlotState.js')), true);

console.log('[갈아탔는데 못 읽으면 옛 내용을 남기지 않는다]');
// 분류기 한계: "아니요 사당역에서 서초동으로 바꿔주세요"는 unsupported로 읽힌다("바꿔주세요"에
// 접수 동사가 없다 — 같은 문장을 "탁송해주세요"로 바꾸면 정상 인식된다). 여기서 그냥 넘기면
// 되묻기 상태에 옛 경로가 그대로 남아, 고객은 바꿨다고 아는데 다음 답변이 옛 경로에 붙는다.
// 섞이는 것보다 나쁘다 — 지우고 다시 받아야 한다.
check('웹 — 못 읽으면 되묻기 상태를 지운다',
  /if \(restarting\) \{\s*await clearPendingIntake\(session\);/.test(web), true);
check('카카오 — 못 읽으면 되묻기 상태를 지운다',
  /if \(restarting\) \{\s*await clearPendingIntake\(session\);/.test(kakao), true);
check('웹 — 다시 알려달라고 안내한다', /앞서 진행하던 접수는 취소했습니다/.test(web), true);
check('카카오 — 다시 알려달라고 안내한다', /앞서 진행하던 접수는 취소했습니다/.test(kakao), true);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
