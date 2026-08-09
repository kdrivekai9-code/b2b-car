// 접수 하나를 필요할 때만 여러 건으로 나눈다.
//
// 규칙(사용자 확인, 2026-08-09): **기본은 한 건이다.** 경유지가 있다고, 왕복이라고 해서 무조건
// 나누지 않는다 — 그렇게 하면 같은 날 이어서 하는 평범한 경유 운행까지 두 건으로 쪼개져
// 접수·정산·배차가 전부 두 배가 된다.
//
// 나누는 경우는 **수행일이 갈릴 때뿐**이다.
//   경유지: 출발→경유와 경유→도착의 날짜가 다르면 나눈다
//   왕복:   가는 편과 오는 편의 날짜가 다르면 나눈다
// 날짜가 같으면(또는 따로 지정되지 않았으면) 지금처럼 경유지를 그대로 담은 한 건으로 접수한다.
//
// 기사 배정이 구간마다 다를 수 있다는 것과는 다른 얘기다. order_legs(구간 릴레이)는 오더 하나
// 안에서 구간별 기사만 나누는 구조라 이 규칙과 맞지 않는다 — 실제로 쓰이지 않고 있다.
//
// 여기는 순수 변환만 한다. DB도 네트워크도 건드리지 않아서 규칙 자체를 그대로 확인할 수 있다
// (scripts/check-order-split.js).

// 접수 입력 모양(호출부가 이 형태로 맞춰 넘긴다):
// {
//   originAddress, originAddressDetail, originContact,
//   destinationAddress, destinationAddressDetail, destinationContact,
//   waypoints: [{ address, addressDetail, contact, vehicleNumber, reservedDate, reservedTime }],
//   reservedDate, reservedTime,
//   vehicleNumber, vehicleType,
//   roundTrip: bool,
//   returnReservedDate, returnReservedTime,   // 왕복 복귀편 일시(알고 있으면)
//   ...나머지는 그대로 각 건에 복사된다(메모·옵션 등)
// }

function trimmed(v) {
  return String(v == null ? '' : v).trim();
}

// 날짜만 비교한다. 같은 날 안에서 시각이 다른 건 평범한 경유 운행이라 나눌 이유가 없다.
function isDifferentDay(a, b) {
  const left = trimmed(a);
  const right = trimmed(b);
  if (!left || !right) return false; // 한쪽이 없으면 "다른 날"이라고 볼 근거가 없다
  return left !== right;
}

// 나눠야 하는 접수인지, 그렇다면 왜인지. 화면·문구에서 이유를 그대로 쓴다.
//
// 기본은 나누지 않는 것이다. 수행일이 갈리는 경우에만 나눈다 — 날짜가 지정되지 않았으면
// 같은 날 이어서 하는 것으로 본다(대부분의 경유 운행이 그렇다).
function splitReason(intake) {
  const data = intake || {};
  const waypoints = (data.waypoints || []).filter((w) => w && trimmed(w.address));

  if (waypoints.some((w) => isDifferentDay(w.reservedDate, data.reservedDate))) return 'waypoint';
  if (data.roundTrip && isDifferentDay(data.returnReservedDate, data.reservedDate)) return 'round_trip';
  return null;
}

// 정류장 목록 — 출발지 → 경유지들 → 도착지.
function buildStops(intake) {
  const data = intake || {};
  const waypoints = (data.waypoints || []).filter((w) => w && trimmed(w.address));
  return [
    {
      address: data.originAddress,
      addressDetail: data.originAddressDetail,
      contact: data.originContact,
      // 출발 시각은 접수 전체의 예약일시다.
      reservedDate: data.reservedDate,
      reservedTime: data.reservedTime,
    },
    ...waypoints.map((w) => ({
      address: w.address,
      addressDetail: w.addressDetail,
      contact: w.contact,
      vehicleNumber: w.vehicleNumber,
      // 경유지에서 다시 출발하는 시각. 모르면 호출부가 고객에게 물어 채운다.
      reservedDate: w.reservedDate || null,
      reservedTime: w.reservedTime || null,
    })),
    {
      address: data.destinationAddress,
      addressDetail: data.destinationAddressDetail,
      contact: data.destinationContact,
    },
  ];
}

// 정류장 구간(from~to)으로 한 건을 만든다. 사이에 낀 정류장은 경유지로 그대로 남는다 —
// 같은 날 이어서 도는 경유지까지 쪼개면 안 되기 때문이다.
//
// 연락처는 비워둘 수 없다 — 서버(POST /orders)가 필수로 검증해서 비면 등록 자체가 막힌다.
// 경유지 연락처를 안 받은 경우가 흔해서, 없으면 출발지 연락처를 그대로 물려준다.
function buildPart(intake, stops, fromIdx, toIdx, seq) {
  const data = intake || {};
  const from = stops[fromIdx];
  const to = stops[toIdx];
  const middle = stops.slice(fromIdx + 1, toIdx);
  const fallbackContact = trimmed(data.originContact) || trimmed(data.destinationContact);

  return {
    ...data,
    roundTrip: false,

    originAddress: from.address,
    originAddressDetail: from.addressDetail || null,
    originContact: trimmed(from.contact) || fallbackContact,

    destinationAddress: to.address,
    destinationAddressDetail: to.addressDetail || null,
    destinationContact: trimmed(to.contact) || fallbackContact,

    waypoints: middle.map((w) => ({
      address: w.address,
      addressDetail: w.addressDetail || null,
      contact: trimmed(w.contact) || fallbackContact,
      vehicleNumber: w.vehicleNumber || null,
    })),

    // 그 건을 언제 출발하는지. 첫 건은 접수 일시, 나뉜 뒤의 건은 그 정류장에 적힌 일시다.
    // 날짜는 있는데 시각이 없을 수 있다 — 날짜가 갈린 것만으로 나뉘었기 때문이다. 그때는
    // 호출부가 고객에게 묻는다(임의로 앞 건과 같은 시각을 넣으면 잘못된 시각이 접수된다).
    reservedDate: from.day || null,
    reservedTime: from.reservedTime || null,

    // 구간마다 다른 차량을 옮기는 경우가 있어(경유지에 차량번호가 따로 적힌다) 그 값을 우선한다.
    vehicleNumber: trimmed(from.vehicleNumber) || data.vehicleNumber || null,

    splitSeq: seq,
  };
}

