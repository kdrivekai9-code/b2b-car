// 주소 문자열 → 좌표/행정구역. 카카오 상담톡 접수처럼 "사람이 친 주소 한 줄"만 들어오는
// 경로를 위한 서버 전용 지오코더다.
//
// 왜 필요한가: 콜마너 오더접수(lib/callmaner.js buildOrderPayload)는 출발지 좌표와
// 시도/시구군/동이 없으면 요청 자체를 거부한다. 웹 화면은 사용자가 주소검색 결과를 클릭해
// 좌표를 확정하지만(routes/kakao.js 프록시), 카카오 상담톡으로 들어온 텍스트에는 좌표가 없다.
//
// routes/kakao.js와 호출 방식이 겹치지만 그쪽은 requireAuth가 걸린 브라우저용 라우터라
// 서버 내부에서 재사용할 수 없어, 검색 부분만 여기로 뺐다.
const { lookupRegion } = require('./kakaoRegion');

const KAKAO_LOCAL_BASE = 'https://dapi.kakao.com/v2/local/';

// cache(선택): 같은 턴 안에서 geocodeAddress가 두 번 이상 불릴 때(예: 도선 판정과 접수 등록이
// 같은 주소를 각자 지오코딩) 같은 경로+질의는 다시 호출하지 않는다. 안 넘기면 항상 새로 조회한다.
async function kakaoLocalSearch(path, query, cache) {
  const key = cache ? `${path}|${query}` : null;
  if (key && cache.has(key)) return cache.get(key);

  const result = await (async () => {
    if (!process.env.KAKAO_REST_API_KEY) return [];
    try {
      const url = `${KAKAO_LOCAL_BASE}${path}?size=5&query=${encodeURIComponent(query)}`;
      const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
      if (!res.ok) return [];
      const data = await res.json();
      return data.documents || [];
    } catch (e) {
      console.error('카카오 로컬 검색 실패:', e.message);
      return [];
    }
  })();

  if (key) cache.set(key, result);
  return result;
}

