// 확인 단계에서 온 "고쳐주세요"를 **바뀐 항목만** 뽑아 적용한다.
//
// 왜 필요한가(2026-09-08 실사용): 확인 화면에서 고객이 "예약일을 2026년 9월 8일 18:30분
// 도착으로 변경해줘"라고 했는데, 예약일은 2027-07-27 그대로였고 **그 문장 자체가 도착지 칸에
// 들어갔다.** 주소 줄에는 앞선 지시문이 ` / `로 덧붙기까지 했다.
//
// 원인은 병합 방식이다. 확인 대기 중에 "네"도 "아니오"도 아닌 답이 오면 그 발화를 원문 뒤에
// 이어붙여 통째로 다시 파싱했다:
//
//     const mergedRaw = `${pending.raw}\n${raw}`;
//
// 이 방식은 **보충**에는 맞다 — "그리고 차량은 12가1234요"가 오면 앞서 받은 출발·도착이
// 사라지지 않는다. 그런데 **정정**에는 구조적으로 안 맞는다:
//
//   · 파서에게도 모델에게도 "이건 지시문이다"라는 신호가 없다 → 값으로 흡수된다.
//   · 나중 값이 앞 값을 덮는 규칙이 없다 → 먼저 나온 날짜가 그대로 이긴다.
//
// 그래서 이어붙이지 않는다. **지금 확정된 슬롯 + 이번 발화**를 같이 주고 "바꿀 항목만
// 돌려줘"라고 시킨다. 값이 아니라 델타를 받는 것이다. 안 바꾸는 칸은 null로 오고, 우리는
// null이 아닌 것만 덮어쓴다.
//
// 확인 대기 상태에서만 도는 경로라 다른 흐름(되묻기 보충, 갈아타기)에는 영향이 없다.
const { generateJson } = require('./vertexAi');

// 바꿀 수 있는 칸만 연다. 여기 없는 것(경유지, 왕복 여부 같은 것)은 이 경로로 못 바꾼다 —
// 그런 요청은 아래 isCorrection=false로 떨어져 기존 이어붙이기 경로가 받는다.
const DELTA_SCHEMA = {
  type: 'object',
  properties: {
    isCorrection: { type: 'boolean' },
    reservedDate: { type: 'string', nullable: true },
    reservedTime: { type: 'string', nullable: true },
    originAddress: { type: 'string', nullable: true },
    originAddressDetail: { type: 'string', nullable: true },
    originContact: { type: 'string', nullable: true },
    destinationAddress: { type: 'string', nullable: true },
    destinationAddressDetail: { type: 'string', nullable: true },
    destinationContact: { type: 'string', nullable: true },
    vehicleNumber: { type: 'string', nullable: true },
    vehicleType: { type: 'string', nullable: true },
    memo: { type: 'string', nullable: true },
  },
  required: ['isCorrection'],
};

const SYSTEM = [
  '너는 탁송 접수 내용을 고치는 일만 한다.',
  '지금 확정된 접수 내용과 고객의 마지막 말을 준다.',
  '',
  '고객의 말에서 **바꾸라고 한 항목만** 채워라. 나머지는 전부 null로 둬라.',
  '지시하는 문장("~로 변경해줘", "~로 바꿔주세요")을 값으로 넣지 마라 — 바뀔 값만 넣어라.',
  '',
  '예) 확정 내용의 예약일시가 2027-07-27 18:30이고 고객이 "예약일을 2026년 9월 8일',
  '18:30 도착으로 변경해줘"라고 하면 → reservedDate="2026-09-08", reservedTime="18:30",',
  '나머지 전부 null. 도착지 주소는 건드리지 않는다.',
  '',
  '날짜는 YYYY-MM-DD, 시각은 HH:MM 24시간제로 준다.',
  '연도를 말하지 않았으면 확정 내용의 연도를 쓰지 말고, 오늘 기준으로 가장 가까운 미래로 본다.',
  '',
  '고객의 말이 접수 내용을 고치는 것이 아니면(질문, 취소, 새 접수, 무슨 말인지 모르겠는 경우)',
  'isCorrection=false로 두고 나머지는 전부 null로 둬라. 억지로 채우지 마라.',
].join('\n');

// 모델에 보여줄 현재 상태. 화면에 나가는 요약과 같은 순서로 적어 "무엇을 고치는지"가 분명하게 한다.
function describeParsed(parsed) {
  const v = (parsed.vehicles || [])[0] || {};
  const when = parsed.when || {};
  const lines = [
    `예약일시: ${when.immediate ? '즉시' : [when.date, when.time].filter(Boolean).join(' ') || '(없음)'}`,
    `차량: ${[v.type, v.plate].filter(Boolean).join(' ') || '(없음)'}`,
    `출발지: ${[parsed.origin && parsed.origin.address, parsed.origin && parsed.origin.addressDetail].filter(Boolean).join(' ') || '(없음)'}`,
    `출발지 연락처: ${(parsed.origin && parsed.origin.contact) || '(없음)'}`,
    `도착지: ${[parsed.destination && parsed.destination.address, parsed.destination && parsed.destination.addressDetail].filter(Boolean).join(' ') || '(없음)'}`,
    `도착지 연락처: ${(parsed.destination && parsed.destination.contact) || '(없음)'}`,
    `요청사항: ${parsed.memo || '(없음)'}`,
  ];
  return lines.join('\n');
}

