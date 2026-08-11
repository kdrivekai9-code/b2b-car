// 접수 내용 요약 — 웹 접수 화면과 카카오 상담톡이 공유하는 한 벌.
// 접수 대화 통합의 세 번째 조각(1: lib/intakeFields.js, 2: lib/addressCandidates.js).
//
// 같은 내용을 세 곳이 각자 만들고 있었다.
//   · 브라우저 buildSummaryText  — "▪ 예약: …" (등록 전 확인용)
//   · lib/agentAssist.js         — "접수하겠습니다. · …" (상담원 초안)
//   · lib/kakaoIntakeService.js  — "접수했습니다. (OID…) · …" (등록 후 통보)
// 항목이 하나 늘 때마다 세 곳을 찾아 고쳐야 했고, 실제로 옵션(주유·서류)은 카카오 쪽에만
// 들어가 있어 웹 요약에는 안 보였다.
//
// 형식은 상황마다 달라야 한다(등록 전 확인 / 등록 후 통보) — 그래서 "무엇을 보여줄지"를
// 여기서 한 번 정하고, 머리말과 꼬리말만 호출부가 정한다.

// 요약 한 줄에 쓸 값들을 정규화한다. 폼 필드명(웹)과 파서 결과(카카오)가 이름이 달라
// 호출부가 이 모양으로 맞춰 넘긴다 — 그래야 이 모듈이 어느 한쪽 이름에 묶이지 않는다.
//
// intake = {
//   reservedDate, reservedTime, immediate,
//   origin: { address, detail, contact },
//   destination: { address, detail, contact },
//   waypoints: [{ address, contact, vehicleNumber }],
//   vehicles: [{ type, number }],
//   options: { insurance, refuel, documents, fuelGauge, releaseDate },
//   memoCustomer, memoBilling,
// }

function joinAddress(address, detail) {
  return [address, detail].map((v) => String(v || '').trim()).filter(Boolean).join(' ');
}

function vehicleLabel(v) {
  return [v && v.type, v && v.number].filter(Boolean).join(' ');
}

// 옵션 요약 — 카카오 접수 폼에만 있는 항목들이지만, 웹에서도 같은 값이 들어오면 그대로 보인다.
function describeOptions(options) {
  const o = options || {};
  const out = [];
  if (o.insurance) out.push('책임보험 가입');
  if (o.refuel) {
    if (typeof o.refuel === 'string') out.push(o.refuel);
    else {
      const amount = o.refuel.amount ? `${o.refuel.amount / 10000}만원` : '';
      out.push([o.refuel.fuel, amount, '주유'].filter(Boolean).join(' '));
    }
  } else if (o.fuelGauge) {
    out.push(`연료 ${o.fuelGauge}칸`);
  }
  if (o.documents) out.push(String(o.documents));
  if (o.releaseDate) out.push(`출고일 ${o.releaseDate}`);
  return out;
}

