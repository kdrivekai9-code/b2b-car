// 오지요금(추가요금) — 판정과 계산을 확인한다.
//
// 행정지명이 "리"로 끝나는 곳(법정리)은 도심에서 멀고 진입로가 좁아 같은 거리라도 시간이 더
// 걸린다. 거리 기반 구간요금만으로는 그 차이를 담을 수 없어 해당 구간에 정액을 더한다.
//
// 판정은 지오코딩이 준 행정지명(dong)을 우선하고, 그것이 없는 경로(오더 등록 화면의 요금
// 미리보기)에서는 주소 문자열에서 찾는다. 주소에서 찾을 때가 오탐 위험이 크므로 그쪽을 더 본다.
//
// 순수 계산이라 네트워크도 DB도 쓰지 않는다.
//
//   node scripts/check-remote-area-fee.js
const {
  isRemoteArea, remoteAreaFeeFor, REMOTE_AREA_FEE_MIN, REMOTE_AREA_FEE_MAX,
} = require('../lib/branchPolicy');

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : '실패'} ${label}${ok ? '' : `  (기대 ${JSON.stringify(expected)}, 실제 ${JSON.stringify(actual)})`}`);
}

console.log('[행정지명(dong)으로 판정 — 가장 확실한 신호]');
check('부산리', isRemoteArea({ dong: '부산리' }), true);
check('음암면 소속 리', isRemoteArea({ dong: '고북리' }), true);
check('야탑동', isRemoteArea({ dong: '야탑동' }), false);
check('수서동', isRemoteArea({ dong: '수서동' }), false);
// 행정지명을 알면 주소는 보지 않는다 — 도로명에 우연히 "리"가 들어가도 흔들리지 않는다.
check('행정지명이 동이면 주소를 보지 않는다', isRemoteArea({ dong: '갈매동', address: '경기 구리시 갈매동 12' }), false);

console.log('\n[주소로 판정 — 행정지명을 모르는 경로]');
check('괄호 안 법정리', isRemoteArea({ address: '충남 서산시 음암면 부산은골길17(부산리)' }), true);
check('띄어쓴 법정리', isRemoteArea({ address: '전남 화순군 화순읍 광덕리 123' }), true);
check('도로명만', isRemoteArea({ address: '서울 양천로 53길 30' }), false);
check('일반 동 주소', isRemoteArea({ address: '경기 성남시 분당구 야탑동 1' }), false);
// "구리시"는 시 이름이지 법정리가 아니다 — 낱말 전체가 "…리"여야 잡는다.
check('구리시', isRemoteArea({ address: '경기 구리시 갈매동 12' }), false);
check('빈 값', isRemoteArea({}), false);
check('null', isRemoteArea(null), false);

console.log('\n[구간에 붙이는 금액]');
const extra = { remote_area_fee: 3000 };
check('출발지가 오지', remoteAreaFeeFor(extra, { originDong: '부산리', destinationDong: '야탑동' }), 3000);
check('도착지가 오지', remoteAreaFeeFor(extra, { originDong: '야탑동', destinationDong: '부산리' }), 3000);
// 오지요금은 "그 구간을 운행하는 부담"에 대한 값이지 지점마다 세는 값이 아니다.
check('양쪽 다 오지여도 한 번만', remoteAreaFeeFor(extra, { originDong: '부산리', destinationDong: '고북리' }), 3000);
check('둘 다 아니면 0', remoteAreaFeeFor(extra, { originDong: '야탑동', destinationDong: '수서동' }), 0);

console.log('\n[설정하지 않았으면 붙지 않는다]');
check('0이면 0', remoteAreaFeeFor({ remote_area_fee: 0 }, { originDong: '부산리' }), 0);
check('컬럼이 없으면(마이그레이션 전) 0', remoteAreaFeeFor({}, { originDong: '부산리' }), 0);
check('설정 자체가 없으면 0', remoteAreaFeeFor(null, { originDong: '부산리' }), 0);

console.log('\n[범위를 벗어난 값은 계산 쪽에서도 가둔다]');
// 화면에서 막지만 API로 들어올 수 있다 — 관리자가 넣은 적 없는 금액이 청구되면 안 된다.
check('하한 미만', remoteAreaFeeFor({ remote_area_fee: 500 }, { originDong: '부산리' }), REMOTE_AREA_FEE_MIN);
check('상한 초과', remoteAreaFeeFor({ remote_area_fee: 999999 }, { originDong: '부산리' }), REMOTE_AREA_FEE_MAX);
check('하한 그대로', remoteAreaFeeFor({ remote_area_fee: REMOTE_AREA_FEE_MIN }, { originDong: '부산리' }), REMOTE_AREA_FEE_MIN);
check('상한 그대로', remoteAreaFeeFor({ remote_area_fee: REMOTE_AREA_FEE_MAX }, { originDong: '부산리' }), REMOTE_AREA_FEE_MAX);

console.log('\n[상·하한]');
check('하한 1,000원', REMOTE_AREA_FEE_MIN, 1000);
// 상한은 20260828 작업에서 10,000 → 20,000으로 넓혔다(할증 전 항목 공통, 사용자 확정).
check('상한 20,000원', REMOTE_AREA_FEE_MAX, 20000);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
