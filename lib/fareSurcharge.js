// 탁송 특화 할증 + 부대비용(실비) 판정.
//
// 구간요금(거리)으로는 담기지 않는 부담을 정액으로 더한다. 판정 근거를 항목마다 함께 돌려주는
// 이유: 요금이 왜 이렇게 나왔는지 화면·고객 안내가 밝힐 수 있어야 하고, 안 그러면 "왜 3만원이
// 나왔냐"는 문의를 사람이 매번 역산해야 한다.

// 할증 금액 상·하한(사용자 확정). 0은 "그 할증 안 받음"이다.
const SURCHARGE_FEE_MIN = 1000;
const SURCHARGE_FEE_MAX = 20000;

function clampFee(raw) {
  const fee = Number(raw) || 0;
  if (fee <= 0) return 0;
  // 화면에서 막지만 API로 들어온 값이 범위를 벗어날 수 있다 — 계산 쪽에서도 가둔다.
  return Math.min(SURCHARGE_FEE_MAX, Math.max(SURCHARGE_FEE_MIN, Math.round(fee)));
}

// ── 오지 판정 ───────────────────────────────────────────────────────────────
// 'ri' = 법정리만 / 'ri_eup_myeon' = 리·읍·면.
//
// 낱말 하나가 통째로 "…리/읍/면"이어야 한다. 도로명은 로/길로, 행정동은 동으로 끝나므로
// 독립된 토큰으로 나오는 리·읍·면은 사실상 행정지명이다. 괄호가 흔한 경계라 함께 본다
// ("음암면 부산은골길17(부산리)").
const REMOTE_SCOPES = {
  ri: { suffix: /리$/, address: /(?:^|[\s(,])([가-힣]{1,6}리)(?=[\s),]|$)/, label: '리' },
  ri_eup_myeon: {
    suffix: /[리읍면]$/,
    address: /(?:^|[\s(,])([가-힣]{1,6}[리읍면])(?=[\s),]|$)/,
    label: '리·읍·면',
  },
};

function normalizeRemoteScope(raw) {
  const v = String(raw || '').trim();
  return REMOTE_SCOPES[v] ? v : 'ri';
}

function isRemoteArea(place, scope) {
  const rule = REMOTE_SCOPES[normalizeRemoteScope(scope)];
  const p = place || {};
  // 지오코딩이 준 행정지명을 우선한다 — "충남 서산시 음암면 부산리"에서 dong이 "부산리"로 온다.
  const dong = String(p.dong || '').trim();
  if (dong) return rule.suffix.test(dong);
  const address = String(p.address || '').trim();
  if (!address) return false;
  return rule.address.test(address);
}

// ── 시간대(야간/조조) 판정 ──────────────────────────────────────────────────
// 22:00~01:00처럼 자정을 넘는 구간이 있어 시작 > 종료인 경우를 정상으로 다룬다.
function parseHm(raw, fallback) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw || '').trim());
  if (!m) return fallback;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return fallback;
  return h * 60 + min;
}

function inWindow(minutes, startMin, endMin) {
  if (startMin === endMin) return false;
  if (startMin < endMin) return minutes >= startMin && minutes < endMin;
  return minutes >= startMin || minutes < endMin; // 자정을 넘는 구간
}