// 본문 줄 목록. style로 글머리 기호만 바꾼다 — 웹은 기존 "▪", 카카오는 "·"를 써 왔고
// 화면에 익숙해진 표기를 굳이 바꿀 이유가 없다.
function buildSummaryLines(intake, options = {}) {
  const bullet = options.bullet || '·';
  const labeled = options.labeled !== false; // 웹은 "출발지:" 라벨을 붙이고, 카카오는 화살표로 줄인다
  const data = intake || {};
  const origin = data.origin || {};
  const destination = data.destination || {};
  const lines = [];

  const when = [data.reservedDate, data.reservedTime].filter(Boolean).join(' ');
  if (when) lines.push(`${bullet} ${labeled ? '예약: ' : ''}${when}${data.immediate ? ' 즉시' : ''}`);

  if (labeled) {
    const originText = joinAddress(origin.address, origin.detail);
    if (originText) lines.push(`${bullet} 출발지: ${originText}${origin.contact ? ` (${origin.contact})` : ''}`);
  }

  // 차량 표기는 화면마다 익숙해진 형태가 다르다. 웹 접수 화면은 번호와 차종을 각각 한 줄로
  // 보여주고(고객이 화면에서 항목별로 확인한다), 카카오는 말풍선이 짧아야 읽혀서 한 줄로 묶는다.
  // 표기만 다르고 담기는 값은 같다 — 그래서 여기서 갈라도 "내용이 갈라지는" 문제는 생기지 않는다.
  (data.vehicles || []).forEach((v) => {
    if (labeled) {
      if (v && v.number) lines.push(`${bullet} 차량번호: ${v.number}`);
      if (v && v.type) lines.push(`${bullet} 차종: ${v.type}`);
      return;
    }
    const label = vehicleLabel(v);
    if (label) lines.push(`${bullet} ${label}`);
  });

  if (labeled) {
    (data.waypoints || []).forEach((w) => {
      if (!w || !w.address) return;
      lines.push(`${bullet} 경유지: ${joinAddress(w.address, w.addressDetail)}${w.contact ? ` (${w.contact})` : ''}`);
      if (w.vehicleNumber) lines.push(`${bullet} 차량번호: ${w.vehicleNumber}`);
    });

    const destText = joinAddress(destination.address, destination.detail);
    if (destText) lines.push(`${bullet} 도착지: ${destText}${destination.contact ? ` (${destination.contact})` : ''}`);
  } else {
    // 카카오는 한 줄에 구간을 묶는다 — 말풍선이 짧아야 읽힌다. 접수 확인 문구는 등록 전
    // 마지막 검토 지점이라, 연락처와 경유지를 생략하지 않고 같은 줄에 담아 전체 입력사항을
    // 한눈에 보게 한다(출발지 → 경유지 → 도착지 순서, 각 주소 옆에 연락처).
    const originText = joinAddress(origin.address, origin.detail);
    const destText = joinAddress(destination.address, destination.detail);
    if (originText) {
      const waypoint = (data.waypoints || [])[0];
      const originPart = `${originText}${origin.contact ? ` (${origin.contact})` : ''}`;
      const destPart = `${destText || '(도착지 미기재)'}${destination.contact ? ` (${destination.contact})` : ''}`;
      const routeParts = waypoint && waypoint.address
        ? [originPart, `${joinAddress(waypoint.address, waypoint.addressDetail)}${waypoint.contact ? ` (${waypoint.contact})` : ''}`, destPart]
        : [originPart, destPart];
      lines.push(`${bullet} ${routeParts.join(' → ')}`);
    }
  }

  const opts = describeOptions(data.options);
  if (opts.length) lines.push(`${bullet} 옵션: ${opts.join(', ')}`);

  if (data.memoCustomer) lines.push(`${bullet} ${labeled ? '메모(기사전달사항): ' : ''}${data.memoCustomer}`);
  if (data.memoBilling) lines.push(`${bullet} 업체 전달사항: ${data.memoBilling}`);

  return lines;
}

// 머리말/꼬리말을 붙인 완성 문구.
function buildSummaryText(intake, options = {}) {
  const lines = buildSummaryLines(intake, options);
  const parts = [];
  if (options.head) parts.push(options.head);
  if (lines.length) parts.push(lines.join('\n'));
  if (options.tail) parts.push(options.tail);
  return parts.join('\n');
}

// 카카오 파서 결과(parseKakaoIntake / buildParsedFromClassified) → 요약 입력.
// 파서 결과 모양을 아는 곳을 한 곳으로 모아둔다 — 호출부마다 변환하면 또 갈라진다.
function fromParsed(parsed, reservation) {
  const p = parsed || {};
  return {
    reservedDate: reservation ? reservation.date : (p.when && p.when.date) || null,
    reservedTime: reservation ? reservation.time : (p.when && p.when.time) || null,
    immediate: reservation ? !!reservation.immediate : !!(p.when && p.when.immediate),
    // detail은 상세주소 — 저장은 두 칸으로 나뉘지만(orders.origin_address / _detail) 요약 문구는
    // joinAddress로 합쳐 보여준다. 고객이 말한 그대로 되읽어줘야 오인식을 잡을 수 있다.
    origin: { address: p.origin && p.origin.address, detail: p.origin && p.origin.addressDetail, contact: p.origin && p.origin.contact },
    destination: { address: p.destination && p.destination.address, detail: p.destination && p.destination.addressDetail, contact: p.destination && p.destination.contact },
    waypoints: (p.waypoints || []).map((w) => ({ address: w.address, addressDetail: w.addressDetail, contact: w.contact, vehicleNumber: w.vehicleNumber })),
    vehicles: (p.vehicles || []).map((v) => ({ type: v.type, number: v.plate })),
    options: p.options || {},
    memoCustomer: p.memo || null,
  };
}

module.exports = { buildSummaryLines, buildSummaryText, describeOptions, fromParsed };
