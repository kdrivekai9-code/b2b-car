// 콜마너 외부연동 API 클라이언트 — "콜마너 외부연동 인터페이스 정의서"(v3.0) 기준.
// 문서 "나. 개발원칙 4"는 요청/응답을 base64 인코딩하라고 되어 있지만, 실제 운영 서버
// (api.cd1.kr) 상대 smoke test(2026-08-04) 결과 이는 사실이 아니다 — 서버는 `t` 파라미터를
// base64가 아니라 **평문 JSON 그대로**(URL 인코딩만) 기대한다. base64로 보냈더니
// `{"rc":"E0","rm":"...syntax error, expect {, actual error"}`로 거부당하는 것으로 확인됨 —
// 문서보다 이 실측 결과를 신뢰해서 평문 JSON으로 구현한다. 응답도 gzip(fetch가 자동 압축해제)
// 이지 base64가 아닌 평문 JSON이었다. 인증은 API key가 아니라 IP 화이트리스트 방식이라고
// 문서에 나와 있지만, 실제로는 IP 등록 없이도 요청이 서버까지 도달하는 것으로 확인됨(2026-08-04).

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

  if (!res.ok) throw new Error(`콜마너 API 응답 오류: HTTP ${res.status}`);
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

function toReservationTime(reservedDate, reservedTime) {
  const d = String(reservedDate || '').replace(/-/g, '');
  const t = String(reservedTime || '').replace(':', '');
  if (!/^\d{8}$/.test(d) || !/^\d{4}$/.test(t)) return null;
  return `${d}${t}00`;
}

// order: orders 테이블 row(+payment_methods.name을 paymentMethodName으로 조인해서 넘겨받음)
// branch: branches 테이블 row(callmaner_provider_id 포함)
async function orderReceipt(order, branch, paymentMethodName) {
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
    memo: order.memo_customer || '',
    post_time: callmanerPaymentCode(paymentMethodName) === '2' ? '1' : '0',
    post_charge: callmanerPaymentCode(paymentMethodName) === '2' ? String(order.fare_amount || 0) : '0',
    driver_option: callmanerDriverOption(order.order_type),
  };

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
  orderReceipt,
  orderAllStatus,
};
