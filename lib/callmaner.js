// 콜마너 외부연동 API 클라이언트 — "콜마너 외부연동 인터페이스 정의서"(v3.0) 기준.
// 문서 "나. 개발원칙 4"는 요청/응답을 base64 인코딩하라고 되어 있지만, 실제 운영 서버
// (api.cd1.kr) 상대 smoke test(2026-08-04) 결과 이는 사실이 아니다 — 서버는 `t` 파라미터를
// base64가 아니라 **평문 JSON 그대로**(URL 인코딩만) 기대한다. base64로 보냈더니
// `{"rc":"E0","rm":"...syntax error, expect {, actual error"}`로 거부당하는 것으로 확인됨 —
// 문서보다 이 실측 결과를 신뢰해서 평문 JSON으로 구현한다. 응답도 gzip(fetch가 자동 압축해제)
// 이지 base64가 아닌 평문 JSON이었다. 인증은 API key가 아니라 IP 화이트리스트 방식이라고
// 문서에 나와 있지만, 실제로는 IP 등록 없이도 요청이 서버까지 도달하는 것으로 확인됨(2026-08-04).

const { lookupRegion } = require('./kakaoRegion');
const { receiptMemoLine } = require('./postalReceipt');

const DEFAULT_TIMEOUT_MS = 10000;

// 문서 "사. 인터페이스상세 - 오더전체상태조회" status_code 표. 의미가 불명확한 03(타사배차)/
// 04(강제)/06(예약)/08(예약배차)는 로컬 status를 자동으로 바꾸지 않는다(routes/callmanerSync.js
// 에서 이 맵에 없는 코드는 참고용 note만 남기고 orders.status는 건드리지 않음).
const STATUS_CODE_TO_LOCAL_STATUS = {
  '00': '문의',
  '01': '접수',
  '02': '기사배정',
  '07': '완료',
};

// 단건 상태조회(OrderInfo)는 코드가 아니라 한글 상태명을 준다(status="접수" 등, 실측).
// OrderAllStatus의 status_code 표와 같은 의미로 맞춘 매핑이며, 여기에 없는 값은 로컬 status를
// 건드리지 않고 참고용으로만 기록한다(routes/callmanerSync.js).
const STATUS_TEXT_TO_LOCAL_STATUS = {
  '대기': '대기',
  '접수': '접수',
  '예약': '예약',
  '배차': '기사배정',
  '완료': '완료',
  '취소': '취소',
  '문의': '문의',
};