// 사람이 친 주소에는 검색을 방해하는 꼬리가 붙는다 — "( 010-… 김희철 차장님)", "803호(8층)",
// "T.062 365 2004". 원문 그대로 한 번 시도하고, 실패하면 단계적으로 깎아서 재시도한다.
// 가장 구체적인 질의부터 시도하는 순서를 지켜야 엉뚱한 동명이인 장소로 붙지 않는다.
function buildQueryVariants(rawAddress) {
  const base = String(rawAddress || '').replace(/\s+/g, ' ').trim();
  if (!base) return [];

  const variants = [base];

  // 괄호 안 부가정보 제거
  const noParen = base.replace(/[（(][^)）]*[)）]/g, ' ').replace(/\s+/g, ' ').trim();
  if (noParen && noParen !== base) variants.push(noParen);

  // 전화번호/층·호 표기 제거
  const noDetail = noParen
    .replace(/T\.?\s?[\d\s-]{7,}/gi, ' ')
    .replace(/\d+\s*호(?![가-힣])/g, ' ')
    .replace(/\d+\s*층(?![가-힣])/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (noDetail && !variants.includes(noDetail)) variants.push(noDetail);

  // 도로명+건물번호까지만 남기기 — "서울 양천로 53길 30, 서서울모터리움" → "서울 양천로 53길 30"
  const comma = noDetail.split(',')[0].trim();
  if (comma && !variants.includes(comma)) variants.push(comma);

  const roadMatch = noDetail.match(/^(.*?[가-힣]+로\s?\d*번?길?\s*\d+(?:-\d+)?)/);
  if (roadMatch && roadMatch[1] && !variants.includes(roadMatch[1].trim())) variants.push(roadMatch[1].trim());

  // 띄어쓰기를 붙여 쓴 경우 — 카카오 로컬 검색은 이 한 칸에 결과가 갈린다(실측):
  //   "강남역5번출구" → 못 찾음 / "강남역 5번출구" → 찾음
  //   "사당역탐앤탐스" → 못 찾음 / "사당역 탐앤탐스" → 찾음
  // 고객은 붙여 쓰는 쪽이 흔한데(실사용 접수에서 그대로 들어왔다), 못 찾으면 도착지 좌표가
  // 비어 콜마너 접수에서 도착지 블록이 통째로 빠진다. 붙여 쓴 자리를 띄운 변형을 함께 시도한다.
  const spaced = noDetail
    // "…역/터미널/공항" 바로 뒤에 상호가 붙은 경우. 앞에 두 글자 이상을 요구해 "역삼동"처럼
    // 역으로 시작하는 지명은 건드리지 않는다.
    .replace(/([가-힣]{2,}(?:역|터미널|공항))([가-힣]{2,})/g, '$1 $2')
    // "강남역5번출구"처럼 숫자가 바로 붙은 경우.
    .replace(/([가-힣])(\d+\s*번\s*(?:출구|게이트))/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
  if (spaced && !variants.includes(spaced)) variants.push(spaced);

  // 출구 표기를 떼어낸 것 — 마지막 수단이다. 출구가 달라도 좌표 차이는 백 미터 안이라,
  // 도착지가 아예 없는 오더보다 훨씬 낫다.
  const noExit = spaced.replace(/\s*\d+\s*번\s*(?:출구|게이트)/g, '').replace(/\s+/g, ' ').trim();
  if (noExit && noExit !== spaced && !variants.includes(noExit)) variants.push(noExit);

  return variants.filter(Boolean).slice(0, 7);
}

function toCoord(doc) {
  const lat = Number(doc.y);
  const lon = Number(doc.x);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}

// 키워드(상호명) 검색은 항상 "가장 그럴듯한" 장소를 자신 있게 돌려준다 — 실제로 "서울지점"을
// 넣으면 종로구의 무관한 가게가 나왔다. 자동 등록에 그대로 쓰면 엉뚱한 곳으로 기사가 간다.
// 그래서 질의에 쓰인 특징적인 토큰(2글자 이상, 흔한 행정구역 접미어 제외)이 결과의 장소명이나
// 주소에 실제로 남아 있을 때만 채택한다.
const GENERIC_TOKEN_RE = /^(서울|경기|인천|부산|대구|대전|광주|울산|세종|강원|충북|충남|전북|전남|경북|경남|제주|지점|본점|영업소|센터|주차장|정문|후문|사무실|１층|층|호)$/;

function keywordHitLooksRight(query, doc) {
  const haystack = `${doc.place_name || ''} ${doc.road_address_name || ''} ${doc.address_name || ''}`;
  const tokens = String(query)
    .split(/[\s,()<>/]+/)
    .map((t) => t.replace(/[^가-힣A-Za-z0-9]/g, ''))
    .filter((t) => t.length >= 2 && !GENERIC_TOKEN_RE.test(t) && !/^\d+$/.test(t));
  if (!tokens.length) return false;
  return tokens.some((t) => haystack.includes(t));
}

// 주소검색을 먼저 쓰고(정확도 우선), 결과가 없을 때만 키워드(상호명) 검색으로 넘어간다.
// 로그의 도착지 상당수가 "서서울모터리움 803호"처럼 상호명이라 키워드 폴백이 반드시 필요하다.
//
// cache(선택): 호출부(카카오 상담톡 접수)가 한 턴 안에서 같은 주소를 여러 단계(도선 판정,
// 접수 등록 등)에서 각자 다시 지오코딩하던 중복을 없애려고 추가했다. Map을 넘기면 그 안의
// kakaoLocalSearch/lookupRegion 호출까지 재사용되고, 안 넘기면 이전과 동일하게 항상 새로 조회한다.
async function geocodeAddress(rawAddress, cache) {
  const variants = buildQueryVariants(rawAddress);
  if (!variants.length) return null;

  for (const q of variants) {
    const addressDocs = await kakaoLocalSearch('search/address.json', q, cache);
    const addressHit = addressDocs.find((d) => toCoord(d));
    if (addressHit) {
      const coord = toCoord(addressHit);
      const region = await lookupRegion(coord.lat, coord.lon, cache);
      return {
        lat: coord.lat,
        lon: coord.lon,
        matchedBy: 'address',
        matchedQuery: q,
        address: addressHit.road_address ? addressHit.road_address.address_name : addressHit.address_name,
        sido: region ? region.sido : null,
        sigugun: region ? region.sigugun : null,
        dong: region ? region.dong : null,
      };
    }
  }

  for (const q of variants) {
    const keywordDocs = await kakaoLocalSearch('search/keyword.json', q, cache);
    const keywordHit = keywordDocs.find((d) => toCoord(d) && keywordHitLooksRight(q, d));
    if (keywordHit) {
      const coord = toCoord(keywordHit);
      const region = await lookupRegion(coord.lat, coord.lon, cache);
      return {
        lat: coord.lat,
        lon: coord.lon,
        matchedBy: 'keyword',
        matchedQuery: q,
        address: keywordHit.road_address_name || keywordHit.address_name || keywordHit.place_name,
        placeName: keywordHit.place_name || null,
        sido: region ? region.sido : null,
        sigugun: region ? region.sigugun : null,
        dong: region ? region.dong : null,
      };
    }
  }

  return null;
}

// 콜마너 접수에 쓸 수 있는 완전한 결과인지 — 좌표만 있고 행정구역이 비면 buildOrderPayload가
// 던진다. 출발지에만 필수이고 도착지는 없어도 접수는 나간다(도착지 정보는 선택 항목).
function isCallmanerReady(geo) {
  return !!(geo && geo.lat && geo.lon && geo.sido && geo.sigugun && geo.dong);
}

module.exports = { geocodeAddress, buildQueryVariants, isCallmanerReady, kakaoLocalSearch };
