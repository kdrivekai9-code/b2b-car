// AI 접수 화면의 텍스트 파싱 — 현재는 정해진 포맷(출/경/도 + 연락처 + 차량번호)을 인식하는
// 규칙 기반(정규식) 임시 파서다. 실제 LLM 연동 전까지의 자리표시자이며,
// parseIntakeText(text) 의 입출력 형태만 유지하면 이후 LLM 기반 구현으로 교체할 수 있다.
const { kstNow, toDateStr } = require('./period');
const { splitTypeAndPlate } = require('./vehicleInfo');

const PHONE_RE = /01[0-9]-?\d{3,4}-?\d{4}/;
const PLATE_RE_GLOBAL = /\d{2,3}\s?[가-힣]\s?\d{4}/g;

function inferVehicleType(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const labeled = source.match(/차종\s*[:：]?\s*([A-Za-z0-9가-힣\-]{2,20})/);
  if (labeled) return labeled[1];
  const nearPlate = source.match(/([A-Za-z0-9가-힣\-]{2,20})\s*\d{2,3}\s?[가-힣]\s?\d{4}/);
  if (nearPlate) return nearPlate[1];
  return null;
}

function normalizePhone(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return raw.trim();
}

function parseDate(text) {
  const now = kstNow();
  const addDays = (n) => new Date(now.getTime() + n * 86400000);
  if (/오늘/.test(text)) return toDateStr(now);
  if (/내일/.test(text)) return toDateStr(addDays(1));
  if (/모레/.test(text)) return toDateStr(addDays(2));
  const md = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (md) {
    const year = now.getUTCFullYear();
    return `${year}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}`;
  }
  const iso = text.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`;
  return toDateStr(now);
}

function parseTime(text) {
  const isPM = /오후|저녁|밤/.test(text);
  const isAM = /오전|새벽|아침/.test(text);
  const hm = text.match(/(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if (hm) {
    let h = parseInt(hm[1], 10);
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
    const m = hm[2] ? String(hm[2]).padStart(2, '0') : '00';
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  const colon = text.match(/(\d{1,2}):(\d{2})/);
  if (colon) return `${String(colon[1]).padStart(2, '0')}:${colon[2]}`;
  return null;
}

// 각 지점 표시(출/경/도)는 콜론(출:)이 있어도 없어도(출발지 강남역) 인식해야 한다 —
// "표시어 + (콜론 또는 공백 또는 줄끝)" 형태를 라인 시작 판별에 사용한다.
const ORIGIN_PREFIX_RE = /^출(?:발지?)?(?=[:：\s]|$)/;
const WAYPOINT_PREFIX_RE = /^경(?:유지?)?\d*(?=[:：\s]|$)/;
const DEST_PREFIX_RE = /^도(?:착지?)?(?=[:：\s]|$)/;

// "출: 강남역 010-1111-2222" 또는 "출발지 강남역 010-1111-2222" -> { place: '강남역', contact: '010-1111-2222' }
function parseLocationLine(line, prefixRe) {
  const phoneMatch = line.match(PHONE_RE);
  const contact = phoneMatch ? normalizePhone(phoneMatch[0]) : null;
  let place = line.replace(prefixRe, '').replace(/^\s*[:：]\s*/, '');
  if (phoneMatch) place = place.replace(phoneMatch[0], '');
  return { place: place.trim(), contact };
}

// "판교역에서 사당역으로" 같은 자연스러운 한 문장 요청 — 출/경/도 표시어가 전혀 없을 때의 대체 인식.
// "A에서 B(으로|까지|로)" 패턴만 인식하며, 경유지·연락처는 문장에서 뽑아내지 않는다(표시어가 없으면 구분이 애매하기 때문).
const ROUTE_SENTENCE_RE = /(.+?)에서\s*(.+?)(?:으로|까지|로)/;

function parseNaturalSentence(text) {
  const plateMatches = (text.match(PLATE_RE_GLOBAL) || []).map((m) => m.replace(/\s/g, ''));
  const routeMatch = text.match(ROUTE_SENTENCE_RE);
  const splitVehicle = splitTypeAndPlate(inferVehicleType(text), plateMatches[0] || null);

  return {
    reserved_date: parseDate(text),
    reserved_time: parseTime(text),
    origin_address: routeMatch ? routeMatch[1].trim() : '',
    origin_contact: null,
    origin_vehicle_number: splitVehicle.vehicleNumber,
    vehicle_type: splitVehicle.vehicleType,
    waypoints: [],
    destination_address: routeMatch ? routeMatch[2].trim() : '',
    destination_contact: null,
    memo_customer: null,
  };
}

function parseIntakeText(text) {
  const raw = (text || '').trim();
  const lines = raw.split('\n').map((l) => l.trim()).filter(Boolean);

  const originLine = lines.find((l) => ORIGIN_PREFIX_RE.test(l));
  const waypointLines = lines.filter((l) => WAYPOINT_PREFIX_RE.test(l));
  const destLine = lines.find((l) => DEST_PREFIX_RE.test(l));

  // 출/경/도 표시어를 전혀 못 찾았으면(자유 문장 입력) 별도 규칙으로 대체 인식한다.
  if (!originLine && !destLine) return parseNaturalSentence(raw);

  const dateTimeLine = lines.find((l) => /오늘|내일|모레|\d{1,2}\s*시|\d{4}-\d{1,2}-\d{1,2}|\d{1,2}\s*월/.test(l)) || '';

  const origin = originLine ? parseLocationLine(originLine, ORIGIN_PREFIX_RE) : { place: '', contact: null };
  const waypoints = waypointLines.map((l) => parseLocationLine(l, WAYPOINT_PREFIX_RE));
  const destination = destLine ? parseLocationLine(destLine, DEST_PREFIX_RE) : { place: '', contact: null };

  const structuredLines = new Set([originLine, destLine, dateTimeLine, ...waypointLines].filter(Boolean));
  const remainingLines = lines.filter((l) => !structuredLines.has(l));

  const allPlates = [];
  remainingLines.forEach((l) => {
    const matches = l.match(PLATE_RE_GLOBAL);
    if (matches) matches.forEach((m) => allPlates.push(m.replace(/\s/g, '')));
  });

  let originVehicle = null;
  const waypointVehicles = [];
  if (waypoints.length === 0) {
    originVehicle = allPlates[0] || null;
  } else {
    originVehicle = allPlates[0] || null;
    waypoints.forEach((wp, i) => { waypointVehicles[i] = allPlates[i + 1] || null; });
  }

  const memoText = remainingLines
    .map((l) => allPlates.reduce((acc, plate) => acc.replace(plate, ''), l))
    .join('\n')
    .replace(/[,，]\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const splitVehicle = splitTypeAndPlate(inferVehicleType(remainingLines.join(' ')), originVehicle);

  return {
    reserved_date: parseDate(dateTimeLine),
    reserved_time: parseTime(dateTimeLine),
    origin_address: origin.place,
    origin_contact: origin.contact,
    origin_vehicle_number: splitVehicle.vehicleNumber,
    vehicle_type: splitVehicle.vehicleType,
    waypoints: waypoints.map((wp, i) => ({
      address: wp.place,
      contact: wp.contact,
      vehicle_number: waypointVehicles[i] || null,
    })),
    destination_address: destination.place,
    destination_contact: destination.contact,
    memo_customer: memoText || null,
  };
}

module.exports = { parseIntakeText };