async function fetchWithTimeout(url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`콜마너 API 응답이 ${timeoutMs / 1000}초 내에 오지 않았습니다: ${url}`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// providerId는 콜마너가 발급하는 완전한 문자열이다(예: B100-12345-AP12345 — 콜마너 자체
// 지사코드-대표번호-관련어플코드로 구성되지만, 이 세 부분은 우리 branches.code/main_phone과는
// 무관하므로 조립하지 않고 그대로 사용한다).
function buildProviderId(branch) {
  const providerId = String(branch.callmaner_provider_id || '').trim();
  if (!providerId) {
    throw new Error('콜마너 providerId가 지사 설정에 없습니다.');
  }
  return providerId;
}

let tnCounter = 0;
function nextTn() {
  tnCounter = (tnCounter + 1) % 1000000;
  return String(tnCounter);
}

// 전송 방식에 따라 쿼리 파라미터 이름과 페이로드 처리가 다르다(콜마너 제공 샘플 기준):
//   - 평문 모드(개발 확인용) : ?t={JSON}                 URL 인코딩만
//   - 암호 모드(운영)        : ?p={Base64(Blowfish(JSON))} URL 인코딩
// 예전에 "문서는 base64라는데 실제로는 평문이더라"고 적어뒀던 건 두 가지를 동시에 틀렸기
// 때문이다 — base64를 `t`로 보냈고(파라미터 이름), 암호화도 하지 않았다. 실제로 암호화 없이
// base64만 `p`로 보내면 서버는 요청 내용과 무관하게 항상 같은 응답을 주는데, 그걸 응답키로
// 복호화해보면 {"rc":"E0","rm":"알수없는 오류 syntax error, expect {, actual error"}였다
// (2026-08-05 실측 — 주석에 남아 있던 그 에러의 정체).
//
// 암호 규약: Blowfish/ECB/NoPadding + 0x00 zero padding(8바이트 배수), Base64 → URL 인코딩.
// 요청 키와 응답 키가 다르다. OpenSSL 3에서 Blowfish가 legacy provider로 빠져 Node 내장
// crypto로는 쓸 수 없어(ERR_OSSL_EVP_UNSUPPORTED) egoroof-blowfish(MIT, 의존성 없음)를 쓴다.
//
// 키는 소스에 넣지 않고 환경변수로 받는다(.env는 gitignore 대상) — 다른 비밀값들과 동일한 취급.
// 키가 설정돼 있으면 운영 규약대로 암호 모드를 쓰고, 없으면 평문 모드로 동작한다.
// CALLMANER_ENCODING=plain으로 강제 평문 전환도 가능하다(문제 발생 시 즉시 되돌리기 위함).
// egoroof-blowfish 4.x는 ESM 전용 배포(main이 dist/blowfish.mjs)라 top-level require()로
// 불러오면 로컬(Node 22, require(esm) 지원)에서는 되지만 Vercel 프로덕션 런타임에서는
// ERR_REQUIRE_ESM으로 매번 크래시했다(2026-08-05 실측 — /callmaner/sync 1분 폴링이 전부
// 실패해 콜마너 쪽 상태변경이 우리 시스템에 반영되지 않는 원인이었다). CommonJS 파일 안에서도
// 동적 import()는 Node 버전과 무관하게 항상 동작하므로, 최초 1회만 로드해 캐싄다.
//
// 실패하면 캐시를 지운다. 거부된 약속을 그대로 캐시하면 한 번의 일시적 실패가 프로세스 수명
// 내내 남아, 회복된 뒤에도 콜마너 암복호화가 통째로 죽는다(동기화·오더접수 전부). 세션
// 저장소에서 정확히 그 일이 있었다 — 부팅 순간의 끊김 하나로 모든 요청이 영구히 500이었고
// 재기동 말고는 길이 없었다(server.js의 createTableIfMissing 주석).
let blowfishModulePromise = null;
function loadBlowfishModule() {
  if (!blowfishModulePromise) {
    blowfishModulePromise = import('egoroof-blowfish');
    blowfishModulePromise.catch(() => { blowfishModulePromise = null; });
  }
  return blowfishModulePromise;
}

async function blowfishFor(key) {
  const { Blowfish } = await loadBlowfishModule();
  return new Blowfish(key, Blowfish.MODE.ECB, Blowfish.PADDING.NULL);
}

function callmanerCryptoKeys() {
  const requestKey = String(process.env.CALLMANER_REQUEST_KEY || '').trim();
  const responseKey = String(process.env.CALLMANER_RESPONSE_KEY || '').trim();
  return requestKey && responseKey ? { requestKey, responseKey } : null;
}

function callmanerEncoding() {
  if (String(process.env.CALLMANER_ENCODING || '').trim().toLowerCase() === 'plain') return 'plain';
  return callmanerCryptoKeys() ? 'encrypted' : 'plain';
}

// 응답은 평문 JSON이거나 Base64(Blowfish) 암호문이다 — 앞글자로 판별한다(JSON이면 '{').
// zero padding이라 복호화 결과 뒤에 0x00이 붙어 올 수 있어 제거한다(샘플의 trim()과 동일).
async function parseCallmanerResponseBody(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('콜마너 API 응답이 비어 있습니다.');
  if (raw.startsWith('{')) return JSON.parse(raw);

  const keys = callmanerCryptoKeys();
  if (!keys) {
    throw new Error('콜마너 API 응답이 암호문인데 복호화 키(CALLMANER_RESPONSE_KEY)가 설정되어 있지 않습니다. '
      + `앞부분: ${raw.slice(0, 60)}`);
  }
  const { Blowfish } = await loadBlowfishModule();
  const cipher = await blowfishFor(keys.responseKey);
  const decoded = cipher
    .decode(Buffer.from(raw, 'base64'), Blowfish.TYPE.STRING)
    .replace(/\0+$/, '')
    .trim();
  if (!decoded.startsWith('{')) {
    throw new Error(`콜마너 API 응답을 복호화했지만 JSON이 아닙니다: ${decoded.slice(0, 120)}`);
  }
  return JSON.parse(decoded);
}

async function callCallmaner(servlet, cmd, rq, { timeoutMs } = {}) {
  const baseUrl = process.env.CALLMANER_BASE_URL;
  if (!baseUrl) throw new Error('CALLMANER_BASE_URL 환경변수가 설정되어 있지 않습니다.');

  const envelope = { cmd, ver: '1', ts: String(Date.now()), tn: nextTn(), rq };
  const payload = JSON.stringify(envelope);

  let url;
  if (callmanerEncoding() === 'encrypted') {
    const cipher = await blowfishFor(callmanerCryptoKeys().requestKey);
    const cipherText = Buffer.from(cipher.encode(payload)).toString('base64');
    url = `${baseUrl}/external_v1/${servlet}.do?p=${encodeURIComponent(cipherText)}`;
  } else {
    url = `${baseUrl}/external_v1/${servlet}.do?t=${encodeURIComponent(payload)}`;
  }
  const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);

  // HTTP 단계 실패는 정의서의 rc가 아니지만, 원인이 콜마너 서버 쪽이라는 점은 같아서 화면에
  // 보여줄 코드로는 동일하게 취급한다(`HTTP 500` 형태로 구분 가능하게 남긴다).
  if (!res.ok) {
    const httpErr = new Error(`콜마너 API 응답 오류: HTTP ${res.status}`);
    httpErr.rc = `HTTP ${res.status}`;
    throw httpErr;
  }
  const decoded = await parseCallmanerResponseBody(await res.text());
  if (decoded.rc !== '00') {
    const err = new Error(`콜마너 API 오류: ${decoded.rc} ${decoded.rm || ''}`.trim());
    err.rc = decoded.rc;
    err.rm = decoded.rm;
    throw err;
  }
  return decoded;
}

