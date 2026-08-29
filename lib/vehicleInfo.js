const PLATE_RE = /(\d{2,3}\s?[가-힣]\s?\d{4})/;

// 지역명이 앞에 붙는 구형/영업용 번호판("경기35바5081")까지 통째로 잡는 쪽. 원래 카카오 접수
// 파서(lib/kakaoIntakeParser.js)에만 있던 것을 여기로 올렸다 — 차량번호를 다루는 곳이 접수
// 말고도 생겨서(배차 도우미의 차량번호 정정) 같은 규칙을 두 벌 두지 않으려는 것이다.
//
// 지역명을 빼고 뒷부분만 잡으면 남은 지역명 토큰이 바로 앞 토큰이 되어 **차종으로 오인**된다
// (실사용 로그 재생에서 type:"경기"로 잘못 들어갔다).
//
// ⚠ 접두어를 `[가-힣]{2}`처럼 아무 두 글자로 열어두면 안 된다 — "토레스 150두8774"처럼
// 차종이 앞에 오는 어순(로그에서 압도적으로 흔하다)에서 차종 끝 두 글자를 삼켜
// "레스150두8774"라는 없는 번호판을 만들어낸다(로그 재생으로 확인한 회귀). 실제 번호판에
// 쓰이는 광역시·도 이름만 명시적으로 허용한다.
const PLATE_REGIONS = ['서울', '부산', '대구', '인천', '광주', '대전', '울산', '세종',
  '경기', '강원', '충북', '충남', '전북', '전남', '경북', '경남', '제주'];
const PLATE_CORE = `(?:(?:${PLATE_REGIONS.join('|')})\\s?)?\\d{2,3}\\s?[가-힣]\\s?\\d{4}`;
const PLATE_WITH_REGION_RE = new RegExp(PLATE_CORE);

// 문장에서 번호판을 찾아낸다. 못 찾으면 null — "형식이 어긋났다"와 "안 적었다"를 호출부가
// 구분할 수 있어야 한다(잘못된 번호를 조용히 저장하면 현장에서 다른 차를 가져간다).
function findPlate(text) {
  const source = String(text || '').trim();
  if (!source) return null;
  const m = source.match(PLATE_WITH_REGION_RE);
  if (!m) return null;
  return {
    plate: m[0].replace(/\s+/g, ''),
    rest: source.replace(m[0], ' ').replace(/\s{2,}/g, ' ').trim(),
  };
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizePlate(value) {
  return cleanText(value).replace(/\s+/g, '');
}

function sanitizeTypeCandidate(value) {
  return cleanText(value)
    .replace(/[()\[\]{}]/g, ' ')
    .replace(/[,:;/]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/^(차종|차량|차량번호)\s*/i, '')
    .trim();
}

function splitTypeAndPlate(rawType, rawNumber) {
  let vehicleType = sanitizeTypeCandidate(rawType);
  let vehicleNumber = cleanText(rawNumber);

  function absorbPlateFrom(fieldValue) {
    const text = cleanText(fieldValue);
    if (!text) return null;
    const match = text.match(PLATE_RE);
    if (!match) return null;
    return {
      plate: normalizePlate(match[1]),
      typeHint: sanitizeTypeCandidate(text.replace(match[1], ' ')),
    };
  }

  const fromNumber = absorbPlateFrom(vehicleNumber);
  if (fromNumber) {
    vehicleNumber = fromNumber.plate;
    if (!vehicleType && fromNumber.typeHint) vehicleType = fromNumber.typeHint;
  }

  const fromType = absorbPlateFrom(vehicleType);
  if (fromType) {
    if (!vehicleNumber) vehicleNumber = fromType.plate;
    vehicleType = fromType.typeHint || vehicleType;
  }

  return {
    vehicleType: vehicleType || null,
    vehicleNumber: vehicleNumber || null,
  };
}

module.exports = {
  PLATE_RE,
  PLATE_REGIONS,
  PLATE_CORE,
  PLATE_WITH_REGION_RE,
  findPlate,
  normalizePlate,
  splitTypeAndPlate,
};
