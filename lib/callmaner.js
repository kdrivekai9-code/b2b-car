// 콜마너 외부연동 API 클라이언트 — "콜마너 외부연동 인터페이스 정의서"(v3.0) 기준.
// 문서 "나. 개발원칙 4"는 요청/응답을 base64 인코딩하라고 되어 있지만, 실제 운영 서버
// (api.cd1.kr) 상대 smoke test(2026-08-04) 결과 이는 사실이 아니다 — 서버는 `t` 파라미터를
// base64가 아니라 **평문 JSON 그대로**(URL 인코딩만) 기대한다. base64로 보냈더니
// `{"rc":"E0","rm":"...syntax error, expect {, actual error"}`로 거부당하는 것으로 확인됨 —
// 문서보다 이 실측 결과를 신뢰해서 평문 JSON으로 구현한다. 응답도 gzip(fetch가 자동 압축해제)
// 이지 base64가 아닌 평문 JSON이었다. 인증은 API key가 아니라 IP 화이트리스트 방식이라고
// 문서에 나와 있지만, 실제로는 IP 등록 없이도 요청이 서버까지 도달하는 것으로 확인됨(2026-08-04).

const { lookupRegion } = require('./kakaoRegion');

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

async function callCallmaner(servlet, cmd, rq, { timeoutMs } = {}) {
  const baseUrl = process.env.CALLMANER_BASE_URL;
  if (!baseUrl) throw new Error('CALLMANER_BASE_URL 환경변수가 설정되어 있지 않습니다.');

  const envelope = { cmd, ver: '1', ts: String(Date.now()), tn: nextTn(), rq };
  const t = JSON.stringify(envelope);

  const url = `${baseUrl}/external_v1/${servlet}.do?t=${encodeURIComponent(t)}`;
  const res = await fetchWithTimeout(url, { method: 'GET' }, timeoutMs);

  // HTTP 단계 실패는 정의서의 rc가 아니지만, 원인이 콜마너 서버 쪽이라는 점은 같아서 화면에
  // 보여줄 코드로는 동일하게 취급한다(`HTTP 500` 형태로 구분 가능하게 남긴다).
  if (!res.ok) {
    const httpErr = new Error(`콜마너 API 응답 오류: HTTP ${res.status}`);
    httpErr.rc = `HTTP ${res.status}`;
    throw httpErr;
  }
  const decoded = await res.json();
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

// 정의서 오더접수 `status`(접수상태) — "0-접수, 5대기, 4문의등, R 예약". 로컬 오더 상태를
// 그대로 콜마너 접수상태로 넘겨서, 아직 검토 중인 '대기' 오더가 콜마너에서도 대기로 들어가게
// 한다(바로 배차 대상이 되지 않음). 매핑이 없는 상태는 보내지 않고 콜마너 기본값(접수)에 맡긴다.
const LOCAL_STATUS_TO_CALLMANER_STATUS = {
  '접수': '0',
  '접수(배차중)': '0',
  '대기': '5',
  '대기(확인중)': '5',
  '문의': '4',
};

function callmanerStatusCode(localStatus) {
  return LOCAL_STATUS_TO_CALLMANER_STATUS[String(localStatus || '').trim()] || null;
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

function toReservationTime(reservedDate, reservedTime) {
  const d = String(reservedDate || '').replace(/-/g, '');
  const t = String(reservedTime || '').replace(':', '');
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return null;
  return `${d}${t}00`;
}

// order: orders 테이블 row(+payment_methods.name을 paymentMethodName으로 조인해서 넘겨받음)
// branch: branches 테이블 row(callmaner_provider_id 포함)
async function orderReceipt(order, branch, paymentMethodName, waypoints) {
  if (!order.origin_lat || !order.origin_lon || !order.origin_sido || !order.origin_sigugun || !order.origin_dong) {
    throw new Error('출발지 좌표/행정구역 정보가 없어 콜마너 오더접수를 보낼 수 없습니다.');
  }

  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    dep: {
      a1: order.origin_sido,
      a2: order.origin_sigugun,
      a3: order.origin_dong,
      poi: order.origin_address || '',
      memo: order.origin_address_detail || order.origin_address || '',
      lat: String(order.origin_lat),
      lng: String(order.origin_lon),
    },
    payment: callmanerPaymentCode(paymentMethodName),
    price: String(order.fare_amount || 0),
    memo: truncateBytes(order.memo_customer, 100),
    post_time: callmanerPaymentCode(paymentMethodName) === '2' ? '1' : '0',
    post_charge: callmanerPaymentCode(paymentMethodName) === '2' ? String(order.fare_amount || 0) : '0',
    driver_option: callmanerDriverOption(order.order_type),
  };

  // price는 "요금 총액"이고 use_cash/use_cb는 "그 요금을 무엇으로 얼마 결제하는지"다(정의서
  // 오더접수 use_cash/use_card/use_mile/use_cb). 그동안 use_* 를 하나도 보내지 않아서 콜마너
  // 입장에서는 "요금은 2만원인데 현금 수령액 0원" = 미수금을 지사가 부담하는 콜로 읽혔고,
  // 그래서 현금 오더인데도 "지사캐시가 부족하여 후불콜을 발주할 수 없습니다"로 거부당한 것으로
  // 보인다(콜마너 담당자 확인: 현금 오더는 지사캐시가 부족해도 등록된다). 결제방식에 맞춰
  // 결제수단별 금액을 명시한다 — 현금은 use_cash, 후불은 use_cb(법인후불).
  const paidAmount = String(order.fare_amount || 0);
  if (callmanerPaymentCode(paymentMethodName) === '2') rq.use_cb = paidAmount;
  else rq.use_cash = paidAmount;

  const statusCode = callmanerStatusCode(order.status);
  if (statusCode) rq.status = statusCode;

  if (order.destination_lat && order.destination_lon && order.destination_sido) {
    rq.arr = {
      a1: order.destination_sido,
      a2: order.destination_sigugun,
      a3: order.destination_dong,
      poi: order.destination_address || '',
      memo: order.destination_address_detail || order.destination_address || '',
      lat: String(order.destination_lat),
      lng: String(order.destination_lon),
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
        lat: String(w.lat),
        lng: String(w.lon),
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

  const result = await callCallmaner('order', 'OrderReceipt', rq);
  // 문서 "나. 개발원칙"의 예제는 rc/reg_cslip/regdate를 최상위에 바로 두지만, "사. 인터페이스상세"
  // 절은 rs.reg_cslip/rs.reg_date로 감싸서 정의한다 — 실제 서버 응답이 둘 중 어느 쪽이든 읽히도록 둘 다 허용.
  const rs = result.rs || result;
  return { confSlip: rs.reg_cslip, regDate: rs.reg_date || rs.regdate, webUrl: rs.web_url };
}

async function orderAllStatus(branch, lastUpDate) {
  const rq = {
    userHp: String(branch.main_phone || '').trim(),
    providerId: buildProviderId(branch),
    lastUpDate: lastUpDate || '0',
  };
  const result = await callCallmaner('order', 'OrderAllStatus', rq);
  const rs = result.rs || result;
  return {
    orderList: rs.orderList || [],
    lastUpDate: rs.lastUpDate || lastUpDate || '0',
  };
}

module.exports = {
  STATUS_CODE_TO_LOCAL_STATUS,
  buildProviderId,
  callCallmaner,
  callmanerPaymentCode,
  callmanerDriverOption,
  callmanerStatusCode,
  truncateBytes,
  orderReceipt,
  orderAllStatus,
};