// 후불만 콜마너 결제구분 2(후불)로 보내고, 나머지(현금/카드/계좌이체/착불)는 이미 우리 앱에서
// 결제가 끝난 것으로 보고 0(현금)으로 통일한다(사용자 확정 사항 — 콜마너는 즉시카드결제
// 코드가 없어 후불 계열 코드밖에 없다).
function callmanerPaymentCode(paymentMethodName) {
  return String(paymentMethodName || '').trim() === '후불' ? '2' : '0';
}

// 문서 예제값 "Ann" = 성별(A) + 스틱(n) + 탁송(y/n) 순서. 성별/스틱 선택 UI가 없어 항상
// 전체(A)/스틱아님(n)으로 고정하고, 탁송(y)만 order_type=dispatch일 때 켠다(사용자 확정 사항).
function callmanerDriverOption(orderType) {
  const tow = orderType === 'dispatch' ? 'y' : 'n';
  return `An${tow}`;
}

// 정의서상 memo(적요1)는 "최대100Byte제한, 후불접수시 짤릴 수 있음" — 한글은 UTF-8에서 3바이트라
// 33자 정도가 한계다. 서버가 잘라내거나 거부하기 전에 우리가 바이트 기준으로 안전하게 자른다.
function truncateBytes(text, maxBytes) {
  const s = String(text || '');
  if (Buffer.byteLength(s, 'utf8') <= maxBytes) return s;
  let out = '';
  for (const ch of s) {
    if (Buffer.byteLength(out + ch, 'utf8') > maxBytes) break;
    out += ch;
  }
  return out;
}

// 정의서: userHp = 요청단말번호 varchar 11 (예 01011112222 — 하이픈 없는 숫자).
// 콜마너 담당자 확인: 고객의 전화번호이므로 출발지 연락처를 우선 쓰고, 없으면 요청자(오더를
// 등록한 사용자) 연락처를 쓴다. 예전에는 지사 대표번호(branches.main_phone)를 보내서
// 서울지사의 경우 "12345" 5자리가 나갔다 — 통신 불가한 형식이라 규격 위반이었다.
function normalizeUserHp(candidates) {
  const digitsList = (candidates || []).map((v) => String(v || '').replace(/\D/g, '')).filter(Boolean);
  // 휴대폰/유선 번호로 성립하는 10~11자리를 우선 채택한다.
  const valid = digitsList.find((d) => d.length >= 10 && d.length <= 11);
  if (valid) return valid;
  // 유효한 게 하나도 없으면 있는 값이라도 보내서 콜마너가 E4[1008] [userHp]로 알려주게 한다
  // (조용히 빈 값을 보내면 원인 파악이 더 어렵다). varchar 11이라 길이는 잘라준다.
  return digitsList.length ? digitsList[0].slice(0, 11) : '';
}

// 정의서: lat varchar 9 / lng varchar 10 (예 37.487254 / 127.103169) — 소수점 6자리 형식이다.
// 카카오는 소수점 14자리까지 주므로 그대로 보내면 17~18자리로 규격을 크게 넘긴다(콜마너
// 담당자 지적 사항). 소수점 6자리면 오차가 약 0.1m라 배차 정확도에는 영향이 없다.
function formatCoord(value, maxLength) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '';
  let out = n.toFixed(6);
  // 정수부가 예상보다 길어도(방어) 규격 길이에 맞을 때까지 소수점을 줄인다.
  for (let digits = 6; digits >= 0 && out.length > maxLength; digits -= 1) out = n.toFixed(digits);
  return out;
}

const COORD_LAT_MAX = 9;
const COORD_LNG_MAX = 10;

function toReservationTime(reservedDate, reservedTime) {
  const d = String(reservedDate || '').replace(/-/g, '');
  const t = String(reservedTime || '').replace(':', '');
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return null;
  return `${d}${t}00`;
}

