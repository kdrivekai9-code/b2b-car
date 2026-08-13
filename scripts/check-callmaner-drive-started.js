#!/usr/bin/env node
// 콜마너 운행시작 판정 검사 — DB/네트워크 없이 순수 로직만 본다.
//
// 왜 필요한가: 콜마너는 기사가 출발한 뒤에도 계속 status='배차'를 주고, 출발 여부는
// baecha_status(2=운행시작)로만 구분된다. 그래서 baecha_status를 못 받은 주기에 매핑을
// 그대로 적용하면 상태가 운행시작 → 기사배정으로 되돌아가고, 그 전이를 읽는 능동 통보가
// "배차되었습니다"를 매분 고객에게 다시 보낸다. 그 되돌림 가드가 이 파일의 핵심 검사다.
//
// 사용법: node scripts/check-callmaner-drive-started.js
const assert = require('assert');
const { resolveLocalStatus, isBackwardTransition } = require('../routes/callmanerSync');

let failures = 0;
function check(name, actual, expected) {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log('  PASS', name);
  } catch (e) {
    failures += 1;
    console.log('  FAIL', name, '— 기대:', JSON.stringify(expected), '실제:', JSON.stringify(actual));
  }
}

console.log('[상태 매핑]');
check('배차 + baecha 2 → 운행시작', resolveLocalStatus({ status: '배차', baechaStatus: '2' }), '운행시작');
check('배차 + baecha 1(기사도착) → 기사배정', resolveLocalStatus({ status: '배차', baechaStatus: '1' }), '기사배정');
check('배차 + baecha 0 → 기사배정', resolveLocalStatus({ status: '배차', baechaStatus: '0' }), '기사배정');
check('배차 + baecha 없음 → 기사배정', resolveLocalStatus({ status: '배차' }), '기사배정');
check('배차 + baecha 빈문자 → 기사배정', resolveLocalStatus({ status: '배차', baechaStatus: '' }), '기사배정');
// baecha_status는 배차 상태에서만 의미가 있다 — 완료 건에 2가 남아 있어도 완료가 이긴다.
check('완료 + baecha 2 → 완료', resolveLocalStatus({ status: '완료', baechaStatus: '2' }), '완료');
check('접수 → 접수', resolveLocalStatus({ status: '접수' }), '접수');
check('취소 → 취소', resolveLocalStatus({ status: '취소' }), '취소');
check('매핑 없는 상태 → undefined', resolveLocalStatus({ status: '타사배차' }), undefined);

console.log('[되돌림 가드]');
check('운행시작 → 기사배정은 되돌림', isBackwardTransition('운행시작', '기사배정'), true);
check('기사배정 → 운행시작은 정상 진행', isBackwardTransition('기사배정', '운행시작'), false);
check('운행시작 → 완료는 정상 진행', isBackwardTransition('운행시작', '완료'), false);
check('운행시작 → 취소는 정상 진행', isBackwardTransition('운행시작', '취소'), false);
check('운행시작 → 운행시작(무변화)은 되돌림 아님', isBackwardTransition('운행시작', '운행시작'), false);
check('접수 → 기사배정은 되돌림 아님', isBackwardTransition('접수', '기사배정'), false);
// 매핑 실패(undefined)를 되돌림으로 오판하면 안 된다 — 그 경우는 원래 분기가 따로 처리한다.
check('운행시작 → undefined는 되돌림 아님', isBackwardTransition('운행시작', undefined), false);

console.log('[실제 폴링 시나리오]');
// 배차 직후: 기사배정으로 올라간다.
let local = '접수';
let next = resolveLocalStatus({ status: '배차', baechaStatus: '0' });
check('1) 접수 → 기사배정', isBackwardTransition(local, next) ? local : next, '기사배정');
// 기사 출발: 운행시작으로 올라간다.
local = '기사배정';
next = resolveLocalStatus({ status: '배차', baechaStatus: '2' });
check('2) 기사배정 → 운행시작', isBackwardTransition(local, next) ? local : next, '운행시작');
// 다음 주기에 baecha_status를 못 받았다: 운행시작을 유지해야 한다(되돌림 금지).
local = '운행시작';
next = resolveLocalStatus({ status: '배차' });
check('3) 운행시작 유지(baecha 유실)', isBackwardTransition(local, next) ? local : next, '운행시작');
// 완료: 내려간다.
local = '운행시작';
next = resolveLocalStatus({ status: '완료' });
check('4) 운행시작 → 완료', isBackwardTransition(local, next) ? local : next, '완료');

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