// 정류장마다 "여기서 출발하는 날짜"를 정한다. 따로 적히지 않았으면 직전 구간과 같은 날이다 —
// 그래야 날짜가 실제로 갈리는 지점에서만 끊긴다.
function assignDays(stops, baseDate) {
  let current = trimmed(baseDate) || null;
  return stops.map((stop, i) => {
    if (i === stops.length - 1) return { ...stop, day: null }; // 마지막 정류장에서는 출발하지 않는다
    const day = trimmed(stop.reservedDate) || current;
    current = day;
    return { ...stop, day };
  });
}

// 날짜가 바뀌는 지점에서만 끊는다. 경유지가 둘인데 첫째는 같은 날, 둘째만 다른 날이면
// 1건(출발→경유1→경유2) + 1건(경유2→도착)이 된다 — 경유1은 경유지로 남는다.
function cutPoints(stops) {
  const groups = [];
  let start = 0;
  for (let i = 1; i < stops.length - 1; i += 1) {
    if (stops[i].day !== stops[i - 1].day) {
      groups.push([start, i]);
      start = i;
    }
  }
  groups.push([start, stops.length - 1]);
  return groups;
}

// 접수 하나 → 오더 입력 목록.
//
// 나눌 필요가 없으면 원본 하나를 그대로 돌려준다({ parts: [intake], reason: null }) — 호출부가
// 분기 없이 항상 같은 방식으로 쓰게 하기 위해서다.
function splitIntake(intake) {
  const reason = splitReason(intake);
  const data = intake || {};

  if (!reason) {
    return { reason: null, parts: [{ ...data, splitSeq: 1 }], missingSchedule: [] };
  }

  let parts;
  if (reason === 'round_trip') {
    // 가는 편 · 오는 편. 오는 편은 출발지와 도착지가 뒤집힌다. 경유지가 함께 있으면 가는 편에
    // 그대로 남는다(왕복 분리는 복귀편을 떼어내는 것이지 경유를 쪼개는 게 아니다).
    const outStops = assignDays(buildStops(data), data.reservedDate);
    const outbound = buildPart(data, outStops, 0, outStops.length - 1, 1);

    const inboundStops = assignDays([
      {
        address: data.destinationAddress,
        addressDetail: data.destinationAddressDetail,
        contact: data.destinationContact,
        reservedDate: data.returnReservedDate || null,
        reservedTime: data.returnReservedTime || null,
      },
      { address: data.originAddress, addressDetail: data.originAddressDetail, contact: data.originContact },
    ], data.returnReservedDate);
    const inbound = buildPart(data, inboundStops, 0, 1, 2);

    parts = [outbound, inbound];
  } else {
    const stops = assignDays(buildStops(data), data.reservedDate);
    parts = cutPoints(stops).map(([from, to], i) => buildPart(data, stops, from, to, i + 1));
  }

  parts.forEach((p) => { p.splitTotal = parts.length; });

  // 일시를 모르는 건들 — 호출부가 이 순번을 보고 고객에게 되묻는다.
  const missingSchedule = parts
    .filter((p) => !trimmed(p.reservedDate) || !trimmed(p.reservedTime))
    .map((p) => p.splitSeq);

  return { reason, parts, missingSchedule };
}

// 고객에게 되물을 문구. 몇 번째 구간인지와 어디서 출발하는지를 함께 밝힌다 — "언제 출발하세요"만
// 물으면 고객은 이미 알려준 출발 시각을 다시 말한다.
function buildScheduleQuestion(part) {
  const where = trimmed(part && part.originAddress) || '경유지';
  if (part && part.splitSeq === 2 && part.splitTotal === 2 && part.__roundTrip) {
    return `복귀편은 언제 출발하시나요? (${where}에서 출발)`;
  }
  return `${where}에서는 언제 출발하시나요? (${part && part.splitSeq}번째 구간 예약일시)`;
}

// 왜 나눴는지 사람이 읽는 문구. 메모와 안내에 같은 말을 쓴다.
const REASON_LABELS = {
  waypoint: '경유지 분리',
  round_trip: '왕복 분리',
};

function describeSplit(reason, seq, total) {
  const label = REASON_LABELS[reason] || '분리';
  return `${label} ${seq}/${total}건`;
}

module.exports = {
  splitIntake,
  splitReason,
  buildScheduleQuestion,
  describeSplit,
  REASON_LABELS,
};