// OrderReceipt(오더접수)와 OrderModify(오더수정)는 정의서상 dep/arr/via/viaList/payment/
// price/memo/post_time/post_charge/driver_option/use_cash/use_cb/reservation_time 필드가
// 완전히 동일하다(userHp/providerId/conf_slip/status만 호출 종류별로 다름) — 두 함수가
// 공유하도록 분리했다.
// 적요1(memo)에 실어 보낼 문구. 차량번호를 맨 앞에 둔다(사용자 확정).
//
// 왜 적요에 싣나: 콜마너 오더접수(OrderReceipt)·오더수정(OrderModify) 요청 필드를 정의서
// v1.7에서 전수 확인했는데 차량번호/차종 칸이 아예 없다. 차량 관련 항목은 driver_option의
// `탁송(yn)` 플래그뿐이라 번호를 담을 수 없다. 적요 말고는 전달할 칸이 없다.
//
// **적요1은 기사 앱에 `기사메모`로 그대로 노출된다**(운영 확인). 정의서에는 이 사실이 적혀
// 있지 않다 — 그래서 여기 남긴다. 이 칸에 넣는 것은 전부 기사가 읽는다는 뜻이므로, 내부
// 참고용 문구를 memo_customer에 넣지 않도록 주의해야 한다.
//
// 왜 맨 앞인가: 정의서가 적요1을 "최대100Byte제한, 후불접수시 짤릴 수 있음"이라고 못박는다.
// 뒤에 붙이면 잘려나가는 쪽이 차량번호가 되고, 그러면 기사가 현장에서 어느 차인지 알 수 없다.
//
// 본문은 요약본(memo_driver_brief)을 우선 쓴다 — 접수 시점에 100Byte에 맞춰 줄여둔 것이다
// (lib/intakeMemoSplit.js). 요약이 없으면(웹 수기 등록, 마이그레이션 전) 원문을 쓰고 아래
// truncateBytes가 자른다. 원문 자체는 orders.memo_customer에 그대로 남아 우리 화면과 기사
// 앱에서 전부 보인다 — 줄이는 것은 콜마너로 나가는 이 한 칸뿐이다.
// 우편발송(등기) 요청 건이면 인수증 업로드 링크를 차량번호 바로 뒤에 넣는다.
//
// 콜마너로 배차된 기사는 우리 기사 앱을 쓰지 않아서, 이 한 줄이 등기번호·인수증을 받을 유일한
// 통로다. 차량번호 다음에 두는 이유는 잘림 순서다 — 이 칸은 100Byte라 뒤쪽부터 사라지는데,
// 링크가 잘리면 아예 못 누른다(기사 전달사항은 잘려도 앞부분은 읽힌다).
//
// 링크가 38Byte라 기사 전달사항에 남는 자리가 15글자쯤으로 줄어든다. 우편발송 요청 건에만
// 붙으므로 다른 오더는 예전 그대로다.
function memoWithVehicle(order) {
  const plate = String(order.vehicle_number || '').trim();
  const rest = String(order.memo_driver_brief || order.memo_customer || '').trim();
  const receipt = order.postal_requested ? receiptMemoLine(order.receipt_upload_token) : null;

  const head = [plate || null, receipt].filter(Boolean).join(' / ');
  if (!head) return rest;
  // 이미 맨 앞에 있으면 그대로 둔다 — 고객이 요청사항 첫머리에 직접 적는 경우가 있다.
  if (!receipt && plate && rest.startsWith(plate)) return rest;
  return rest ? `${head} / ${rest}` : head;
}