const trim = (v) => {
  const s = String(v === null || v === undefined ? '' : v).trim();
  return s && s !== 'null' ? s : null;
};

// 델타를 parsed 복사본에 얹는다. **null인 칸은 건드리지 않는다** — null은 "안 바꾼다"는 뜻이지
// "비운다"가 아니다. 비우는 요청은 이 경로로 처리하지 않는다(그런 요청 자체가 거의 없고,
// 잘못 비우면 고객이 적어둔 것이 조용히 사라진다).
function mergeDelta(parsed, delta) {
  const next = JSON.parse(JSON.stringify(parsed));
  const changed = [];

  const date = trim(delta.reservedDate);
  const time = trim(delta.reservedTime);
  if (date || time) {
    next.when = { ...(next.when || {}) };
    // 날짜를 새로 받았으면 우리가 연도를 추정했다는 표시는 지운다 — 고객이 직접 말한 값이다.
    if (date) { next.when.date = date; next.when.dateRolled = false; }
    if (time) next.when.time = time;
    next.when.immediate = false;
    next.when.raw = [next.when.date, next.when.time].filter(Boolean).join(' ') || null;
    changed.push('예약일시');
  }

  const sides = [
    ['origin', '출발지', 'originAddress', 'originAddressDetail', 'originContact'],
    ['destination', '도착지', 'destinationAddress', 'destinationAddressDetail', 'destinationContact'],
  ];
  for (const [key, label, aKey, dKey, cKey] of sides) {
    const addr = trim(delta[aKey]);
    const detail = trim(delta[dKey]);
    const contact = trim(delta[cKey]);
    if (!addr && !detail && !contact) continue;
    next[key] = { ...(next[key] || {}) };
    if (addr) {
      next[key].address = addr;
      // 주소를 통째로 바꿨는데 상세주소를 안 줬으면 옛 상세주소는 버린다 — 다른 건물의
      // 호수가 새 주소에 붙어 남는 것이 가장 나쁘다.
      if (!detail) next[key].addressDetail = null;
      changed.push(label);
    }
    if (detail) { next[key].addressDetail = detail; if (!addr) changed.push(`${label} 상세`); }
    if (contact) { next[key].contact = contact; changed.push(`${label} 연락처`); }
  }

  const plate = trim(delta.vehicleNumber);
  const vtype = trim(delta.vehicleType);
  if (plate || vtype) {
    const list = (next.vehicles || []).slice();
    const first = { ...(list[0] || { plate: null, type: null }) };
    if (plate) first.plate = plate;
    if (vtype) first.type = vtype;
    list[0] = first;
    next.vehicles = list;
    changed.push('차량');
  }

  const memo = trim(delta.memo);
  if (memo) { next.memo = memo; changed.push('요청사항'); }

  // 바뀐 뒤 다시 채워졌을 수 있으니 missing을 다시 센다 — 여기서 안 고치면 빈 칸이 남은 채
  // 확인 화면으로 넘어간다.
  const missing = [];
  if (!(next.origin && next.origin.address)) missing.push('origin_address');
  if (!(next.destination && next.destination.address)) missing.push('destination_address');
  if (!(next.vehicles || []).some((x) => x && x.plate)) missing.push('vehicle_number');
  if (!next.when || (!next.when.immediate && !next.when.date && !next.when.time)) missing.push('when');
  next.missing = missing;
  next.complete = missing.length === 0;

  return { parsed: next, changed };
}

// { ok, parsed, changed[] } 또는 { ok: false, reason }
// ok가 false면 호출부는 기존 경로(이어붙여 재파싱)로 넘어가면 된다 — 이 함수는 확실할 때만 손댄다.
async function applyCorrection(parsed, utterance) {
  if (!parsed || !String(utterance || '').trim()) return { ok: false, reason: 'empty' };

  let delta;
  try {
    delta = await generateJson(
      SYSTEM,
      `[지금 확정된 접수 내용]\n${describeParsed(parsed)}\n\n[고객의 마지막 말]\n${utterance}`,
      DELTA_SCHEMA
    );
  } catch (e) {
    // 모델이 안 되면 고치지 않는다. 여기서 억지로 추측하면 엉뚱한 칸이 바뀐다.
    console.error('접수 정정 분석 실패:', e.message);
    return { ok: false, reason: 'model_error' };
  }

  if (!delta || delta.isCorrection === false) return { ok: false, reason: 'not_correction' };

  const merged = mergeDelta(parsed, delta);
  // 바뀐 것이 없으면 정정으로 보지 않는다 — 확인 화면을 똑같이 다시 띄우면 고객은
  // "왜 안 바뀌었지"만 반복한다. 기존 경로가 받아 다르게 처리하게 넘긴다.
  if (!merged.changed.length) return { ok: false, reason: 'no_change' };

  return { ok: true, parsed: merged.parsed, changed: merged.changed };
}

module.exports = { applyCorrection, mergeDelta, describeParsed, DELTA_SCHEMA };
