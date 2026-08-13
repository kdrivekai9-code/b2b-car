// 좌표 -> 시도(약어)/시구군/동 변환 — 콜마너 오더접수가 요구하는 행정구역 형식.
// "콜마너 외부연동 인터페이스 정의서" v3.0 "바. 공통 주의사항" 2/3 기준:
//   2. '시도'는 약어로 사용한다 (서울특별시 -> 서울)
//   3. '시구'는 한 필드로 사용한다 (성남시 분당구 -> 성남시분당구)
// routes/kakao.js(브라우저용 /kakao/region 프록시)와 lib/callmaner.js(경유지 viaList를
// 보낼 때 서버에서 직접 조회)가 같은 규칙을 써야 해서 별도 모듈로 뺐다.

const SIDO_ABBREVIATIONS = {
  서울특별시: '서울', 부산광역시: '부산', 대구광역시: '대구', 인천광역시: '인천',
  광주광역시: '광주', 대전광역시: '대전', 울산광역시: '울산', 경기도: '경기',
  강원도: '강원', 강원특별자치도: '강원', 충청북도: '충북', 충청남도: '충남',
  전라북도: '전북', 전북특별자치도: '전북', 전라남도: '전남',
  경상북도: '경북', 경상남도: '경남', 제주특별자치도: '제주', 세종특별자치시: '세종',
};

function abbreviateSido(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  if (SIDO_ABBREVIATIONS[s]) return SIDO_ABBREVIATIONS[s];
  return s.slice(0, 2);
}

// "성남시 분당구" -> "성남시분당구"
function formatSigugun(name) {
  return String(name || '').trim().replace(/\s+/g, '');
}

// 법정동(region_type='B') 결과를 우선 사용한다. 실패하면 null을 반환하고 호출부가 판단한다
// (경유지는 행정구역이 선택 항목이라 조회 실패해도 좌표만으로 보낼 수 있다).
//
// cache(선택): 카카오 상담톡 접수 한 턴 안에서 같은 좌표(같은 주소)를 여러 경로가 각자
// 다시 조회하는 중복이 있었다(예: 주소 후보 검색과 접수 등록이 같은 주소를 각각 지오코딩).
// 호출부가 Map을 넘기면 그 턴 동안만 재사용하고, 안 넘기면(기존 호출부) 항상 새로 조회한다 —
// 동작이 바뀌지 않는다.
async function lookupRegion(lat, lng, cache) {
  const key = cache ? `${lat},${lng}` : null;
  if (key && cache.has(key)) return cache.get(key);

  const result = await (async () => {
    if (!process.env.KAKAO_REST_API_KEY) return null;
    try {
      const url = `https://dapi.kakao.com/v2/local/geo/coord2regioncode.json?x=${lng}&y=${lat}`;
      const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
      if (!res.ok) return null;
      const data = await res.json();
      const docs = data.documents || [];
      const region = docs.find((d) => d.region_type === 'B') || docs[0];
      if (!region) return null;
      return {
        sido: abbreviateSido(region.region_1depth_name),
        sigugun: formatSigugun(region.region_2depth_name),
        dong: String(region.region_3depth_name || '').trim(),
      };
    } catch (e) {
      console.error('행정구역 조회 실패:', e.message);
      return null;
    }
  })();

  if (key) cache.set(key, result);
  return result;
}

// 좌표 → 도로명주소. lookupRegion은 coord2regioncode(시/구/동만)를 쓰는데, 오더의 주소 칸에는
// 도로명주소가 들어가야 하므로 coord2address를 따로 쓴다.
//
// 왜 필요한가: 배차 도우미의 장소검색(콜마너 place.find)은 {name, region, xy}만 돌려주고 주소
// 문자열이 없다. 그래서 MCP로 출발지를 변경하면 오더의 origin_address에 도로명주소 대신
// 장소명("판교역")이 저장됐다. 좌표는 정확히 오므로 그걸로 주소를 되찾는다.
async function lookupRoadAddress(lat, lng, cache) {
  const key = cache ? `addr:${lat},${lng}` : null;
  if (key && cache.has(key)) return cache.get(key);

  const result = await (async () => {
    if (!process.env.KAKAO_REST_API_KEY) return null;
    try {
      const url = `https://dapi.kakao.com/v2/local/geo/coord2address.json?x=${lng}&y=${lat}`;
      const res = await fetch(url, { headers: { Authorization: 'KakaoAK ' + process.env.KAKAO_REST_API_KEY } });
      if (!res.ok) return null;
      const data = await res.json();
      const doc = (data.documents || [])[0];
      if (!doc) return null;
      // 도로명주소가 없는 좌표(신축·산간 등)도 있어 지번주소로 떨어진다.
      const road = doc.road_address && String(doc.road_address.address_name || '').trim();
      const jibun = doc.address && String(doc.address.address_name || '').trim();
      return road || jibun || null;
    } catch (e) {
      console.error('좌표→주소 조회 실패:', e.message);
      return null;
    }
  })();

  if (key) cache.set(key, result);
  return result;
}

module.exports = { SIDO_ABBREVIATIONS, abbreviateSido, formatSigugun, lookupRegion, lookupRoadAddress };