// 콜마너에 거는 금액. 배차 요금이 정해져 있으면 그것을, 없으면 0을 보낸다.
// 계약 요금으로 되돌리지 않는다 — 그러면 두 값을 나눈 의미가 없어지고, 계약 단가가 그대로
// 기사에게 노출된다.
function dispatchPrice(order) {
  const v = Number(order.dispatch_fare_amount);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

async function buildOrderPayload(order, paymentMethodName, waypoints) {
  if (!order.origin_lat || !order.origin_lon || !order.origin_sido || !order.origin_sigugun || !order.origin_dong) {
    throw new Error('출발지 좌표/행정구역 정보가 없어 콜마너 오더접수/수정을 보낼 수 없습니다.');
  }

  const rq = {
    dep: {
      a1: order.origin_sido,
      a2: order.origin_sigugun,
      a3: order.origin_dong,
      // poi/memo도 정의서상 varchar 50이라 긴 주소가 그대로 나가지 않게 자른다.
      poi: truncateBytes(order.origin_address, 50),
      memo: truncateBytes(order.origin_address_detail || order.origin_address, 50),
      lat: formatCoord(order.origin_lat, COORD_LAT_MAX),
      lng: formatCoord(order.origin_lon, COORD_LNG_MAX),
    },
    payment: callmanerPaymentCode(paymentMethodName),
    // 콜마너에는 **배차 요금**을 건다 — 고객에게 청구하는 계약 요금(fare_amount)이 아니다(정책).
    // 두 값이 하나였을 때는 계약 단가를 올리지 않고 배차만 서두르는 것이 불가능했다.
    // 배차 요금표를 등록하지 않은 지사는 값이 비어 있고, 그때는 예전과 같이 0이 나간다 —
    // 없는 값을 지어내지 않는다(lib/branchPolicy.js calculateDispatchFare).
    price: String(dispatchPrice(order)),
    memo: truncateBytes(memoWithVehicle(order), 100),
    // 적요2 — 기사에게는 보이지 않고 배차·정산 담당자만 보는 칸이다(운영 확인). 기사가 알
    // 필요가 없는 요청(기사 지정 요청, 정산·세금계산서, 사내 처리 방식)을 여기로 보낸다.
    // 정의서상 varchar 100이라 적요1과 같은 기준으로 자른다.
    memo2: truncateBytes(order.memo_billing, 100),
    post_time: callmanerPaymentCode(paymentMethodName) === '2' ? '1' : '0',
    post_charge: callmanerPaymentCode(paymentMethodName) === '2' ? String(dispatchPrice(order)) : '0',
    driver_option: callmanerDriverOption(order.order_type),
  };

  // price는 "요금 총액"이고 use_cash/use_cb는 "그 요금을 무엇으로 얼마 결제하는지"다(정의서
  // 오더접수 use_cash/use_card/use_mile/use_cb). 그동안 use_* 를 하나도 보내지 않아서 콜마너
  // 입장에서는 "요금은 2만원인데 현금 수령액 0원" = 미수금을 지사가 부담하는 콜로 읽혔고,
  // 그래서 현금 오더인데도 "지사캐시가 부족하여 후불콜을 발주할 수 없습니다"로 거부당한 것으로
  // 보인다(콜마너 담당자 확인: 현금 오더는 지사캐시가 부족해도 등록된다). 결제방식에 맞춰
  // 결제수단별 금액을 명시한다 — 현금은 use_cash, 후불은 use_cb(법인후불).
  const paidAmount = String(dispatchPrice(order));
  if (callmanerPaymentCode(paymentMethodName) === '2') rq.use_cb = paidAmount;
  else rq.use_cash = paidAmount;

  if (order.destination_lat && order.destination_lon && order.destination_sido) {
    rq.arr = {
      a1: order.destination_sido,
      a2: order.destination_sigugun,
      a3: order.destination_dong,
      poi: truncateBytes(order.destination_address, 50),
      memo: truncateBytes(order.destination_address_detail || order.destination_address, 50),
      lat: formatCoord(order.destination_lat, COORD_LAT_MAX),
      lng: formatCoord(order.destination_lon, COORD_LNG_MAX),
    };
  }

  // 경유지(viaList) — 정의서 오더접수의 via/viaList/via_count. 하위 필드는 전부 ◐(선택적필수)
  // 이지만 type이 G/N/M이면 lat/lng는 필수라, 좌표가 있는 경유지만 보낸다. 행정구역(a1~a3)은
  // order_waypoints에 컬럼이 없어 저장돼 있지 않으므로 보낼 때 좌표로 역지오코딩해서 채우고,
  // 조회가 실패하면 그 항목만 빼고 좌표/지명으로 보낸다(a1~a3는 필수가 아님).
  // type='M'(맵선택) — 사용자가 지도/주소검색 결과로 확정한 위치라 가장 가깝다.
  const usableWaypoints = (waypoints || []).filter((w) => w.lat && w.lon);
  if (usableWaypoints.length > 0) {
    rq.via = 'y';
    rq.via_count = String(usableWaypoints.length);
    rq.viaList = await Promise.all(usableWaypoints.map(async (w, i) => {
      const via = {
        seq: String(i + 1),
        type: 'M',
        poi: truncateBytes(w.address, 50),
        memo: truncateBytes(w.address_detail || w.address, 50),
        lat: formatCoord(w.lat, COORD_LAT_MAX),
        lng: formatCoord(w.lon, COORD_LNG_MAX),
      };
      const region = await lookupRegion(w.lat, w.lon);
      if (region && region.sido) {
        via.a1 = region.sido;
        via.a2 = region.sigugun;
        via.a3 = region.dong;
      }
      return via;
    }));
  }

  const reservationTime = toReservationTime(order.reserved_date, order.reserved_time);
  if (reservationTime) rq.reservation_time = reservationTime;

  return rq;
}

// order: orders 테이블 row(+payment_methods.name을 paymentMethodName으로 조인해서 넘겨받음)
// branch: branches 테이블 row(callmaner_provider_id 포함)
async function orderReceipt(order, branch, paymentMethodName, waypoints) {
  const rq = await buildOrderPayload(order, paymentMethodName, waypoints);
  // 출발지 연락처 > 요청자 연락처 순으로 고객 전화번호를 보낸다(normalizeUserHp 주석 참고).
  rq.userHp = normalizeUserHp([order.origin_contact, order.requester_phone]);
  rq.providerId = buildProviderId(branch);
  // 정의서 오더접수 `status`(접수상태) — "0-접수, 5대기, 4문의등, R 예약". 오더 등록(생성)
  // 시점에 바로 콜마너로 나가므로, 담당자가 검토하기도 전에 곧바로 배차 대상이 되지 않도록
  // 항상 대기(5)로 등록한다(사용자 확정 사항) — 이후 담당자가 준비되면 콜마너 쪽에서
  // 직접 접수 처리하거나, 정식 대기해제 API(OrderStanbyRelease)를 붙이면 된다.
  rq.status = '5';

  const result = await callCallmaner('order', 'OrderReceipt', rq);
  // 문서 "나. 개발원칙"의 예제는 rc/reg_cslip/regdate를 최상위에 바로 두지만, "사. 인터페이스상세"
  // 절은 rs.reg_cslip/rs.reg_date로 감싸서 정의한다 — 실제 서버 응답이 둘 중 어느 쪽이든 읽히도록 둘 다 허용.
  const rs = result.rs || result;
  return { confSlip: rs.reg_cslip, regDate: rs.reg_date || rs.regdate, webUrl: rs.web_url };
}

// 오더수정(OrderModify) — 이미 콜마너에 접수된(conf_slip 있는) 오더의 내용(주소/요금/메모 등)을
// 우리 쪽에서 고쳤을 때 실시간으로 반영한다. 문서상 "접수된 오더를 수정한다(어플접수건만
// 가능)" — 우리가 conf_slip을 갖고 있는 오더는 전부 우리 OrderReceipt로 등록한 것이므로
// 항상 해당된다. status는 일부러 보내지 않는다(◐, 선택) — 이 호출의 목적은 "내용 수정"이지
// 상태를 건드리는 게 아니라서, 콜마너 쪽 현재 상태(배차/대기 등)를 그대로 유지시킨다.
async function orderModify(order, branch, paymentMethodName, waypoints, confSlip) {
  const rq = await buildOrderPayload(order, paymentMethodName, waypoints);
  rq.userHp = normalizeUserHp([order.origin_contact, order.requester_phone]);
  rq.providerId = buildProviderId(branch);
  rq.conf_slip = confSlip;

  const result = await callCallmaner('order', 'OrderModify', rq);
  const rs = result.rs || result;
  return { confSlip: rs.reg_cslip || confSlip, regDate: rs.reg_date || rs.regdate };
}

// 콜마너는 lastUpDate를 "전날까지"만 받는다 — 그보다 오래된 값을 보내면
// "NG 날짜는 최대 전날까지 가능합니다"로 거부한다(실측 2026-08-24).
//
// 이게 실제로 서비스를 멈췄다: 동기화가 2026-08-17에 마지막으로 성공한 뒤 저장된 커서가 그대로
// 남았고, 그 값이 하루를 넘긴 순간부터 매분 이 호출이 실패했다. 그리고 그 실패가 같은 try 안의
// 단건조회(syncOrdersByConfSlip)까지 건너뛰게 만들어, 배차·운행시작·완료 감지와 통보가 7일간
// 전부 멈춰 있었다.
//
// 커서가 오래됐으면 전날로 당겨서 보낸다. 잃는 것은 없다 — 이 크론은 매분 돌기 때문에 하루치
// 변경만 되짚어도 충분하고, 우리 접수건은 애초에 이 호출로 안 잡혀서(아래 orderHistory 주석)
// conf_slip 단건조회가 실제 감지를 맡는다.
const ALL_STATUS_MAX_LOOKBACK_MS = 23 * 60 * 60 * 1000;

function clampLastUpDate(lastUpDate) {
  const raw = String(lastUpDate || '').trim();
  if (!raw || raw === '0') return '0'; // 처음부터 조회 — 콜마너가 받아준다(실측)
  const kstNowMs = Date.now() + 9 * 60 * 60 * 1000;
  const floor = new Date(kstNowMs - ALL_STATUS_MAX_LOOKBACK_MS)
    .toISOString().slice(0, 19).replace(/[-:T]/g, '');
  // YYYYMMDDHHmmss 형식이라 문자열 비교가 시간 비교와 같다.
  return raw < floor ? floor : raw;
}

async function orderAllStatus(branch, lastUpDate) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    lastUpDate: clampLastUpDate(lastUpDate),
  };
  const result = await callCallmaner('order', 'OrderAllStatus', rq);
  const rs = result.rs || result;
  return {
    orderList: rs.orderList || [],
    lastUpDate: rs.lastUpDate || lastUpDate || '0',
  };
}

