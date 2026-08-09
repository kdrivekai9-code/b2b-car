// 접수 하나를 실제 운영 규칙에 맞게 여러 건으로 나눈다.
//
// 규칙(사용자 확인, 2026-08-09): 경유지가 있거나 · 왕복콜이거나 · 구간마다 수행일이 다르면
// 오더 하나로 받지 않고 구간마다 별도 오더로 접수한다.
//   경유지: 출발→경유 1건, 경유→최종목적지 1건 (경유지가 둘이면 3건)
//   왕복:   출발→도착 1건, 도착→출발 1건
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

// 나눠야 하는 접수인지, 그렇다면 왜인지. 화면·문구에서 이유를 그대로 쓴다.
function splitReason(intake) {
  const data = intake || {};
  const waypoints = (data.waypoints || []).filter((w) => w && trimmed(w.address));
  if (waypoints.length) return 'waypoint';
  if (data.roundTrip) return 'round_trip';
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

// 정류장 두 곳으로 한 건을 만든다.
//
// 연락처는 비워둘 수 없다 — 서버(POST /orders)가 필수로 검증해서 비면 등록 자체가 막힌다.
// 경유지 연락처를 안 받은 경우가 흔해서, 없으면 출발지 연락처를 그대로 물려준다.
function buildPart(intake, from, to, seq) {
  const data = intake || {};
  const fallbackContact = trimmed(data.originContact) || trimmed(data.destinationContact);
  return {
    ...data,
    waypoints: [],
    roundTrip: false,

    originAddress: from.address,
    originAddressDetail: from.addressDetail || null,
    originContact: trimmed(from.contact) || fallbackContact,

    destinationAddress: to.address,
    destinationAddressDetail: to.addressDetail || null,
    destinationContact: trimmed(to.contact) || fallbackContact,

    // 그 구간을 언제 출발하는지. 첫 구간은 접수 일시, 이후 구간은 그 정류장에서 다시 출발하는
    // 시각이다. 모르면 null로 두고 호출부가 고객에게 묻는다 — 임의로 같은 시각을 넣으면
    // 두 건이 같은 시각에 겹쳐 접수된다.
    reservedDate: from.reservedDate || null,
    reservedTime: from.reservedTime || null,

    // 구간마다 다른 차량을 옮기는 경우가 있어(경유지에 차량번호가 따로 적힌다) 그 값을 우선한다.
    vehicleNumber: trimmed(from.vehicleNumber) || data.vehicleNumber || null,

    splitSeq: seq,
  };
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
    // 가는 편 · 오는 편. 오는 편은 출발지와 도착지가 뒤집힌다.
    const outbound = buildPart(
      data,
      { address: data.originAddress, addressDetail: data.originAddressDetail, contact: data.originContact, reservedDate: data.reservedDate, reservedTime: data.reservedTime },
      { address: data.destinationAddress, addressDetail: data.destinationAddressDetail, contact: data.destinationContact },
      1
    );
    const inbound = buildPart(
      data,
      {
        address: data.destinationAddress,
        addressDetail: data.destinationAddressDetail,
        contact: data.destinationContact,
        reservedDate: data.returnReservedDate || null,
        reservedTime: data.returnReservedTime || null,
      },
      { address: data.originAddress, addressDetail: data.originAddressDetail, contact: data.originContact },
      2
    );
    parts = [outbound, inbound];
  } else {
    const stops = buildStops(data);
    parts = [];
    for (let i = 0; i < stops.length - 1; i += 1) {
      parts.push(buildPart(data, stops[i], stops[i + 1], i + 1));
    }
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
