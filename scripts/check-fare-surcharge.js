// 탁송 특화 할증 + 부대비용(실비) 판정 검사.
//
// DB를 건드리지 않는 순수 계산만 본다 — 요금이 틀리면 그대로 청구액이 틀리는 자리라
// 화면을 열어보기 전에 여기서 걸린다.
require('dotenv').config();

const fs = require('../lib/fareSurcharge');
const vc = require('../lib/vehicleClass');
const input = require('../lib/fareSurchargeInput');

let failures = 0;
function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${label}${ok ? '' : `  (기대 ${e} / 실제 ${a})`}`);
}

console.log('[금액 상·하한]');
check('0은 그대로 0(안 받음)', fs.clampFee(0), 0);
check('하한 미만은 하한으로', fs.clampFee(500), 1000);
check('상한 초과는 상한으로', fs.clampFee(999999), 20000);
check('범위 안은 그대로', fs.clampFee(12000), 12000);
check('하한 1,000 / 상한 20,000', [fs.SURCHARGE_FEE_MIN, fs.SURCHARGE_FEE_MAX], [1000, 20000]);

console.log('\n[오지 판정 범위]');
check('리 (기본)', fs.isRemoteArea({ dong: '부산리' }), true);
check('읍은 기본에서 제외', fs.isRemoteArea({ dong: '화순읍' }), false);
check('면은 기본에서 제외', fs.isRemoteArea({ dong: '음암면' }), false);
check('읍 (리·읍·면)', fs.isRemoteArea({ dong: '화순읍' }, 'ri_eup_myeon'), true);
check('면 (리·읍·면)', fs.isRemoteArea({ dong: '음암면' }, 'ri_eup_myeon'), true);
check('동은 어느 범위에서도 아님', fs.isRemoteArea({ dong: '야탑동' }, 'ri_eup_myeon'), false);
check('주소에서 면 찾기', fs.isRemoteArea({ address: '충남 서산시 음암면 부산은골길 17' }, 'ri_eup_myeon'), true);
check('도로명만 있으면 아님', fs.isRemoteArea({ address: '서울 양천로 53길 30' }, 'ri_eup_myeon'), false);
// "…면"으로 끝나는 낱말이 주소 안에 있어도 독립 토큰이 아니면 걸리면 안 된다.
check('낱말 일부는 아님', fs.isRemoteArea({ address: '서울 강남구 도곡동 수면로 1' }, 'ri_eup_myeon'), false);
check('알 수 없는 범위값은 리로', fs.normalizeRemoteScope('없는값'), 'ri');

console.log('\n[야간/조조 시간대]');
const nightExtra = { night_start_hm: '22:00', night_end_hm: '01:00', early_start_hm: '06:00', early_end_hm: '09:00' };
const at = (hm) => fs.nightWindowLabel(nightExtra, fs.minutesOfDay(hm));
check('22:00 야간 시작', at('22:00'), '야간');
check('23:30 야간', at('23:30'), '야간');
check('00:30 자정 넘어도 야간', at('00:30'), '야간');
check('01:00 야간 끝(미포함)', at('01:00'), null);
check('06:00 조조 시작', at('06:00'), '조조');
check('08:59 조조', at('08:59'), '조조');
check('09:00 조조 끝(미포함)', at('09:00'), null);
check('15:00 해당 없음', at('15:00'), null);
// 문자열은 KST 벽시계로 읽어야 한다 — Date로 파싱하면 9시간 밀려 야간 판정이 뒤집힌다.
check('날짜가 붙어도 시각만 본다', fs.minutesOfDay('2026-08-28 23:30'), 23 * 60 + 30);
check('시각이 없으면 null', fs.minutesOfDay('2026-08-28'), null);

console.log('\n[할증 합산]');
const extra = {
  imported_car_fee: 10000, large_car_fee: 8000, ev_fee: 5000, night_fee: 5000,
  remote_area_fee: 12000, remote_area_scope: 'ri', document_fee: 10000, predelivery_wash_fee: 5000,
  ...nightExtra,
};
const sum = (opts) => fs.computeSurcharges(extra, opts).total;
check('수입차만', sum({ vehicle: { isImported: true } }), 10000);
check('수입차+전기차', sum({ vehicle: { isImported: true, isEv: true } }), 15000);
check('대형+야간', sum({ vehicle: { isLarge: true }, reservedAt: '23:00' }), 13000);
check('오지는 한쪽만 걸려도 붙는다', sum({ originDong: '부산리' }), 12000);
check('양쪽 다 오지여도 한 번만', sum({ originDong: '부산리', destinationDong: '고북리' }), 12000);
check('홈서비스 옵션', sum({ options: { documents: true, predeliveryWash: true } }), 15000);
check('아무것도 해당 없으면 0', sum({ vehicle: {}, destinationDong: '야탑동' }), 0);
check('금액이 0인 할증은 안 붙는다', fs.computeSurcharges({ ev_fee: 0 }, { vehicle: { isEv: true } }).total, 0);

console.log('\n[목적지 장소 할증]');
const placeRules = [{ keyword: '유원지', fee: 3000 }, { keyword: '전망대', fee: 7000 }];
const place = (address) => fs.computeSurcharges({}, { destinationAddress: address, placeRules }).items;
check('안 걸리면 없음', place('서울 강남구 테헤란로 1').length, 0);
// 금액이 없는 설정에서는 붙지 않는다(위 extra에는 place 금액이 규칙에 직접 들어 있다).
check('걸리면 하나', place('경기 가평군 유원지길 1').length, 1);
check('여러 개 걸리면 가장 비싼 것 하나만',
  fs.computeSurcharges({}, { destinationAddress: '유원지 전망대 앞', placeRules }).total, 7000);

console.log('\n[부대비용 포함/제외]');
check('기본값(단가표) — 톨게이트만 포함', fs.billableChargeTypes({}),
  ['특수구간통행료', '주차요금', '주유비', '세차비']);
check('전부 포함이면 청구 항목 없음', fs.billableChargeTypes({
  toll_normal_included: 1, toll_special_included: 1, parking_included: 1, fuel_included: 1, wash_included: 1,
}), []);
check('일반 통행료를 제외로 두면 청구 가능', fs.billableChargeTypes({ toll_normal_included: 0 }).includes('톨게이트'), true);

console.log('\n[특수 구간 자동 인식]');
const tolls = [{ name: '인천대교', fee: 6200 }, { name: '거가대교', fee: 10000 }];
check('제외 설정이면 걸린 구간을 잡는다',
  fs.matchSpecialTolls({ toll_special_included: 0 }, tolls, ['서울 강서구', '인천대교 지나 영종도']).map((t) => t.name),
  ['인천대교']);
check('포함 설정이면 잡지 않는다(이미 기본요금에 있음)',
  fs.matchSpecialTolls({ toll_special_included: 1 }, tolls, ['인천대교 지나 영종도']), []);
check('안 걸리면 없음', fs.matchSpecialTolls({ toll_special_included: 0 }, tolls, ['서울 강남구']), []);

console.log('\n[차종 자동 판정]');
const cls = (n) => { const r = vc.classifyVehicleModel(n); return [r.isImported, r.isLarge, r.isEv]; };
check('BMW 520d → 수입', cls('BMW 520d'), [true, false, false]);
check('벤츠 EQS → 수입+전기', cls('벤츠 EQS'), [true, false, true]);
check('아이오닉5 → 전기', cls('아이오닉5'), [false, false, true]);
check('Chevrolet Bolt EV → 전기(국산 브랜드)', cls('Chevrolet Bolt EV'), [false, false, true]);
check('카니발 → 대형', cls('카니발'), [false, true, false]);
check('봉고3 1톤 → 대형', cls('봉고3 1톤'), [false, true, false]);
check('아반떼 → 해당 없음', cls('아반떼'), [false, false, false]);
// 'ev'가 낱말 안에 박힌 이름을 전기차로 잡으면 안 된다.
check('Maserati Levante → 수입만', cls('Maserati Levante'), [true, false, false]);
check('르노삼성 SM6 → 국산', cls('르노삼성 SM6'), [false, false, false]);
check('르노 조에 → 수입+전기', cls('르노 조에'), [true, false, true]);

// 브랜드를 안 적고 모델명만 넣는 경우(접수 화면은 자유 입력이라 흔하다).
console.log('\n[브랜드 없는 수입 모델명]');
['캠리', '어코드', '머스탱', '티구안', '골프', '파사트', '익스플로러', '랭글러', '모델3', 'XC60']
  .forEach((n) => check(`${n} → 수입`, cls(n)[0], true));

// 위 사전이 국산차를 수입으로 만들면 그쪽이 훨씬 나쁘다(물량이 많고, 더 받는 방향으로 틀린다).
console.log('\n[국산차가 수입으로 넘어가지 않는다]');
['그랜저', '쏘렌토', '토레스', '싼타페', '아반떼', '기아 카니발', '현대 스타리아', '제네시스 G80']
  .forEach((n) => check(`${n} → 수입 아님`, cls(n)[0], false));

// 선박요금표가 대형/픽업 급으로 분류하는 차들. 실제 접수 데이터에 "액티언스포츠"가 있었다.
console.log('\n[픽업 계열은 대형]');
['액티언스포츠', '코란도스포츠', '무쏘칸'].forEach((n) => check(`${n} → 대형`, cls(n)[1], true));

console.log('\n[입력 검증]');
check('범위 밖 금액은 막는다', !!input.findBadFee({ imported_car_fee: 500 }), true);
check('상한 초과도 막는다', !!input.findBadFee({ ev_fee: 30000 }), true);
check('0은 통과', input.findBadFee({ ev_fee: 0 }), null);
check('낱말이 빈 줄의 금액은 따지지 않는다',
  input.findBadFee({ place_keyword: [''], place_fee: [500] }), null);
check('낱말이 있으면 금액도 검사', !!input.findBadFee({ place_keyword: ['유원지'], place_fee: [500] }), true);
check('시각 형식이 어긋나면 기본값', input.normalizeHm('25시', '22:00'), '22:00');
check('시각 형식이 맞으면 그대로', input.normalizeHm('23:30', '22:00'), '23:30');
// 같은 낱말을 두 번 넣으면 판정이 중복되니 하나만 남는다.
check('중복 낱말은 하나만',
  input.parseRows({ place_keyword: ['유원지', '유원지'], place_fee: [3000, 5000] }, 'place_keyword', 'place_fee').length, 1);
check('먼저 넣은 줄의 금액이 남는다',
  input.parseRows({ place_keyword: ['유원지', '유원지'], place_fee: [3000, 5000] }, 'place_keyword', 'place_fee')[0].fee, 3000);
check('빈 낱말 줄은 버린다',
  input.parseRows({ place_keyword: ['', '유원지'], place_fee: [1000, 3000] }, 'place_keyword', 'place_fee').length, 1);
check('특수 구간도 같은 규칙',
  input.parseRows({ toll_name: ['인천대교', ''], toll_fee: [6200, 0] }, 'toll_name', 'toll_fee').length, 1);

console.log(failures ? `\n${failures}건 실패` : '\n모두 통과');
process.exit(failures ? 1 : 0);