// 오더리스트조회(OrderHistory, 정의서 4.0) — 한 연락처(userHp)로 접수된 오더를 한 번에 받는다.
// 페이지 파라미터 이름은 정의서 기준 page / page_size다(pageSize로 보내면 무시되고 기본 10건이
// 아니라 1건만 왔다). 응답 목록은 rs.orderList가 아니라 rs.data이며, 상태는 코드가 아니라 한글
// 문자열("대기"/"접수"/"취소"…)로 온다.
//
// 상태 폴링을 OrderAllStatus 대신 이걸로 하는 이유: OrderAllStatus는 우리가 OrderReceipt로
// 접수한 건을 돌려주지 않고(실측), 돌려주는 건들도 status_code가 빈 문자열로 온다. OrderHistory는
// 같은 userHp로 우리 접수건이 정상 조회된다.
async function orderHistory(branch, userHp, options) {
  const opts = options || {};
  const rq = {
    userHp: normalizeUserHp([userHp, branch.main_phone]),
    providerId: buildProviderId(branch),
    page: String(opts.page || 1),
    page_size: String(opts.pageSize || 50),
  };
  const result = await callCallmaner('order', 'OrderHistory', rq);
  const rs = result.rs || result;
  const list = Array.isArray(rs.data) ? rs.data : [];
  return {
    totalCount: Number(rs.total_count) || list.length,
    orders: list.map((o) => ({
      confSlip: String(o.conf_slip || '').trim(),
      status: o.status || '',
      price: o.price != null && o.price !== '' ? Number(o.price) : null,
      regDate: o.reg_date || '',
      endTime: o.end_time || '',
      wkInfo: o.wk_info || '',
    })),
  };
}

// 단건 상태조회(OrderInfo) — conf_slip만으로 조회되며 userHp 스코프를 타지 않는다(실측).
// 폴링용 OrderAllStatus가 userHp(요청단말번호)에 매인 결과만 돌려주는 것과 달리, 우리가 접수한
// 오더의 현재 상태를 확실히 확인할 수 있는 경로다.
async function orderInfo(branch, confSlip, userHp) {
  const rq = {
    userHp: normalizeUserHp([userHp, branch.main_phone]),
    providerId: buildProviderId(branch),
    conf_slip: String(confSlip || '').trim(),
  };
  const result = await callCallmaner('order', 'OrderInfo', rq);
  const rs = result.rs || result;
  return {
    confSlip: rs.conf_slip || confSlip,
    status: rs.status || '',
    baechaStatus: rs.baecha_status || '',
    statusTime: rs.status_time || '',
    price: rs.price != null ? Number(rs.price) : null,
    wkInfo: rs.wk_info || '',
  };
}

