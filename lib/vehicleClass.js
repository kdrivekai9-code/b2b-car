// 차종 자동 판정 — 수입차 / 대형·화물 / 전기차.
//
// 왜 접수 때가 아니라 차종 등록 때 판정하나:
// 할증은 "이 차가 어디에 해당하는가"로 갈리는데, 접수할 때마다 사람이 고르면 같은 차가
// 담당자마다 다르게 분류된다. 차종을 한 번 등록할 때 자동으로 판정해 고정해두고, 틀린 건
// 손으로 고쳐 그 값을 계속 쓴다(vehicle_models.is_* / auto_*).
//
// 여기의 사전은 "대개 맞는" 수준이지 완전하지 않다. 그래서 자동값(auto_*)과 확정값(is_*)을
// 따로 저장한다 — 사람이 고친 차종을 모아 보면 사전의 구멍이 그대로 드러난다.

// 표기 흔들림을 없앤다. "제네시스 G80(전기차)" → "제네시스g80(전기차)"
// 괄호는 살린다 — 선박요금표의 "(전기차)"·"(적차)" 주석이 판정의 근거라서.
function normalizeModelName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-_/·,]+/g, '')
    .trim();
}

// 낱말 경계를 살린 형태. 'ev' 같은 짧은 토큰은 붙여 쓴 이름에서 판정할 수 없다 —
// "Chevrolet Bolt EV"를 공백까지 지우면 'boltev'가 되어 앞 글자가 알파벳이라 토큰으로 안 잡힌다.
function spacedModelName(value) {
  return String(value || '').toLowerCase().replace(/[\-_/·,]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// ── 수입 브랜드 ─────────────────────────────────────────────────────────────
// 단가표 기준은 "차량 정보 파라미터가 외산 브랜드일 때"라 브랜드로만 판정한다.
const IMPORT_BRANDS = [
  '벤츠', '메르세데스', 'benz', 'mercedes', 'bmw', '아우디', 'audi', '폭스바겐', '폭바', 'volkswagen',
  '포르쉐', 'porsche', '볼보', 'volvo', '랜드로버', 'landrover', '레인지로버', '재규어', 'jaguar',
  '미니쿠퍼', 'mini', '렉서스', 'lexus', '도요타', '토요타', 'toyota', '혼다', 'honda', '닛산', 'nissan',
  '인피니티', 'infiniti', '마쯔다', '마즈다', 'mazda', '스바루', 'subaru', '미쓰비시', '미쯔비시', 'mitsubishi',
  '스즈키', 'suzuki', '다이하쓰', '다이하츠', 'daihatsu', '포드', 'ford', '링컨', 'lincoln', '캐딜락', 'cadillac',
  '크라이슬러', 'chrysler', '지프', 'jeep', '닷지', 'dodge', '테슬라', 'tesla', '페라리', 'ferrari',
  '람보르기니', 'lamborghini', '마세라티', 'maserati', '벤틀리', 'bentley', '롤스로이스', 'rollsroyce',
  '애스턴마틴', 'astonmartin', '맥라렌', 'mclaren', '부가티', 'bugatti', '파가니', 'pagani', '로터스', 'lotus',
  '알파로메오', 'alfaromeo', '피아트', 'fiat', '란치아', 'lancia', '푸조', 'peugeot', '시트로엥', 'citroen',
  '오펠', 'opel', '스코다', 'skoda', '세아트', 'seat', '폴스타', 'polestar', '루시드', 'lucid',
  '리비안', 'rivian', 'byd', '스마트포', '사브', 'saab', '어큐라', 'acura', 'gmc', '험머', 'hummer',
  '홀덴', 'holden', '코닉세그', 'koenigsegg', '미쯔오카', '로버', 'rover', '새턴', 'saturn',
  '폰티악', 'pontiac', '다치아', 'dacia',
  // 맨 '르노'는 수입(조에·아르카나·트윙고 등). '르노삼성/르노코리아'는 아래 국산 사전이
  // **먼저** 걸러내므로 여기 있어도 국내 모델이 수입으로 넘어가지 않는다.
  '르노', 'renault',
];

// ── 국산 브랜드 ─────────────────────────────────────────────────────────────
// 수입 사전보다 **먼저** 본다. "제네시스 G80"의 'GV'나 'rover' 같은 부분일치로 국산차가
// 수입으로 넘어가는 것을 막기 위해서다.
//
// 쉐보레·르노는 국내 판매분에 수입 모델이 섞여 있어 한쪽으로 단정할 수 없다. 국내 브랜드로
// 두고(대다수가 국내 생산분) 예외는 화면에서 고치게 한다 — 반대로 두면 아반떼급 물량이
// 전부 수입 할증을 맞는다. 다만 '르노삼성/르노코리아'가 아닌 맨 '르노'는 수입 모델
// (조에·아르카나·트윙고 등)이라 국산 사전에서 뺀다.
const DOMESTIC_BRANDS = [
  '현대', 'hyundai', '기아', 'kia', '제네시스', 'genesis', '쌍용', 'ssangyong', 'kg모빌리티', 'kgm',
  '르노삼성', '르노코리아', '삼성자동차', '대우', 'daewoo', '한국gm', '쉐보레', 'chevrolet', '지엠대우',
];

// ── 전기차 ──────────────────────────────────────────────────────────────────
// 'ev'는 부분일치로 잡으면 안 된다 — 마세라티 'Levante', 'Seven' 같은 이름에 들어 있다.
// 낱말 경계이거나 뒤에 숫자가 붙는 경우(ev6, ev9)만 인정한다.
const EV_TOKEN_RE = /(?:^|[^a-z])(ev|bev|phev)(?:[0-9]|$|[^a-z])/;
const EV_KEYWORDS = ['전기차', '전기', '일렉트릭', 'electric', '아이오닉', 'ioniq', '테슬라', 'tesla',
  '트위지', '조에', 'zoe', '리프', 'leaf', '아리야', 'ariya', '넥쏘', '타이칸', 'taycan', 'etron', 'e트론',
  '폴스타', 'polestar', '아이엑스', 'ix3', 'ix1', 'i3', 'i4', 'i5', 'i7', 'eqa', 'eqb', 'eqc', 'eqe', 'eqs',
  'id3', 'id4', 'id5', 'id6', '볼트euv', '볼트ev', '캐스퍼일렉트릭', '토레스evx', '다니고', '마이브',
  '캠시스', 'cevo', '젤라', '마사다', 't4k', 'st1', '무쏘ev'];

// ── 대형 / 화물 ─────────────────────────────────────────────────────────────
// 단가표의 "RV(카니발, 스타리아), 대형 세단, 1톤 화물 탑차 기준"을 그대로 옮겼다.
const LARGE_KEYWORDS = [
  // 화물·상용
  '톤', '화물', '카고', '트럭', 'truck', '탑차', '윙바디', '라보', '다마스', '타우너', '포터', '봉고',
  '리베로', '픽업', 'pickup', '더블캡', '초장축', '적차', '공차',
  // 승합·RV
  '승합', '인승', '스타렉스', '스타리아', '카니발', '이스타나', '프레지오', '솔라티', '마스터', '트랜싯',
  '로디우스', '코란도투리스모', '스타렉',
  // 대형 세단·SUV
  '리무진', '에쿠스', '체어맨', 'k9', 'g90', 'eq900', '팰리세이드', '펠리세이드', 'gv80', '모하비',
  '렉스톤', '렉스턴', '베라크루즈', '맥스크루즈', '트래버스', '캠핑카', '캠핑트레일러', '장의',
];

function matchAny(norm, list) {
  return list.find((k) => norm.includes(normalizeModelName(k))) || null;
}

// 자동 판정. 확실히 아는 것만 true로 두고, 모르면 false다 —
// "모름"을 true로 밀면 할증이 잘못 붙어 고객에게 더 받는 쪽으로 틀린다.
function classifyVehicleModel(rawName) {
  const norm = normalizeModelName(rawName);
  const spaced = spacedModelName(rawName);
  const reasons = [];
  if (!norm) return { isImported: false, isLarge: false, isEv: false, reasons };

  const domestic = matchAny(norm, DOMESTIC_BRANDS);
  const importBrand = domestic ? null : matchAny(norm, IMPORT_BRANDS);
  if (domestic) reasons.push(`국산 브랜드(${domestic})`);
  if (importBrand) reasons.push(`수입 브랜드(${importBrand})`);

  const evKeyword = matchAny(norm, EV_KEYWORDS);
  const evToken = EV_TOKEN_RE.test(spaced) || EV_TOKEN_RE.test(norm);
  if (evKeyword) reasons.push(`전기차 표기(${evKeyword})`);
  else if (evToken) reasons.push('전기차 표기(EV)');

  const largeKeyword = matchAny(norm, LARGE_KEYWORDS);
  if (largeKeyword) reasons.push(`대형·화물 표기(${largeKeyword})`);

  return {
    isImported: !!importBrand,
    isLarge: !!largeKeyword,
    isEv: !!(evKeyword || evToken),
    reasons,
  };
}

module.exports = {
  normalizeModelName,
  spacedModelName,
  classifyVehicleModel,
  IMPORT_BRANDS,
  DOMESTIC_BRANDS,
  EV_KEYWORDS,
  LARGE_KEYWORDS,
};