// 예약시각에서 "분"만 뽑는다. 'YYYY-MM-DD HH:mm', ISO 문자열, Date 모두 받는다.
function minutesOfDay(reservedAt) {
  if (!reservedAt) return null;
  if (reservedAt instanceof Date) {
    if (Number.isNaN(reservedAt.getTime())) return null;
    return reservedAt.getHours() * 60 + reservedAt.getMinutes();
  }
  const s = String(reservedAt).trim();
  // 문자열은 KST 벽시계로 본다 — Date로 파싱하면 'Z'가 붙은 값이 9시간 밀려 야간 판정이 뒤집힌다.
  const m = /(\d{1,2}):(\d{2})/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function nightWindowLabel(extra, minutes) {
  const nightStart = parseHm(extra && extra.night_start_hm, 22 * 60);
  const nightEnd = parseHm(extra && extra.night_end_hm, 1 * 60);
  const earlyStart = parseHm(extra && extra.early_start_hm, 6 * 60);
  const earlyEnd = parseHm(extra && extra.early_end_hm, 9 * 60);
  if (inWindow(minutes, nightStart, nightEnd)) return '야간';
  if (inWindow(minutes, earlyStart, earlyEnd)) return '조조';
  return null;
}

// ── 부대비용(실비) 항목 ─────────────────────────────────────────────────────
// settingKey가 1이면 기본요금에 포함 = 청구 불가. 0이면 제외 = 실비 정산 항목으로 청구한다.
// chargeType은 order_extra_charges.charge_type에 그대로 들어가는 문자열이다(lib/extraCharges.js와 같아야 한다).
const EXTRA_COST_ITEMS = [
  { code: 'toll_normal', label: '일반 고속도로 통행료', settingKey: 'toll_normal_included', modeKey: 'toll_normal_mode', chargeType: '톨게이트', defaultIncluded: 1 },
  { code: 'toll_special', label: '특수 구간 통행료', settingKey: 'toll_special_included', modeKey: 'toll_special_mode', chargeType: '특수구간통행료', defaultIncluded: 0 },
  { code: 'parking', label: '주차비', settingKey: 'parking_included', modeKey: 'parking_mode', chargeType: '주차요금', defaultIncluded: 0 },
  { code: 'fuel', label: '주유비', settingKey: 'fuel_included', modeKey: 'fuel_mode', chargeType: '주유비', defaultIncluded: 0 },
  { code: 'wash', label: '세차비', settingKey: 'wash_included', modeKey: 'wash_mode', chargeType: '세차비', defaultIncluded: 0 },
  // 도선료는 지금까지 orders.ferry_fare_amount로 따로 다뤘는데, 정산서에서는 기타 정산으로
  // 보여준다(사용자 지시). 금액 출처는 그대로 두고 분류만 여기 둔다 — 데이터를 옮기면 기존
  // 오더를 모두 손봐야 하고 되돌리기 어렵다.
  { code: 'ferry', label: '도선료', settingKey: null, modeKey: 'ferry_mode', chargeType: '도선료', defaultIncluded: 0 },
];

// 정산 방식 3단계(사용자 지시).
//   included    기본요금 포함 — 따로 청구하지 않는다
//   monthly     제외 · 실비 월정산 — 월 정산서에 모아 청구
//   individual  제외 · 실비 개별정산 — 건별로 따로 청구
const EXTRA_COST_MODES = [
  { value: 'included', label: '포함(청구 불가)' },
  { value: 'monthly', label: '제외 · 실비 월정산' },
  { value: 'individual', label: '제외 · 실비 개별정산' },
];

// 새 컬럼(*_mode)이 비면 옛 컬럼(*_included 0/1)에서 읽는다 — 마이그레이션만으로 동작이
// 바뀌면 안 된다. 0(제외)은 월정산으로 본다: 지금까지 월 정산서에 모아 청구해 왔다.
function extraCostMode(extra, item) {
  const raw = extra && item.modeKey ? extra[item.modeKey] : null;
  const v = String(raw || '').trim();
  if (EXTRA_COST_MODES.some((m) => m.value === v)) return v;
  return isIncludedLegacy(extra, item) ? 'included' : 'monthly';
}

function isIncludedLegacy(extra, item) {
  if (!item.settingKey) return !!item.defaultIncluded;
  const raw = extra ? extra[item.settingKey] : undefined;
  if (raw === undefined || raw === null || raw === '') return !!item.defaultIncluded;
  return Number(raw) === 1;
}

// "기본요금에 포함되는가" — 포함이면 실비로 따로 청구하지 않는다.
// 월정산·개별정산은 둘 다 "제외"라 청구 대상이다(청구 시점만 다르다).
function isIncluded(extra, item) {
  return extraCostMode(extra, item) === 'included';
}

// 실비로 청구할 수 있는 항목(= "제외"로 설정된 것)만 추린다. 정산 입력 화면이 이 목록으로
// 선택지를 만든다 — 포함으로 설정한 항목이 정산서에 올라가면 이중 청구가 된다.
// 실비로 청구할 수 있는 항목(= "제외"로 설정된 것)만 추린다. 정산 입력 화면이 이 목록으로
// 선택지를 만든다 — 포함으로 설정한 항목이 정산서에 올라가면 이중 청구가 된다.
//
// 도선료는 뺀다. 금액이 orders.ferry_fare_amount에서 오므로 손으로 또 넣으면 두 번 청구된다
// (정산서에는 기타 정산으로 보이지만 출처가 다르다).
function billableChargeTypes(extra) {
  return EXTRA_COST_ITEMS
    .filter((it) => it.code !== 'ferry' && !isIncluded(extra, it))
    .map((it) => it.chargeType);
}

function extraCostStates(extra) {
  return EXTRA_COST_ITEMS.map((it) => {
    const mode = extraCostMode(extra, it);
    return { ...it, mode, included: mode === 'included' };
  });
}

// 이 항목을 어떻게 청구하는가 — 정산 화면이 월/개별을 구분해 보여줄 때 쓴다.
function settleModeOf(extra, chargeType) {
  const item = EXTRA_COST_ITEMS.find((it) => it.chargeType === chargeType);
  if (!item) return 'monthly';
  const mode = extraCostMode(extra, item);
  return mode === 'included' ? 'included' : mode;
}


// ── 특수 구간 이름 프리셋 ───────────────────────────────────────────────────
// 금액은 넣지 않는다(이름만).
//
// 왜 금액을 안 넣나: 통행료는 차종·시간대·할인에 따라 갈리고 인상도 된다. 확인하지 못한 값을
// 기본값으로 심으면 그대로 청구된다 — 비어 있는 것보다 나쁘다. 금액은 관리자가 계약·영수증
// 기준으로 넣는다.
//
// 그럼 이름만으로 무슨 쓸모가 있나: 판정이 **이름 부분일치**라서 표기가 조금만 달라도 안 걸린다.
// 실측에서 카카오는 "영종대교휴게소"처럼 뒤에 말을 붙여 주므로 등록명은 "영종대교"여야 걸리고,
// "영종 대교"처럼 띄면 안 걸린다. 목록에서 고르면 그 오차가 사라진다.
//
// 여기 있다고 반드시 유료이거나 청구 대상인 것은 아니다 — 어디를 등록할지는 계약이 정한다.
const SPECIAL_TOLL_PRESETS = [
  {
    group: '수도권',
    names: ['인천대교', '영종대교', '일산대교', '서해대교', '미사대교', '제3경인고속화도로'],
  },
  {
    group: '부산 · 경남',
    names: ['거가대교', '광안대교', '부산항대교', '을숙도대교', '남항대교', '천마산터널',
      '백양터널', '수정산터널', '마창대교', '불암터널'],
  },
  {
    group: '서울 도심 유료도로',
    names: ['우면산터널', '용마터널', '북부간선도로', '강남순환로'],
  },
  {
    group: '기타',
    names: ['천사대교', '팔영대교', '보령해저터널', '인천북항터널'],
  },
];

// 화면 datalist용 평탄화 목록.
function specialTollPresetNames() {
  return SPECIAL_TOLL_PRESETS.reduce((all, g) => all.concat(g.names), []);
}

// ── 특수 구간 통행료 자동 인식 ──────────────────────────────────────────────
// 등록된 민자 교량/구간 이름이 경로 설명이나 출·도착 주소에 나오면 실비 항목을 만들어 둔다.
// "제외"로 설정된 경우에만 붙인다 — 포함이면 이미 기본요금에 들어 있다.
// texts에는 출발·도착 주소뿐 아니라 **경로가 지나간 요금소 이름**도 넣어 부른다
// (lib/routeFareSearch.js tollgates). 주소만 보면 경로 중간의 교량·유료도로는 잡히지 않는다 —
// 서해대교를 지나는 사당역→당진 경로에서 주소 어디에도 "서해대교"가 없다.
function matchSpecialTolls(extra, tollRules, texts) {
  const item = EXTRA_COST_ITEMS.find((it) => it.code === 'toll_special');
  if (isIncluded(extra, item)) return [];
  const haystack = (texts || []).flat().filter(Boolean).join(' ');
  if (!haystack) return [];
  return (tollRules || [])
    .filter((r) => r && String(r.name || '').trim() && haystack.includes(String(r.name).trim()))
    .map((r) => ({
      code: 'toll_special',
      chargeType: item.chargeType,
      name: String(r.name).trim(),
      amount: Math.max(0, Math.round(Number(r.fee) || 0)),
    }));
}


// ── 통행료(TG) 청구액 결정 ──────────────────────────────────────────────────
// 요금설정의 "일반 고속도로 통행료" 포함/제외에 따라 무엇을 청구할지가 갈린다(사용자 확정):
//
//   포함 → **특수교량 금액만** 청구한다.
//          총 통행료를 쓰면 기본요금에 이미 든 일반 통행료까지 다시 받는 셈이다.
//
//   실비 → **총 통행료를 그대로** 청구한다.
//          카카오 총액에는 특수교량 요금이 이미 들어 있다(요금소별로 쪼개주지 않는다).
//          그래서 총액에 특수교량을 또 더하면 그 다리를 두 번 받는다.
//
// 어느 쪽이든 줄은 하나만 만든다 — 두 항목을 같이 넣으면 합계가 실제 낸 돈과 달라진다.
function tollChargeFor(extra, options = {}) {
  const item = EXTRA_COST_ITEMS.find((it) => it.code === 'toll_normal');
  const normalIncluded = isIncluded(extra, item);
  const specialTolls = Array.isArray(options.specialTolls) ? options.specialTolls : [];
  const specialTotal = specialTolls.reduce((sum, t) => sum + (Math.round(Number(t && t.amount)) || 0), 0);
  const totalToll = Math.max(0, Math.round(Number(options.tollFare) || 0));

  if (!normalIncluded) {
    // 총 통행료를 모르면(경로를 못 받은 접수 경로 등) 아는 것만이라도 청구한다 —
    // 0원으로 두면 실비인데 아무것도 안 받는 상태가 조용히 만들어진다.
    if (totalToll > 0) {
      return { chargeType: '톨게이트', amount: totalToll, basis: 'total', note: '경로 총 통행료(카카오)' };
    }
    if (specialTotal > 0) {
      return { chargeType: '특수구간통행료', amount: specialTotal, basis: 'special_fallback',
        note: `총 통행료를 못 받아 특수구간만: ${specialTolls.map((t) => t.name).filter(Boolean).join(', ')}` };
    }
    return null;
  }

  // 포함 — 특수구간만. 특수구간이 "포함"으로 설정돼 있으면 matchSpecialTolls가 애초에
  // 빈 배열을 주므로 여기서 다시 걸러낼 필요가 없다.
  if (specialTotal > 0) {
    return { chargeType: '특수구간통행료', amount: specialTotal, basis: 'special',
      note: specialTolls.map((t) => t.name).filter(Boolean).join(', ') || null };
  }
  return null;
}

// ── 대형/화물 할증 금액 고르기 ──────────────────────────────────────────────
// 차종마다 부담이 달라(RV 카니발 vs 1톤 화물 탑차) 차종별로 금액을 등록할 수 있다.
// 등록된 차종에 해당하면 그 금액을, 없으면 지사/법인의 기본 금액(large_car_fee)을 쓴다.
//
// 기본값으로 떨어뜨리는 이유: 차종별 등록을 안 한 지사에서 대형 할증이 통째로 사라지면
// 설정한 사람은 적용되는 줄 안다. 빠뜨린 차종은 기본 금액이라도 받는 편이 맞다.
//
// 차종별 금액이 0이면 "이 차종은 대형 할증을 안 받는다"는 뜻으로 그대로 존중한다 —
// 기본값으로 되돌리면 0을 넣은 의도를 뒤집는 셈이다.
function largeCarFeeFor(extra, vehicle, largeCarFees) {
  const modelId = vehicle && vehicle.modelId;
  if (modelId && Array.isArray(largeCarFees)) {
    const hit = largeCarFees.find((r) => r && Number(r.vehicle_model_id) === Number(modelId));
    if (hit) {
      const name = vehicle.modelName || '등록 차종';
      return { fee: hit.fee, reason: `${name} 차종별 금액` };
    }
  }
  return { fee: extra && extra.large_car_fee, reason: '대형·화물 차종(기본 금액)' };
}

// ── 할증 합산 ───────────────────────────────────────────────────────────────
function computeSurcharges(extra, options = {}) {
  const items = [];
  const push = (code, label, amount, reason) => {
    const fee = clampFee(amount);
    if (fee > 0) items.push({ code, label, amount: fee, reason });
  };

  const vehicle = options.vehicle || {};
  if (vehicle.isImported) push('imported', '수입차 할증', extra && extra.imported_car_fee, '수입 브랜드');
  if (vehicle.isLarge) {
    const resolved = largeCarFeeFor(extra, vehicle, options.largeCarFees);
    push('large', '대형/화물 할증', resolved.fee, resolved.reason);
  }
  if (vehicle.isEv) push('ev', '전기차 할증', extra && extra.ev_fee, '전기차');

  const minutes = minutesOfDay(options.reservedAt);
  if (minutes != null) {
    const label = nightWindowLabel(extra, minutes);
    if (label) push('night', '야간/조조 할증', extra && extra.night_fee, `${label} 출발`);
  }

  // 오지 — 출발지든 도착지든 한쪽만 해당해도 붙이고, 양쪽 다여도 한 번만 붙인다.
  // 오지요금은 "그 구간을 운행하는 부담"에 대한 값이지 지점마다 세는 값이 아니다.
  const scope = normalizeRemoteScope(extra && extra.remote_area_scope);
  const origin = { dong: options.originDong, address: options.originAddress };
  const destination = { dong: options.destinationDong, address: options.destinationAddress };
  if (isRemoteArea(origin, scope) || isRemoteArea(destination, scope)) {
    push('remote', '오지 지역 할증', extra && extra.remote_area_fee, `${REMOTE_SCOPES[scope].label} 지역`);
  }

  // 목적지 주소에 포함된 장소(예: "유원지"). 여러 개가 걸리면 가장 비싼 것 하나만 붙인다 —
  // 한 목적지를 두고 키워드 수만큼 곱해 받으면 설정한 사람의 의도와 달라진다.
  const destText = String(options.destinationAddress || '').trim();
  if (destText) {
    const hits = (options.placeRules || [])
      .filter((r) => r && String(r.keyword || '').trim() && destText.includes(String(r.keyword).trim()))
      .sort((a, b) => (Number(b.fee) || 0) - (Number(a.fee) || 0));
    if (hits.length) {
      push('place', '목적지 장소 할증', hits[0].fee, `목적지에 "${String(hits[0].keyword).trim()}" 포함`);
    }
  }

  const opt = options.options || {};
  if (opt.documents) push('documents', '서류 회수/전달', extra && extra.document_fee, '홈서비스 옵션');
  if (opt.predeliveryWash) push('predeliveryWash', '인도 전 세차', extra && extra.predelivery_wash_fee, '홈서비스 옵션');

  return { total: items.reduce((s, it) => s + it.amount, 0), items };
}

module.exports = {
  SURCHARGE_FEE_MIN,
  SURCHARGE_FEE_MAX,
  REMOTE_SCOPES,
  EXTRA_COST_ITEMS,
  clampFee,
  normalizeRemoteScope,
  isRemoteArea,
  minutesOfDay,
  nightWindowLabel,
  isIncluded,
  billableChargeTypes,
  extraCostStates,
  matchSpecialTolls,
  SPECIAL_TOLL_PRESETS,
  specialTollPresetNames,
  EXTRA_COST_MODES,
  extraCostMode,
  settleModeOf,
  tollChargeFor,
  largeCarFeeFor,
  computeSurcharges,
};