// wk_name(OrderAllStatus)/wk_info(WkContactSearch) 공통 포맷: "사번*이름" (예: "123*홍길동").
// '*'가 없으면(문서에 없는 예외) 전체를 이름으로 본다.
function parseDriverNameField(raw) {
  const s = String(raw || '').trim();
  if (!s) return { sabun: '', name: '' };
  const idx = s.indexOf('*');
  if (idx === -1) return { sabun: '', name: s };
  return { sabun: s.slice(0, idx).trim(), name: s.slice(idx + 1).trim() };
}

// 기사연락처조회(WkContactSearch) — OrderAllStatus 폴링 응답에는 기사 이름(wk_name)만 있고
// 연락처가 없어서, 상태가 배차(status_code=02)로 바뀐 시점에 conf_slip 기준으로 한 번 더
// 호출해 기사 가상번호(wkVphone)를 받아온다. wkVphone은 문서상 "필수아님"이라 없을 수 있다.
async function wkContactSearch(branch, confSlip) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    conf_slip: confSlip,
  };
  const result = await callCallmaner('order', 'WkContactSearch', rq);
  const rs = result.rs || result;
  const parsed = parseDriverNameField(rs.wk_info);
  return {
    name: parsed.name,
    sabun: rs.wk_sabun || parsed.sabun,
    phone: rs.wkVphone || '',
    insurance: rs.wk_ins || '',
  };
}

// 탁송사진 이미지(ConsPicture) — 운행전/운행후 사진 링크를 각각 받는다.
//
// 이것만 servlet이 order가 아니라 picture다(정의서 "▣ 탁송사진 이미지 (/picture.do)").
// callCallmaner는 servlet 이름을 경로에 그대로 끼워 넣으므로 별도 배선이 필요 없다.
//
// 정의서 주석: "탁송콜 완료시 운행전" — 완료 시점에 채워진다. 그래서 운행시작 시점에 부르면
// before만 있거나 아무것도 없을 수 있고, 그건 오류가 아니다(빈 배열로 돌려준다).
//
// 응답은 rs.before / rs.after 각각의 리스트이고 항목의 링크 필드명은 picLink다. 링크는
// 콜마너 CDN(web-api-pic-vault.callmaner.com)을 가리키며 우리 쪽으로 복사하지 않는다(사용자 확정).
// 항목 이름을 실어 주는지 확인하기 위해, 링크 말고 다른 칸이 있으면 한 번 기록한다.
//
// 지금 화면은 순번으로 항목을 정한다(lib/callmanerPhotos.js PHOTO_LABELS) — 1번 전면,
// 13번 계기판만 동작으로 검증됐고 나머지는 "3번"으로 둔다. 콜마너가 이름을 함께 준다면
// 그걸 쓰는 편이 낫다(순서가 바뀌어도 따라간다). 정의서에는 picLink만 적혀 있지만
// 실응답에 더 있을 수 있어, 추측하지 않고 실제 응답에서 알아낸다.
let loggedPictureKeys = false;
function notePictureKeys(list) {
  if (loggedPictureKeys || !Array.isArray(list)) return;
  const sample = list.find((it) => it && typeof it === 'object');
  if (!sample) return;
  loggedPictureKeys = true;
  const keys = Object.keys(sample);
  const extra = keys.filter((k) => !['picLink', 'pic_link', 'url'].includes(k));
  console.log(`[콜마너 탁송사진] 응답 필드: ${keys.join(', ')}`
    + (extra.length ? ` — 링크 외 ${extra.length}개(항목명일 수 있음)` : ' — 링크뿐'));
}

// 링크와, 있으면 항목 이름. 이름 후보 필드는 정의서에 없어 흔한 이름만 훑는다 —
// 없으면 null이고 화면은 순번으로 떨어진다.
function pictureItems(list) {
  if (!Array.isArray(list)) return [];
  notePictureKeys(list);
  return list
    .map((item) => {
      if (typeof item === 'string') return { url: item.trim(), label: null };
      const url = String((item && (item.picLink || item.pic_link || item.url)) || '').trim();
      const label = String(
        (item && (item.picName || item.pic_name || item.picTitle || item.title || item.name || item.gubun)) || ''
      ).trim() || null;
      return { url, label };
    })
    .filter((it) => it.url);
}

function pictureLinks(list) {
  return pictureItems(list).map((it) => it.url);
}

async function consPicture(branch, confSlip) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    conf_slip: confSlip,
  };
  const result = await callCallmaner('picture', 'ConsPicture', rq);
  const rs = result.rs || result;
  return {
    before: pictureLinks(rs.before),
    after: pictureLinks(rs.after),
    // 항목 이름이 함께 오면 저장한다(lib/callmanerPhotos.js savePhotos).
    beforeItems: pictureItems(rs.before),
    afterItems: pictureItems(rs.after),
  };
}

// 오더취소(OrderCancel) — "접수된 오더를 취소한다(어플접수건만 가능)". 우리가 conf_slip을
// 가진 오더는 전부 우리 OrderReceipt로 등록한 것이라 항상 해당된다.
//
// ⚠ 이 API는 **취소를 실제로 해놓고도 NG를 돌려주는 경우가 있다.**
// 실측(2026-08-11): 당일 즉시 오더를 접수한 직후 취소했더니
//   rc=NG "이전 결제정보를 불러올 수 없습니다. (당일오더만 취소가능)"
// 가 왔는데, 이어서 OrderInfo로 조회하니 status="취소"였다. 예약 건이든 당일 건이든 같았고,
// 공통점은 요금 0원(우리 자동접수는 요금을 0으로 넣는다)이라 결제정보 롤백 단계에서 나는
// 메시지로 보인다 — 취소 자체는 성공한 뒤다.
//
// 이 NG를 그대로 실패로 올리면 상담원 화면에는 "취소 실패"가 뜨는데 콜마너에서는 이미 취소된
// 상태다. 담당자가 다시 취소를 누르거나 콜마너에 전화하게 되고, 우리 DB와 콜마너 상태도
// 어긋난 채 남는다(실제로 몇 주간 "취소가 안 된다"고 보고돼 온 현상이 전부 이것이었다).
//
// 그래서 NG를 무조건 삼키지 않고 **실제 상태를 한 번 더 확인**한다. 정말 취소됐으면 성공으로
// 보고, 아니면 원래 오류를 그대로 올린다 — 확인 없이 성공 처리하면 취소되지 않은 오더를
// 취소된 것으로 표시하는 반대 방향의 사고가 난다.
// 띄어쓰기가 응답마다 다르다("당일오더만 취소가능" / "당일오더만 취소 가능합니다") — 공백을
// 느슨하게 본다. 넓게 잡아도 안전하다: 확인 결과가 "취소"가 아니면 원래 오류를 그대로 올린다.
const CANCEL_PAYMENT_NG_RE = /이전\s*결제정보를\s*불러올\s*수\s*없습니다|당일오더만\s*취소\s*가능/;

async function orderCancel(branch, confSlip, reason) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    conf_slip: confSlip,
  };
  if (reason) rq.reason = truncateBytes(reason, 32);

  try {
    return await callCallmaner('order', 'OrderCancel', rq);
  } catch (e) {
    if (!CANCEL_PAYMENT_NG_RE.test(String(e.rm || e.message || ''))) throw e;

    let confirmed = null;
    try {
      const info = await orderInfo(branch, confSlip, branch.main_phone);
      confirmed = String((info && info.status) || '').trim();
    } catch (infoErr) {
      // 확인 자체가 실패하면 판단 근거가 없다 — 원래 오류를 그대로 올린다.
      console.error(`콜마너 취소 결과 확인 실패 (conf_slip=${confSlip}):`, infoErr.message);
      throw e;
    }

    if (confirmed === '취소') {
      console.warn(`콜마너 OrderCancel이 NG를 돌려줬지만 실제로는 취소됨 — 성공으로 처리 (conf_slip=${confSlip}, rm=${e.rm || e.message})`);
      return { rc: '00', rm: 'CANCELLED_VERIFIED', rs: { conf_slip: confSlip, status: confirmed } };
    }
    throw e;
  }
}

// 오더대기(OrderStanby) — 접수 상태의 오더를 대기 상태로 되돌린다. curStatus(◐)는 정의서상
// "0:접수,1:배차,2:완료,4:문의,5:대기,8:취소" 중 변경 전 현재상태 — 우리가 마지막으로 폴링해
// 저장해둔 콜마너 상태코드(callmaner_status_code)를 그대로 넘기고, 모르면 접수(0)로 가정한다.
async function orderStanby(branch, confSlip, curStatus) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    conf_slip: confSlip,
    curStatus: curStatus || '0',
    status: '5',
  };
  return callCallmaner('order', 'OrderStanby', rq);
}

// 오더대기해제(OrderStanbyRelease) — 대기 상태의 오더를 접수 상태로 되돌린다(파라미터 없음,
// 정의서상 conf_slip만 필요).
async function orderStanbyRelease(branch, confSlip) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    conf_slip: confSlip,
  };
  return callCallmaner('order', 'OrderStanbyRelease', rq);
}

module.exports = {
  // 검사에서 직접 부른다(scripts/check-callmaner-lastupdate.js)
  clampLastUpDate,
  STATUS_CODE_TO_LOCAL_STATUS,
  STATUS_TEXT_TO_LOCAL_STATUS,
  buildProviderId,
  callCallmaner,
  callmanerPaymentCode,
  callmanerDriverOption,
  truncateBytes,
  orderReceipt,
  orderModify,
  orderAllStatus,
  orderHistory,
  orderInfo,
  normalizeUserHp,
  orderCancel,
  orderStanby,
  orderStanbyRelease,
  parseDriverNameField,
  wkContactSearch,
  consPicture,
  pictureLinks,
  // 검사용 — 적요1 조합 규칙은 잘림과 직결돼서 따로 확인한다(scripts/check-callmaner-memo.js).
  memoWithVehicle,
  buildOrderPayload,
};
