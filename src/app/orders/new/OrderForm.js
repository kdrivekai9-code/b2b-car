'use client';

import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import AddressField, { resolveRegion } from './AddressField';
import RouteMap from './RouteMap';
import RouteCalculator from './RouteCalculator';
import OrderSidePanel from '../[id]/OrderSidePanel';
import ExtraCostSection from './ExtraCostSection';
// 적요1 100Byte 예산 계산 — 서버와 같은 모듈을 쓴다(lib/memoBudget.js).
// 화면이 따로 세면 "여기서는 들어간다는데 실제로는 잘리는" 상태가 된다.
import memoBudgetLib from '../../../../lib/memoBudget';

// Submits to the exact same POST /orders the legacy form.ejs uses, with the exact same
// field names and urlencoded wire format (verified directly against the live endpoint).
// Still deliberately NOT implemented in this slice (see docs/ai-stage-2-checklist.md for
// the disclosed scope trim): vehicle-type autocomplete, registered-address (favorites)
// picker beyond a simple list.

const DELIVERY_BUFFER_SECONDS = 30 * 60;
const DELIVERY_RESERVATION_MEMO_PREFIX = '일시:';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function getLastDayOfMonth(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 31;
  return new Date(y, m, 0).getDate();
}

function roundDateToNearestTenMinutes(dt) {
  const roundedMs = Math.round(dt.getTime() / 600000) * 600000;
  return new Date(roundedMs);
}

function formatDeliveryReservationMemoDateTime(dt) {
  return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}시${pad2(dt.getMinutes())}분 도착요망`;
}

// 메모 텍스트에서 기존 "**도착지 예약**: ..." 줄을 항상 먼저 제거하고, 배송기준일 때만
// 새 값으로 다시 붙인다 — 멱등이라 사용자가 다른 줄에 적은 내용은 절대 건드리지 않는다.
function deriveMemoWithReservationLine(currentMemo, isDeliveryBasis, deliveryDateTime) {
  const hasMemo = String(currentMemo || '').trim().length > 0;
  const rawLines = hasMemo ? String(currentMemo).split(/\r?\n/) : [];
  const keptLines = rawLines.filter((line) => String(line || '').trim().indexOf(DELIVERY_RESERVATION_MEMO_PREFIX) !== 0);
  if (isDeliveryBasis && deliveryDateTime && !Number.isNaN(deliveryDateTime.getTime())) {
    keptLines.push(`${DELIVERY_RESERVATION_MEMO_PREFIX} ${formatDeliveryReservationMemoDateTime(deliveryDateTime)}`);
  }
  return keptLines.join('\n').replace(/^\n+|\n+$/g, '');
}

// PostgreSQL numeric 컬럼은 pg 드라이버가 문자열로 돌려준다("37.5") — 지도/경로 계산과
// `!= null` 판정이 숫자를 기대하므로 여기서 한 번 변환한다.
function toCoordNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function initialFieldState(order, defaultBranch, mode) {
  const reservedDate = order.reserved_date || '';
  const now = new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(reservedDate);
  const reservedTime = order.reserved_time || '';
  const t = /^(\d{2}):(\d{2})$/.exec(reservedTime);
  // order의 나머지 필드(origin_address 등)는 기본적으로 전부 빈 값이다(/orders/new 단독
  // 페이지는 buildOrderFormInitData가 항상 빈 order를 준다) — Stage 3 슬라이스 3에서
  // 카드뷰의 "접수 마무리" 탭이 GET /chat/sessions/:id/intake-order 응답을 그대로 이
  // order 인자에 병합해서 넘기면 여기서 자동으로 prefill된다(필드명이 이미 1:1 대응),
  // edit 모드에서는 GET /orders/:id/data.json이 같은 형태로 detail/vehicleNumber까지 채워준다.
  const prefillWaypoints = Array.isArray(order.waypoints)
    ? order.waypoints.map((w, i) => ({
      // 모듈 레벨 카운터로 id를 만들면(예전 방식) 서버 프로세스가 이전 요청들에서 이미
      // 증가시켜둔 값과 클라이언트의 신선한 값이 어긋나 SSR/hydration mismatch가 난다
      // (edit 모드에서 실제로 겪은 버그 — order.waypoints가 항상 비어 있던 create 모드에선
      // 안 드러났었다). order.waypoints는 서버/클라이언트가 같은 데이터를 받으므로 배열
      // index로 만들면 항상 결정적이다.
      id: 'prefill-' + i,
      address: w.address || '', detail: w.detail || '', contact: w.contact || '', vehicleNumber: w.vehicleNumber || '',
      reservedDate: w.reservedDate || '', reservedTime: w.reservedTime || '',
      lat: toCoordNumber(w.lat), lon: toCoordNumber(w.lon),
    }))
    : [];
  return {
    origin_address: order.origin_address || '', origin_detail_address: order.origin_detail_address || '', origin_contact: order.origin_contact || '',
    // 저장된 좌표/행정구역을 그대로 불러온다 — 예전엔 항상 빈 값으로 시작해서, 오더 상세를 열면
    // DB에 행정구역이 있어도 "✓ 행정구역" 배지가 꺼진 채로 보였다(좌표만 아래 edit 효과가
    // 지오코딩으로 다시 채워줘서 좌표 배지만 켜지는 상태). 배지는 실제 저장값을 보여줘야 한다.
    origin_lat: toCoordNumber(order.origin_lat), origin_lon: toCoordNumber(order.origin_lon),
    origin_sido: order.origin_sido || '', origin_sigugun: order.origin_sigugun || '', origin_dong: order.origin_dong || '',
    destination_address: order.destination_address || '', destination_detail_address: order.destination_detail_address || '', destination_contact: order.destination_contact || '',
    destination_lat: toCoordNumber(order.destination_lat), destination_lon: toCoordNumber(order.destination_lon),
    destination_sido: order.destination_sido || '', destination_sigugun: order.destination_sigugun || '', destination_dong: order.destination_dong || '',
    waypoints: prefillWaypoints,
    reservation_basis: (order.reservation_basis === 'delivery' || order.reservation_basis === 'immediate') ? order.reservation_basis : 'pickup',
    // 아직 실제 역산 계산이 안 붙어 있어(경로/지도 레이어 이후 추가 예정) 항상 빈 값으로
    // 시작한다 — "배송기준" 제출을 의도적으로 막는 역할도 겸한다(위 handleSubmit 참고).
    pickup_reserved_date: '',
    pickup_reserved_time: '',
    reservedDateYear: m ? m[1] : String(now.getFullYear()),
    reservedDateMonth: m ? m[2] : pad2(now.getMonth() + 1),
    reservedDateDay: m ? m[3] : pad2(now.getDate()),
    reservedTimeHour: t ? t[1] : '00',
    reservedTimeMinute: t ? t[2] : '00',
    vehicle_type: order.vehicle_type || '', vehicle_number: order.vehicle_number || '',
    payment_method_id: order.payment_method_id || '',
    fare_amount: order.fare_amount || '',
    // create 모드는 항상 0에서 시작해 fare-preview가 계산해줄 때만 채운다(기존 동작). edit
    // 모드는 사용자가 경로를 다시 확정하지 않고 다른 필드만 고쳐 저장해도 기존 도선료가
    // 조용히 0으로 사라지면 안 되므로 저장된 값으로 시작한다.
    ferry_fare_amount: mode === 'edit' ? (order.ferry_fare_amount || 0) : 0,
    branch_id: order.branch_id || defaultBranch || '',
    requester_group_id: order.requester_group_id || '',
    memo_customer: order.memo_customer || '',
    // 위 도선료와 같은 이유로, edit 모드에서는 저장된 업체 전달사항을 그대로 채운다(create
    // 모드는 이 필드에 대응하는 상담 접수 데이터가 없어 항상 빈 값 — 기존 동작 유지).
    memo_billing: mode === 'edit' ? (order.memo_billing || '') : '',
    // 기사 챗봇 전달사항 — 길이 제한이 없는 쪽. memo_customer(적요1, 100Byte)와 나눠 둔다.
    memo_driver_chat: order.memo_driver_chat || '',
    order_type: order.order_type || 'dispatch',
    // 경로탐색 기본값 — 탁송은 무료도로, 프리미엄/일일기사는 추천(사용자 지정). DB에 저장되는
    // 값이 아니라(주문 필드가 아님) order_type만 보고 매번 다시 계산한다. 사용자가 드롭다운을
    // 직접 바꾸면(route_priority_touched) 그 뒤로 오더구분이 바뀌어도 되돌리지 않는다.
    route_priority: (order.order_type === 'premium' || order.order_type === 'daily_driver') ? 'RECOMMEND' : 'FREE',
    route_priority_touched: false,
    // 예약기준 기본값도 오더구분을 따라간다 — 탁송/일일기사는 픽업시간 기준, 프리미엄대리는
    // 즉시. reservation_basis 자체는 저장된 값이 있으면(edit·재진입) 그대로 존중해야 해서
    // 위에서 이미 order.reservation_basis 기준으로 정해뒀다 — 여기 touched 플래그는 "오더구분을
    // 바꿀 때" 이 기본값을 다시 밀어줄지 판단하는 데만 쓴다(사용자가 예약기준 라디오를 직접
    // 만지면 더는 자동으로 안 건드림).
    reservation_basis_touched: false,
    trip_type: order.trip_type || '',
    final_destination_address: order.final_destination_address || '',
    final_destination_address_detail: order.final_destination_address_detail || '',
    destination_wait_minutes: order.destination_wait_minutes != null ? String(order.destination_wait_minutes) : '',
    reservation_hours_bracket: order.reservation_hours_bracket || '',
    sameAsMyPhone: false, sameAsOriginContact: false,
    chat_session_transition: 'agent_active',
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD': {
      const next = { ...state, [action.name]: action.value };
      if (action.name === 'reservation_basis') next.reservation_basis_touched = true;
      if (action.name === 'route_priority') next.route_priority_touched = true;
      return next;
    }
    // 오더구분(탁송/일일기사/프리미엄대리) 라디오 전용 — order_type만 바꾸는 SET_FIELD와
    // 달리, 사용자가 아직 손대지 않은 예약기준/경로탐색 기본값도 함께 다시 맞춘다.
    case 'SET_ORDER_TYPE': {
      const next = { ...state, order_type: action.value };
      if (!state.reservation_basis_touched) {
        next.reservation_basis = action.value === 'premium' ? 'immediate' : 'pickup';
      }
      if (!state.route_priority_touched) {
        next.route_priority = (action.value === 'premium' || action.value === 'daily_driver') ? 'RECOMMEND' : 'FREE';
      }
      return next;
    }
    case 'SET_RESERVED_DATE_PART': {
      const next = { ...state, [action.name]: action.value };
      const lastDay = getLastDayOfMonth(next.reservedDateYear, next.reservedDateMonth);
      const day = Number(next.reservedDateDay || 1);
      if (day > lastDay) next.reservedDateDay = pad2(lastDay);
      return next;
    }
    case 'ADD_WAYPOINT':
      return {
        ...state,
        waypoints: [...state.waypoints, { id: action.id, address: '', detail: '', contact: '', vehicleNumber: '', reservedDate: '', reservedTime: '', lat: null, lon: null }],
      };
    case 'REMOVE_WAYPOINT':
      return { ...state, waypoints: state.waypoints.filter((w) => w.id !== action.id) };
    case 'SET_WAYPOINT_FIELD':
      return {
        ...state,
        waypoints: state.waypoints.map((w) => (w.id === action.id ? { ...w, [action.field]: action.value } : w)),
      };
    default:
      return state;
  }
}

// AddressField.js의 geocode()와 같은 엔드포인트 — edit 모드 진입 시 이미 저장된 주소
// 문자열을 좌표 없이 그대로 보여주는데(위경도 자체가 저장된 적이 없어서), 사용자가 직접
// 주소를 다시 검색/blur해야만 경로·요금이 계산되던 것을 페이지 진입과 동시에 자동으로
// 한 번 해결하기 위한 헬퍼.
async function geocodeAddressForEdit(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return null;
  try {
    const res = await fetch('/kakao/search?' + new URLSearchParams({ q, mode: 'fallback' }));
    const data = await res.json();
    const best = (data.documents || [])[0];
    return best && best.lat && best.lon ? { lat: parseFloat(best.lat), lon: parseFloat(best.lon) } : null;
  } catch {
    return null;
  }
}

let waypointSeq = 0;

export default function OrderForm({ initialData, chatSessionId, mode = 'create', orderId, externalPrefill }) {
  const { order, branches, groups, paymentMethods, defaultBranch, currentUserRole, currentUserPhone } = initialData;
  const isEdit = mode === 'edit';
  const [state, dispatch] = useReducer(reducer, initialFieldState(order, defaultBranch, mode));
  const [submitting, setSubmitting] = useState(false);
  // edit 모드의 저장 버튼은 이제 페이지 상단(page.js)의 일반 <button type="submit"
  // form="order-edit-form">이라 이 컴포넌트의 submitting state로 disabled 처리를 못 한다
  // (서버 컴포넌트라 리렌더로 반영이 안 됨) — 그래서 handleSubmit 자체에서 재진입을
  // 막는다. ref를 쓰는 이유는 state 갱신은 다음 렌더까지 반영이 늦어 아주 빠른 연속
  // 클릭(같은 렌더에서 두 번 호출되는 경우)은 state 체크로 못 막기 때문이다.
  const submittingRef = useRef(false);
  // "방금 도착지 인도시간 기준에서 벗어났다"를 판단하기 위한 직전 예약기준 — order-form.js의
  // previousReservationBasis와 같은 역할.
  const previousReservationBasisRef = useRef(state.reservation_basis);
  const [error, setError] = useState(null);
  const [routeInfo, setRouteInfo] = useState({ km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });
  const [fareHint, setFareHint] = useState('');
  const [fareLocked, setFareLocked] = useState(false);
  // 접수 단계 부대비용. edit 모드는 이미 붙어 있는 줄을 그대로 불러온다 — 접수 때 넣은 것을
  // 여기서 못 고치면 오더상세 정산입력까지 가야 한다.
  const [intakeExtras, setIntakeExtras] = useState(() => (initialData.intakeExtraRows || []).map((r, i) => ({
    key: `xc-prefill-${i}`, id: r.id, chargeType: r.chargeType,
    optionCode: r.optionCode || '', amount: r.amount ? String(r.amount) : '',
    settleMode: r.settleMode || '',
  })));
  // 화면이 처음 들고 있던 줄. 저장할 때 "이 중 안 돌아온 것"만 지운다 — 통째로 갈아끼우면
  // 관리자가 오더상세에서 넣은 톨게이트·특수구간 줄까지 같이 지워진다.
  const intakeExtraKnownIds = useRef((initialData.intakeExtraRows || []).map((r) => r.id).filter(Boolean));
  const [intakeExtraDefaults, setIntakeExtraDefaults] = useState(initialData.intakeExtraDefaults || null);
  // 도선료를 손으로 고쳤으면 경로탐색이 다시 돌아도 덮어쓰지 않는다 — 고치자마자 되돌아가면
  // 고칠 수가 없다.
  const ferryOverridden = useRef(false);

  // 법인·지사를 고르면 그 요금설정의 정산구분 기본값을 받아온다. 화면에서 "비면 월정산" 같은
  // 규칙을 다시 구현하면 설정을 바꿨을 때 화면만 옛 기본값을 보인다.
  useEffect(() => {
    let cancelled = false;
    const q = new URLSearchParams();
    if (state.requester_group_id) q.set('group_id', String(state.requester_group_id));
    if (state.branch_id) q.set('branch_id', String(state.branch_id));
    fetch(`/orders/extra-cost-defaults?${q.toString()}`, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!cancelled && d && d.defaults) setIntakeExtraDefaults(d.defaults); })
      // 못 받아오면 서버가 내려준 항목 정의의 defaultMode를 그대로 쓴다 — 접수를 막을 일은 아니다.
      .catch(() => {});
    return () => { cancelled = true; };
  }, [state.requester_group_id, state.branch_id]);
  const fareRequestIdRef = useRef(0);
  const [vehicleTypeSuggestions, setVehicleTypeSuggestions] = useState([]);
  const vehicleTypeDebounceRef = useRef(null);
  const vehicleTypeRequired = /제주/.test(state.destination_address || '');

  function handleVehicleTypeChange(value) {
    setField('vehicle_type', value);
    clearTimeout(vehicleTypeDebounceRef.current);
    if (!value.trim()) {
      setVehicleTypeSuggestions([]);
      return;
    }
    vehicleTypeDebounceRef.current = setTimeout(async () => {
      try {
        const res = await fetch('/orders/vehicle-type-suggest?q=' + encodeURIComponent(value.trim()));
        const data = await res.json();
        setVehicleTypeSuggestions(data.suggestions || []);
      } catch {
        setVehicleTypeSuggestions([]);
      }
    }, 200);
  }

  const routePoints = [
    { slot: 'origin', lat: state.origin_lat, lon: state.origin_lon },
    ...state.waypoints.map((w) => ({ slot: w.id, lat: w.lat, lon: w.lon })),
    { slot: 'destination', lat: state.destination_lat, lon: state.destination_lon },
  ];

  // edit 모드 진입 시 좌표 자동 해결 — 저장된 주소는 텍스트뿐이라(위경도 저장 이력 없음),
  // 사용자가 직접 주소를 다시 검색/blur하기 전까지는 RouteCalculator가 동작할 두 점을
  // 못 채운다. 오더 상세를 열자마자(오더 리스트에서 클릭해 들어왔을 때 포함) "거리" 표시가
  // 바로 나오도록, 초기 주소들을 한 번씩 조용히 지오코딩해서 채워 넣는다. order.waypoints의
  // id는 initialFieldState가 항상 'prefill-' + index로 결정적으로 만들므로 여기서도
  // 그대로 재현할 수 있다 — 마운트 시 한 번만 실행(사용자가 입력 중인 값을 덮어쓰지 않음).
  useEffect(() => {
    if (mode !== 'edit') return;
    let cancelled = false;
    // 저장된 값이 이미 있으면 다시 조회하지 않는다(initialFieldState가 그대로 불러온다) —
    // 콜마너 연동 전에 만들어진 예전 오더만 빈 값을 채운다. 좌표는 있는데 행정구역만 없는
    // 경우도 있어서(좌표 저장이 먼저 들어갔다) 둘을 따로 판단한다.
    const endpointTargets = ['origin', 'destination'].map((kind) => ({
      kind,
      address: order[`${kind}_address`],
      lat: toCoordNumber(order[`${kind}_lat`]),
      lon: toCoordNumber(order[`${kind}_lon`]),
      hasRegion: !!(order[`${kind}_sido`] && order[`${kind}_sigugun`] && order[`${kind}_dong`]),
    }));
    // 경유지는 콜마너 viaList에 행정구역이 필수가 아니라 좌표만 채운다.
    const waypointTargets = (Array.isArray(order.waypoints) ? order.waypoints : []).map((w, i) => ({
      kind: 'waypoint', id: 'prefill-' + i, address: w.address,
      lat: toCoordNumber(w.lat), lon: toCoordNumber(w.lon), hasRegion: true,
    }));

    Promise.all([...endpointTargets, ...waypointTargets].map(async (t) => {
      let { lat, lon } = t;
      if (lat == null || lon == null) {
        const coords = await geocodeAddressForEdit(t.address);
        if (!coords) return null;
        lat = coords.lat;
        lon = coords.lon;
      }
      const region = t.hasRegion ? null : await resolveRegion(lat, lon);
      return { ...t, lat, lon, region };
    })).then((resolved) => {
      if (cancelled) return;
      resolved.filter(Boolean).forEach((t) => {
        if (t.kind === 'waypoint') {
          dispatch({ type: 'SET_WAYPOINT_FIELD', id: t.id, field: 'lat', value: t.lat });
          dispatch({ type: 'SET_WAYPOINT_FIELD', id: t.id, field: 'lon', value: t.lon });
          return;
        }
        dispatch({ type: 'SET_FIELD', name: `${t.kind}_lat`, value: t.lat });
        dispatch({ type: 'SET_FIELD', name: `${t.kind}_lon`, value: t.lon });
        if (t.region) {
          dispatch({ type: 'SET_FIELD', name: `${t.kind}_sido`, value: t.region.sido || '' });
          dispatch({ type: 'SET_FIELD', name: `${t.kind}_sigugun`, value: t.region.sigugun || '' });
          dispatch({ type: 'SET_FIELD', name: `${t.kind}_dong`, value: t.region.dong || '' });
        }
      });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 오더 상세(edit 모드) 진입 시 콜마너 오더접수 결과를 짧게 폴링 — 등록 자체가
  // fire-and-forget이라 오더 리스트에서 방금 만든 오더를 클릭해 들어온 경우 아직 결과가
  // 안 나와 있을 수 있다. 실패했을 때만 팝업으로 알려준다(public/js/callmaner-alert.js).
  //
  // 상태를 '접수'로 바꾸는 순간이 실제 콜마너 등록 시점이고(routes/orders.js의
  // registerOrderWithCallmaner) 그 상태변경은 일반 form POST → 리다이렉트라, 되돌아온 이 화면이
  // 뜨는 시점엔 아직 호출이 진행 중이다. 그런데 콜마너 클라이언트 타임아웃은 10초(lib/callmaner.js
  // DEFAULT_TIMEOUT_MS)인데 폴링 기본 창은 6회×1.5초≈7.5초라, 타임아웃으로 실패하는 최악의
  // 경우엔 에러가 기록되기 직전에 폴링이 끝나버려 아무 안내도 못 봤다 — 그 10초를 넘기도록
  // 창을 넓힌다(10회×1.5초≈13.5초). 기본값을 바꾸지 않는 이유는 화면이동을 onDone으로 막는
  // 호출부(public/js/ai-intake.js)가 있어 그쪽 대기시간까지 같이 늘어나기 때문이다.
  useEffect(() => {
    if (mode !== 'edit' || !orderId) return;
    if (typeof window !== 'undefined' && window.__callmanerAlert) {
      window.__callmanerAlert.poll(orderId, { maxAttempts: 10 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 예약기준 역산: order-form.js의 syncReservationBasisPreview/syncDeliveryReservationMemo를
  // 그대로 이식. routeInfo.durationSec(RouteMap이 실제 경로 확정 후 넘겨줌)에 의존하므로
  // 지도 레이어보다 먼저 만들 수 없었던 부분 — 이제 둘 다 있으니 여기서 연결한다.
  useEffect(() => {
    const deliveryDateTime = new Date(
      Number(state.reservedDateYear), Number(state.reservedDateMonth) - 1, Number(state.reservedDateDay),
      Number(state.reservedTimeHour), Number(state.reservedTimeMinute), 0, 0
    );
    const isDelivery = state.reservation_basis === 'delivery';
    const justLeftDeliveryForPickup = previousReservationBasisRef.current === 'delivery' && state.reservation_basis === 'pickup';
    previousReservationBasisRef.current = state.reservation_basis;

    if (state.reservation_basis === 'immediate') {
      // 즉시 선택 시 예약 날짜/시간을 현재 시각(10분 단위 반올림)으로 맞춘다 — 이미 같은 값이면
      // dispatch를 건너뛰어 이 effect가 자기 자신을 계속 재실행하는 걸 막는다.
      const now = roundDateToNearestTenMinutes(new Date());
      const y = String(now.getFullYear());
      const mo = pad2(now.getMonth() + 1);
      const d = pad2(now.getDate());
      const h = pad2(now.getHours());
      const mi = pad2(now.getMinutes());
      if (state.reservedDateYear !== y) dispatch({ type: 'SET_FIELD', name: 'reservedDateYear', value: y });
      if (state.reservedDateMonth !== mo) dispatch({ type: 'SET_FIELD', name: 'reservedDateMonth', value: mo });
      if (state.reservedDateDay !== d) dispatch({ type: 'SET_FIELD', name: 'reservedDateDay', value: d });
      if (state.reservedTimeHour !== h) dispatch({ type: 'SET_FIELD', name: 'reservedTimeHour', value: h });
      if (state.reservedTimeMinute !== mi) dispatch({ type: 'SET_FIELD', name: 'reservedTimeMinute', value: mi });
      if (state.pickup_reserved_date !== `${y}-${mo}-${d}`) dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_date', value: `${y}-${mo}-${d}` });
      if (state.pickup_reserved_time !== `${h}:${mi}`) dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_time', value: `${h}:${mi}` });
      return;
    }

    if (!isDelivery) {
      // 도착지 인도시간 기준에서 막 픽업시간 기준으로 바꾼 경우, 화면에 남은 시각은 고객이
      // 말한 인도 요청 시각이지 픽업 시각이 아니다 — 직전에 계산해둔 픽업 시각(state.pickup_
      // reserved_date/time, 아직 이번 effect가 안 건드림)을 화면에 반영해준다(실사용 지적:
      // 안 하면 인도 시각을 그대로 픽업 시각으로 오인해 등록하게 된다).
      if (justLeftDeliveryForPickup && state.pickup_reserved_date && state.pickup_reserved_time) {
        const [py, pmo, pd] = state.pickup_reserved_date.split('-');
        const [ph, pmi] = state.pickup_reserved_time.split(':');
        if (py && pmo && pd && ph && pmi) {
          if (state.reservedDateYear !== py) dispatch({ type: 'SET_FIELD', name: 'reservedDateYear', value: py });
          if (state.reservedDateMonth !== pmo) dispatch({ type: 'SET_FIELD', name: 'reservedDateMonth', value: pmo });
          if (state.reservedDateDay !== pd) dispatch({ type: 'SET_FIELD', name: 'reservedDateDay', value: pd });
          if (state.reservedTimeHour !== ph) dispatch({ type: 'SET_FIELD', name: 'reservedTimeHour', value: ph });
          if (state.reservedTimeMinute !== pmi) dispatch({ type: 'SET_FIELD', name: 'reservedTimeMinute', value: pmi });
          const nextMemo = deriveMemoWithReservationLine(state.memo_customer, false, null);
          if (nextMemo !== state.memo_customer) dispatch({ type: 'SET_FIELD', name: 'memo_customer', value: nextMemo });
          return;
        }
      }
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_date', value: `${state.reservedDateYear}-${state.reservedDateMonth}-${state.reservedDateDay}` });
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_time', value: `${state.reservedTimeHour}:${state.reservedTimeMinute}` });
      const nextMemo = deriveMemoWithReservationLine(state.memo_customer, false, null);
      if (nextMemo !== state.memo_customer) dispatch({ type: 'SET_FIELD', name: 'memo_customer', value: nextMemo });
      return;
    }

    const durationSec = routeInfo.durationSec;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_date', value: '' });
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_time', value: '' });
    } else {
      const pickupMs = deliveryDateTime.getTime() - (durationSec + DELIVERY_BUFFER_SECONDS) * 1000;
      const rounded = roundDateToNearestTenMinutes(new Date(pickupMs));
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_date', value: `${rounded.getFullYear()}-${pad2(rounded.getMonth() + 1)}-${pad2(rounded.getDate())}` });
      dispatch({ type: 'SET_FIELD', name: 'pickup_reserved_time', value: `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}` });
    }
    const nextMemo = deriveMemoWithReservationLine(state.memo_customer, true, deliveryDateTime);
    if (nextMemo !== state.memo_customer) dispatch({ type: 'SET_FIELD', name: 'memo_customer', value: nextMemo });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.reservation_basis, state.reservedDateYear, state.reservedDateMonth, state.reservedDateDay, state.reservedTimeHour, state.reservedTimeMinute, routeInfo.durationSec]);

  // 요금 자동계산: order-form.js의 updateFarePreview/updateFerryFareTile을 이식. 거리(routeInfo.km)가
  // 나오면(직선거리든 실제 경로든) 곧바로 /orders/fare-preview를 호출한다 — 지사가 구간요금표를
  // 안 쓰면 enabled:false가 와서 수동 입력으로 전환된다.
  useEffect(() => {
    if (routeInfo.km == null || !state.branch_id) {
      setFareHint('');
      setFareLocked(false);
      return;
    }
    const requestId = ++fareRequestIdRef.current;
    const timer = setTimeout(async () => {
      const params = new URLSearchParams();
      params.set('branch_id', state.branch_id);
      params.set('distance_km', routeInfo.km.toFixed(2));
      if (state.vehicle_type.trim()) params.set('vehicle_type', state.vehicle_type.trim());
      if (state.origin_address.trim()) params.set('origin_address', state.origin_address.trim());
      const fareReservedDate = state.reservation_basis === 'delivery' && state.pickup_reserved_date ? state.pickup_reserved_date : `${state.reservedDateYear}-${state.reservedDateMonth}-${state.reservedDateDay}`;
      const fareReservedTime = state.reservation_basis === 'delivery' && state.pickup_reserved_time ? state.pickup_reserved_time : `${state.reservedTimeHour}:${state.reservedTimeMinute}`;
      if (fareReservedDate) params.set('reserved_date', fareReservedDate);
      if (fareReservedTime) params.set('reserved_time', fareReservedTime);
      params.set('has_ferry_leg', routeInfo.hasFerryLeg ? '1' : '0');
      if (routeInfo.ferrySegments) {
        const seg = routeInfo.ferrySegments;
        if (Number.isFinite(seg.beforeDistanceM)) params.set('before_km', (seg.beforeDistanceM / 1000).toFixed(2));
        if (Number.isFinite(seg.afterDistanceM)) params.set('after_km', (seg.afterDistanceM / 1000).toFixed(2));
        if (Number.isFinite(seg.beforeDurationS)) params.set('before_minutes', String(Math.round(seg.beforeDurationS / 60)));
        if (Number.isFinite(seg.afterDurationS)) params.set('after_minutes', String(Math.round(seg.afterDurationS / 60)));
      }

      let data;
      try {
        const res = await fetch('/orders/fare-preview?' + params.toString());
        data = await res.json();
      } catch {
        return;
      }
      if (requestId !== fareRequestIdRef.current) return; // stale 응답 무시

      if (!data.enabled) {
        setFareHint('이 지사는 구간요금표를 사용하지 않아 수동으로 입력합니다.');
        setFareLocked(false);
        return;
      }
      dispatch({ type: 'SET_FIELD', name: 'fare_amount', value: String(data.totalFare != null ? data.totalFare : data.fare) });
      if (!ferryOverridden.current) {
        dispatch({ type: 'SET_FIELD', name: 'ferry_fare_amount', value: data.ferryFare != null ? data.ferryFare : 0 });
      }

      let hint;
      if (data.ferryNeedVehicleType) {
        hint = `구간요금은 자동 계산되었습니다 (${routeInfo.km.toFixed(1)}km 기준). 도선료 계산을 위해 차종을 입력하세요.`;
      } else if (data.ferryApplied && data.ferryFare != null) {
        hint = `구간요금 ${Number(data.baseFare || 0).toLocaleString('ko-KR')}원 + 도선료 ${Number(data.ferryFare || 0).toLocaleString('ko-KR')}원 = 총 ${Number(data.totalFare || data.fare || 0).toLocaleString('ko-KR')}원으로 자동 계산되었습니다.`;
      } else {
        hint = `구간요금 설정에 따라 자동 계산되었습니다 (${routeInfo.km.toFixed(1)}km 기준). 필요 시 직접 수정할 수 있습니다.`;
      }
      const locked = isClient && !data.editableByClient;
      if (locked) hint += ' (수정 불가)';
      setFareHint(hint);
      setFareLocked(locked);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.branch_id, routeInfo.km, routeInfo.hasFerryLeg, JSON.stringify(routeInfo.ferrySegments), state.vehicle_type, state.origin_address, state.reservation_basis, state.pickup_reserved_date, state.pickup_reserved_time, state.reservedDateYear, state.reservedDateMonth, state.reservedDateDay, state.reservedTimeHour, state.reservedTimeMinute]);

  const isAdmin = currentUserRole === 'admin';
  const isClient = currentUserRole === 'client';
  // 적요1에 실제로 들어가는 부분과 잘리는 부분. 번호판이 바뀌면 예산도 바뀐다 —
  // 맨 앞에 번호판이 붙기 때문이다(lib/callmaner.js memoWithVehicle).
  // 계산은 서버와 같은 모듈을 쓴다. 화면이 따로 세면 "여기서는 들어간다는데 실제로는
  // 잘리는" 상태가 된다.
  const memoBudget = useMemo(
    () => memoBudgetLib.describe(state.memo_customer, state.vehicle_number),
    [state.memo_customer, state.vehicle_number]
  );

  // AI 챗봇 parse 결과를 폼으로 점진 반영한다. 값이 비어 있지 않은 필드만 덮어쓴다.
  // (빈 문자열로 기존 입력을 지우지 않도록 보호)
  useEffect(() => {
    if (!externalPrefill || typeof externalPrefill !== 'object') return;
    const p = externalPrefill;
    const clearFields = new Set(Array.isArray(p.__clearFields) ? p.__clearFields : []);
    const setIfFilled = (name, value) => {
      const v = String(value == null ? '' : value).trim();
      if (!v && !clearFields.has(name)) return;
      dispatch({ type: 'SET_FIELD', name, value: v });
    };

    setIfFilled('origin_address', p.origin_address);
    setIfFilled('origin_detail_address', p.origin_detail_address);
    setIfFilled('origin_contact', p.origin_contact);
    setIfFilled('destination_address', p.destination_address);
    setIfFilled('destination_detail_address', p.destination_detail_address);
    setIfFilled('destination_contact', p.destination_contact);
    setIfFilled('vehicle_type', p.vehicle_type);
    setIfFilled('vehicle_number', p.vehicle_number);
    setIfFilled('memo_customer', p.memo_customer);
    setIfFilled('memo_billing', p.memo_billing);
    setIfFilled('order_type', p.order_type);
    setIfFilled('trip_type', p.trip_type);
    setIfFilled('final_destination_address', p.final_destination_address);
    setIfFilled('final_destination_address_detail', p.final_destination_address_detail);
    if (p.destination_wait_minutes != null) setIfFilled('destination_wait_minutes', String(p.destination_wait_minutes));
    setIfFilled('reservation_hours_bracket', p.reservation_hours_bracket);

    const date = String(p.reserved_date || '').trim();
    const time = String(p.reserved_time || '').trim();
    const dateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    const timeMatch = /^(\d{2}):(\d{2})$/.exec(time);
    if (dateMatch) {
      dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateYear', value: dateMatch[1] });
      dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateMonth', value: dateMatch[2] });
      dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateDay', value: dateMatch[3] });
    }
    if (timeMatch) {
      dispatch({ type: 'SET_FIELD', name: 'reservedTimeHour', value: timeMatch[1] });
      dispatch({ type: 'SET_FIELD', name: 'reservedTimeMinute', value: timeMatch[2] });
    }

    // 챗봇이 밀어넣는 값은 주소 "텍스트"뿐이라 콜마너 오더접수 필수값인 좌표/행정구역이 비어
    // 있었다 — 이 경로는 AddressField를 사용자가 직접 조작하지 않아 onResolved가 호출되지
    // 않기 때문(AI 접수화면에서 등록한 오더가 계속 "출발지 좌표/행정구역 정보가 없어..."로
    // 실패한 원인). 여기서 지오코딩 + 역지오코딩해 직접 채운다(실패 시 조용히 넘어감).
    let cancelled = false;
    Promise.all([
      { kind: 'origin', address: p.origin_address },
      { kind: 'destination', address: p.destination_address },
    ].filter((t) => String(t.address || '').trim()).map(async (t) => {
      const coords = await geocodeAddressForEdit(t.address);
      if (cancelled || !coords) return;
      dispatch({ type: 'SET_FIELD', name: `${t.kind}_lat`, value: coords.lat });
      dispatch({ type: 'SET_FIELD', name: `${t.kind}_lon`, value: coords.lon });
      const region = await resolveRegion(coords.lat, coords.lon);
      if (cancelled || !region) return;
      dispatch({ type: 'SET_FIELD', name: `${t.kind}_sido`, value: region.sido || '' });
      dispatch({ type: 'SET_FIELD', name: `${t.kind}_sigugun`, value: region.sigugun || '' });
      dispatch({ type: 'SET_FIELD', name: `${t.kind}_dong`, value: region.dong || '' });
    }));
    return () => { cancelled = true; };
  }, [externalPrefill]);

  function setField(name, value) {
    dispatch({ type: 'SET_FIELD', name, value });
  }

  function handleSameAsMyPhone(checked) {
    dispatch({ type: 'SET_FIELD', name: 'sameAsMyPhone', value: checked });
    if (checked) setField('origin_contact', currentUserPhone || '');
  }

  function handleSameAsOriginContact(checked) {
    dispatch({ type: 'SET_FIELD', name: 'sameAsOriginContact', value: checked });
    if (checked) setField('destination_contact', state.origin_contact);
  }

  // 기사배정 후 수정 제한(사용자 확정 사항) — 이미 기사에게 전달된 정보를 당사자 모르게
  // 바꿔버리면 안 된다. 고객(client)은 저장 자체를 막고 안내만 보여주고, 관리자(admin)와
  // 상담원(branch_manager)은 수정은 허용하되 "기사님께 꼭 전달해달라"는 확인 팝업을 거친다.
  // 서버(POST /:id)도 같은 기준(hasAssignedDriver)으로 다시 막으므로, 여기서는 사용자
  // 경험(왕복 없이 즉시 안내)을 위한 것이고 실제 권한 경계는 서버에 있다.
  function checkAssignedDriverGate() {
    if (!isEdit || !order.hasAssignedDriver) return true;
    if (currentUserRole === 'client') {
      setError('해당 오더가 기사님께 배정된 상태입니다. 수정사항은 상담원 대화 요청이나, 고객센터로 직접 요청해 주세요.');
      return false;
    }
    return window.confirm('기사님에 배정되어 있으니 수정사항을 기사님께 꼭 전달해 주세요.');
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (submittingRef.current) return;
    setError(null);

    if (!checkAssignedDriverGate()) return;

    if (state.reservation_basis === 'delivery' && (!state.pickup_reserved_date || !state.pickup_reserved_time)) {
      // 실제 역산 계산이 아직 안 붙어 있어(경로 확정 전에는 계산 불가), 배송기준을 골랐는데
      // 픽업 필드가 비어있으면 제출을 막는다 — 레거시의 유일한 클라이언트 차단 검증과 동일한 취지.
      alert('도착지 인도시간 기준 예약은 경로 확인이 필요합니다. 잠시 후 다시 시도해주세요.');
      return;
    }

    const reservedDate = `${state.reservedDateYear}-${state.reservedDateMonth}-${state.reservedDateDay}`;
    const reservedTime = `${state.reservedTimeHour}:${state.reservedTimeMinute}`;
    const pickupDate = state.reservation_basis === 'delivery' ? state.pickup_reserved_date : reservedDate;
    const pickupTime = state.reservation_basis === 'delivery' ? state.pickup_reserved_time : reservedTime;

    // 좌표/행정구역이 아직 비어 있으면(챗봇이 주소를 밀어넣은 직후 바로 등록을 누른 경우 등)
    // 제출 직전에 마지막으로 한 번 더 채운다 — 콜마너 오더접수는 이 값이 없으면 아예 호출도
    // 못 하고 실패하므로, 등록이 조금 늦어지더라도 값을 확보하는 쪽이 낫다.
    const geo = { origin: null, destination: null };
    await Promise.all(['origin', 'destination'].map(async (kind) => {
      if (state[`${kind}_lat`] != null && state[`${kind}_sido`]) return;
      const address = state[`${kind}_address`];
      if (!String(address || '').trim()) return;
      const coords = await geocodeAddressForEdit(address);
      if (!coords) return;
      geo[kind] = { ...coords, region: await resolveRegion(coords.lat, coords.lon) };
    }));
    const coordOf = (kind, key) => (geo[kind] ? geo[kind][key] : state[`${kind}_${key}`]);
    const regionOf = (kind, key) => (geo[kind] && geo[kind].region ? geo[kind].region[key] : state[`${kind}_${key}`]);

    const params = new URLSearchParams();
    params.set('branch_id', state.branch_id);
    params.set('requester_group_id', state.requester_group_id);
    params.set('origin_address', state.origin_address);
    params.set('origin_detail_address', state.origin_detail_address);
    params.set('origin_contact', state.origin_contact);
    params.set('destination_address', state.destination_address);
    params.set('destination_detail_address', state.destination_detail_address);
    params.set('destination_contact', state.destination_contact);
    // 콜마너 오더접수 연동에 필요한 좌표/행정구역 — AddressField가 주소 확정 시 채워주고,
    // 비어 있으면 바로 위에서 보강한 값(geo)을 쓴다.
    for (const kind of ['origin', 'destination']) {
      const lat = coordOf(kind, 'lat');
      const lon = coordOf(kind, 'lon');
      if (lat != null) params.set(`${kind}_lat`, String(lat));
      if (lon != null) params.set(`${kind}_lon`, String(lon));
      for (const key of ['sido', 'sigugun', 'dong']) {
        const v = regionOf(kind, key);
        if (v) params.set(`${kind}_${key}`, v);
      }
    }
    params.set('vehicle_type', state.vehicle_type);
    params.set('vehicle_number', state.vehicle_number);
    params.set('reserved_date', reservedDate);
    params.set('reserved_time', reservedTime);
    params.set('pickup_reserved_date', pickupDate);
    params.set('pickup_reserved_time', pickupTime);
    params.set('payment_method_id', state.payment_method_id);
    params.set('fare_amount', state.fare_amount);
    params.set('ferry_fare_amount', String(state.ferry_fare_amount || 0));
    params.set('memo_customer', state.memo_customer);
    params.set('memo_driver_chat', state.memo_driver_chat);
    params.set('memo_billing', state.memo_billing);
    params.set('order_type', state.order_type || 'dispatch');
    if (state.trip_type) params.set('trip_type', state.trip_type);
    if (state.final_destination_address) params.set('final_destination_address', state.final_destination_address);
    if (state.final_destination_address_detail) params.set('final_destination_address_detail', state.final_destination_address_detail);
    if (state.destination_wait_minutes) params.set('destination_wait_minutes', state.destination_wait_minutes);
    if (state.reservation_hours_bracket) params.set('reservation_hours_bracket', state.reservation_hours_bracket);
    if (chatSessionId) {
      params.set('chat_session_id', String(chatSessionId));
      params.set('chat_session_transition', state.chat_session_transition);
    }
    // 부대비용. 도선료는 줄이 아니라 orders.ferry_fare_amount로 저장되므로 금액은 위에서
    // 이미 보냈고, 여기서는 정산구분만 실어 보낸다.
    intakeExtras.forEach((r) => {
      params.append('intake_extra_type[]', r.chargeType);
      params.append('intake_extra_option[]', r.optionCode || '');
      params.append('intake_extra_amount[]', String(r.amount || 0));
      params.append('intake_extra_mode[]', r.settleMode || '');
      params.append('intake_extra_id[]', r.id ? String(r.id) : '');
    });
    intakeExtraKnownIds.current.forEach((id) => params.append('intake_extra_known_id[]', String(id)));

    state.waypoints.forEach((w) => {
      params.append('waypoints[]', w.address);
      params.append('waypoint_details[]', w.detail);
      params.append('waypoint_contacts[]', w.contact);
      params.append('waypoint_vehicle_numbers[]', w.vehicleNumber);
      params.append('waypoint_reserved_dates[]', w.reservedDate || '');
      params.append('waypoint_reserved_times[]', w.reservedTime || '');
    });

    // 레거시 AI intake와 동일하게 등록 직전에 서버 precheck를 먼저 실행한다.
    // 실패 사유를 즉시 인라인 에러로 보여주고 실제 저장 요청은 보내지 않는다.
    try {
      const precheckRes = await fetch('/orders/ai-intake/submit-precheck', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-Requested-With': 'fetch',
        },
        body: params,
      });
      if (precheckRes.status !== 404) {
        const precheckData = await precheckRes.json().catch(() => ({}));
        if (!precheckRes.ok || !precheckData.ok) {
          setError(precheckData.error || precheckData.message || '등록 가능 여부를 확인하지 못했습니다.');
          return;
        }
      }
    } catch {
      setError('등록 가능 여부를 확인하지 못했습니다. 네트워크 상태를 확인해주세요.');
      return;
    }

    submittingRef.current = true;
    setSubmitting(true);
    try {
      const res = await fetch(mode === 'edit' ? `/orders/${orderId}` : '/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: params,
      });
      if (res.status === 400) {
        const data = await res.json().catch(() => ({ error: '입력값을 확인해주세요.' }));
        setError(data.error || '입력값을 확인해주세요.');
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        setError('저장에 실패했습니다. 다시 시도해주세요.');
        submittingRef.current = false;
        setSubmitting(false);
        return;
      }
      if (mode === 'edit') {
        window.location.assign('/orders/' + orderId);
        return;
      }
      const data = await res.json();
      // AI 접수 워크스페이스(chatSessionId가 있을 때만)에서 등록을 마치면 오더 상세 대신
      // 오더 리스트로 보낸다 — 챗봇으로 계속 새 오더를 접수하는 흐름이라 목록에서 방금 등록한
      // 건을 바로 확인하는 게 자연스럽다. /orders/new 단독 페이지(chatSessionId 없음)는
      // 기존처럼 상세 페이지로 이동.
      window.location.assign(chatSessionId ? '/orders' : '/orders/' + data.orderId);
    } catch {
      setError('저장에 실패했습니다. 다시 시도해주세요.');
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  return (
    <div className="order-form">
      {isEdit && order.hasAssignedDriver && currentUserRole === 'client' && (
        <div className="error-msg" style={{ marginBottom: 14 }}>
          해당 오더가 기사님께 배정된 상태입니다. 수정사항은 상담원 대화 요청이나, 고객센터로 직접 요청해 주세요.
        </div>
      )}
      <div className="order-grid">
        {/* OrderSidePanel(03번 자리, edit 모드)이 기사배정용 <form>을 자체적으로 갖고 있어서
            — HTML은 <form> 중첩을 허용하지 않는다(중첩되면 브라우저가 파서 레벨에서 구조를
            바꿔버려 실제로 hydration mismatch가 났다). 그래서 이 <form>은 grid의 01/02
            섹션만 감싸고, display:contents로 grid 레이아웃 자체에는 관여하지 않게 한다. */}
        {/* id는 OrderSidePanel(03번 자리)로 옮겨간 귀속정보/오더타입 필드와 상단 헤더의
            "오더수정" 버튼이 form 속성으로 이 폼을 가리키기 위해 필요하다 — 실제 제출은
            handleSubmit이 state를 읽어 만드는 것이라 DOM상 폼 밖에 있어도 값 자체는
            문제없이 반영되지만, required 검증(예: 지사 선택)이 실제로 이 폼 제출을
            막도록 하려면 form="order-edit-form"으로 명시적 연결이 필요하다. */}
        <form id="order-edit-form" className="order-form-fields" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        <section className="card order-panel route-panel">
          {/* edit 모드는 오더구분을 우측 OrderSidePanel에서 이미 다룬다 — 여기(01번 자리)에는
              create 모드에서만 오더구분 라디오를 둔다(사용자 요청, 섹션 타이틀은 없앤다). */}
          {!isEdit && (
            <div className="order-type-radio-group inline-duo" style={{ marginBottom: 16, alignItems: 'center' }}>
              <span style={{ fontWeight: 700, marginRight: 4 }}>오더구분</span>
              <label className="checkline">
                <input type="radio" name="order_type_radio" checked={(state.order_type || 'dispatch') === 'dispatch'}
                  onChange={() => dispatch({ type: 'SET_ORDER_TYPE', value: 'dispatch' })} /> 탁송
              </label>
              <label className="checkline">
                <input type="radio" name="order_type_radio" checked={state.order_type === 'daily_driver'}
                  onChange={() => dispatch({ type: 'SET_ORDER_TYPE', value: 'daily_driver' })} /> 일일기사
              </label>
              <label className="checkline">
                <input type="radio" name="order_type_radio" checked={state.order_type === 'premium'}
                  onChange={() => dispatch({ type: 'SET_ORDER_TYPE', value: 'premium' })} /> 프리미엄대리
              </label>
            </div>
          )}

          <div className="route-stop origin-stop">
            <div className="route-stop-title"><span className="route-marker">출발</span></div>
            <AddressField label="출발지 주소" required favorites={initialData.favorites}
              hasCoord={state.origin_lat != null && state.origin_lon != null}
              hasRegion={!!(state.origin_sido && state.origin_sigugun && state.origin_dong)}
              address={state.origin_address} detail={state.origin_detail_address}
              onAddressChange={(v) => setField('origin_address', v)}
              onDetailChange={(v) => setField('origin_detail_address', v)}
              onResolved={(lat, lon, region) => {
                setField('origin_lat', lat); setField('origin_lon', lon);
                if (region) { setField('origin_sido', region.sido); setField('origin_sigugun', region.sigugun); setField('origin_dong', region.dong); }
              }} />
            <div className="field">
              <label>출발지 연락처 <span className="required-mark" aria-hidden="true">*</span></label>
              <input type="text" className="phone-input" required placeholder="010-0000-0000"
                value={state.origin_contact} onChange={(e) => { setField('sameAsMyPhone', false); setField('origin_contact', e.target.value); }} />
              <label className="checkline">
                <input type="checkbox" checked={state.sameAsMyPhone} onChange={(e) => handleSameAsMyPhone(e.target.checked)} /> 요청자(본인) 연락처와 동일
              </label>
            </div>
          </div>

          <div>
            {state.waypoints.map((w, idx) => (
              <div className="field full waypoint-row" key={w.id}>
                <AddressField label={`경유지 주소 ${idx + 1}`}
                  hasCoord={w.lat != null && w.lon != null}
                  address={w.address} detail={w.detail}
                  onAddressChange={(v) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'address', value: v })}
                  onDetailChange={(v) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'detail', value: v })}
                  onResolved={(lat, lon) => {
                    dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'lat', value: lat });
                    dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'lon', value: lon });
                  }} />
                <div className="row" style={{ marginTop: 8 }}>
                  <div className="field"><label>경유지 연락처</label>
                    <input type="text" className="phone-input" placeholder="010-0000-0000"
                      value={w.contact} onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'contact', value: e.target.value })} />
                  </div>
                  <div className="field"><label>경유지 차량번호 (선택)</label>
                    <input type="text" placeholder="예: 12가3456"
                      value={w.vehicleNumber} onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'vehicleNumber', value: e.target.value })} />
                  </div>
                </div>
                {/* 이 경유지에서 "다른 날" 다시 출발하는 경우에만 채운다. 값이 있고 출발일과
                    다르면 서버가 오더를 구간별로 나눠 접수한다(lib/orderSplit.js) — 같은 날
                    이어서 도는 평범한 경유는 비워두면 지금처럼 한 건으로 등록된다.
                    public/js/order-form.js에도 같은 입력이 있다. */}
                <div className="row waypoint-schedule" style={{ marginTop: 8 }}>
                  <div className="field"><label>경유지 출발일 (다른 날일 때만)</label>
                    <input type="date"
                      value={w.reservedDate || ''} onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'reservedDate', value: e.target.value })} />
                  </div>
                  <div className="field"><label>경유지 출발시각</label>
                    <input type="time" step="600"
                      value={w.reservedTime || ''} onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'reservedTime', value: e.target.value })} />
                  </div>
                </div>
                <button type="button" className="btn small secondary" onClick={() => dispatch({ type: 'REMOVE_WAYPOINT', id: w.id })}>삭제</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn small secondary add-waypoint-btn"
            onClick={() => dispatch({ type: 'ADD_WAYPOINT', id: `wp-${++waypointSeq}` })}>+ 경유지 추가</button>

          <div className="route-stop destination-stop">
            <div className="route-stop-title"><span className="route-marker">도착</span></div>
            <AddressField label="도착지 주소" required favorites={initialData.favorites}
              hasCoord={state.destination_lat != null && state.destination_lon != null}
              hasRegion={!!(state.destination_sido && state.destination_sigugun && state.destination_dong)}
              address={state.destination_address} detail={state.destination_detail_address}
              onAddressChange={(v) => setField('destination_address', v)}
              onDetailChange={(v) => setField('destination_detail_address', v)}
              onResolved={(lat, lon, region) => {
                setField('destination_lat', lat); setField('destination_lon', lon);
                if (region) { setField('destination_sido', region.sido); setField('destination_sigugun', region.sigugun); setField('destination_dong', region.dong); }
              }} />
            <div className="row">
              <div className="field">
                <label>도착지 연락처 <span className="required-mark" aria-hidden="true">*</span></label>
                <input type="text" className="phone-input" required placeholder="010-0000-0000"
                  value={state.destination_contact} onChange={(e) => { setField('sameAsOriginContact', false); setField('destination_contact', e.target.value); }} />
                <label className="checkline">
                  <input type="checkbox" checked={state.sameAsOriginContact} onChange={(e) => handleSameAsOriginContact(e.target.checked)} /> 출발지 연락처와 동일
                </label>
              </div>
              <div className="field">
                <label>도착지 대기시간(분)</label>
                <input type="number" min={0} step={5} placeholder="없으면 비워두세요"
                  value={state.destination_wait_minutes || ''}
                  onChange={(e) => setField('destination_wait_minutes', e.target.value)} />
              </div>
            </div>
          </div>

          {/* 부대비용은 도착지 아래 — "이 차를 어떤 상태로 갖다줄지"라서 경로 이야기의 끝에 온다.
              고객(client)에게도 보여준다(사용자 확정 2026-09-02). 예전에는 통째로 감췄는데,
              그 안에는 금액(청구액)과 **지시**가 섞여 있었다 — "주유 가득"은 금액이 아니라
              지시이고, 접수 때는 금액을 아무도 모른다. 지시를 넣을 칸까지 사라져서 고객은
              요청사항 본문에 글로 쓸 수밖에 없었고, 그 본문은 아무도 읽지 않았다.
              고객에게 열리는 것은 실비 넷의 항목·옵션뿐이다 — 정산구분은 서버가 항목 목록
              자체를 줄여 내려주고(intakeExtra.forClient), 저장할 때도 무시한다. */}
          {!!initialData.intakeExtra && (
            <ExtraCostSection
              forClient={initialData.intakeExtra.forClient}
              config={initialData.intakeExtra}
              defaults={intakeExtraDefaults}
              rows={intakeExtras}
              onChange={setIntakeExtras}
              ferryAmount={state.ferry_fare_amount}
              ferryEditable
              onFerryAmount={(v) => {
                ferryOverridden.current = true;
                setField('ferry_fare_amount', v === '' ? 0 : Math.max(0, Math.round(Number(v) || 0)));
              }}
            />
          )}
        </section>

        <section className="card order-panel">
          <div className="route-stop order-schedule-stop">
          <div className="route-stop-title"><span className="route-marker">운행일정</span></div>
          <div className="field full">
            <label>예약일시 <span className="required-mark" aria-hidden="true">*</span></label>
            <div className="inline-duo" style={{ marginBottom: 8, alignItems: 'center' }}>
              <label className="checkline">
                <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'immediate'}
                  onChange={() => setField('reservation_basis', 'immediate')} /> 즉시
              </label>
              <label className="checkline">
                <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'pickup'}
                  onChange={() => setField('reservation_basis', 'pickup')} /> 출발지 픽업시간 기준
              </label>
              <label className="checkline">
                <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'delivery'}
                  onChange={() => setField('reservation_basis', 'delivery')} /> 도착지 인도시간 기준
              </label>
            </div>
            <div className="inline-duo reservation-datetime-row">
              <div className="inline-duo reservation-date-row">
                <select className="date-select" aria-label="예약 연도" value={state.reservedDateYear} disabled={state.reservation_basis === 'immediate'}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateYear', value: e.target.value })}>
                  {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => (
                    <option key={y} value={String(y)}>{y}년</option>
                  ))}
                </select>
                <select className="date-select" aria-label="예약 월" value={state.reservedDateMonth} disabled={state.reservation_basis === 'immediate'}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateMonth', value: e.target.value })}>
                  {Array.from({ length: 12 }, (_, i) => pad2(i + 1)).map((mm) => (
                    <option key={mm} value={mm}>{mm}월</option>
                  ))}
                </select>
                <select className="date-select" aria-label="예약 일" value={state.reservedDateDay} disabled={state.reservation_basis === 'immediate'}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateDay', value: e.target.value })}>
                  {Array.from({ length: getLastDayOfMonth(state.reservedDateYear, state.reservedDateMonth) }, (_, i) => pad2(i + 1)).map((dd) => (
                    <option key={dd} value={dd}>{dd}일</option>
                  ))}
                </select>
              </div>
              <select className="time-select" value={state.reservedTimeHour} disabled={state.reservation_basis === 'immediate'} onChange={(e) => setField('reservedTimeHour', e.target.value)}>
                {Array.from({ length: 24 }, (_, h) => pad2(h)).map((hh) => (
                  <option key={hh} value={hh}>{hh}시</option>
                ))}
              </select>
              <select className="time-select" value={state.reservedTimeMinute} disabled={state.reservation_basis === 'immediate'} onChange={(e) => setField('reservedTimeMinute', e.target.value)}>
                {['00', '10', '20', '30', '40', '50'].map((mm) => (
                  <option key={mm} value={mm}>{mm}분</option>
                ))}
              </select>
            </div>
          </div>

          {state.reservation_basis === 'delivery' && (
            <div className="field full">
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', fontSize: 12, lineHeight: 1.5, color: 'var(--muted)', fontWeight: 600 }}>
                <span>출발지 픽업시간 <span className="required-mark" aria-hidden="true">*</span></span>
                <span>{state.pickup_reserved_date && state.pickup_reserved_time ? `${state.pickup_reserved_date} ${state.pickup_reserved_time}` : '경로 확정 후 자동 계산'}</span>
                <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 500 }}>
                  {routeInfo.durationSec ? `(경로탐색 : ${Math.round(routeInfo.durationSec / 60)}분 +30분여유)` : '(경로탐색 : 경로 확정 후 자동 계산)'}
                </span>
              </div>
            </div>
          )}

          <div className="field full">
            <label>
              차종{vehicleTypeRequired && <span className="required-mark" aria-hidden="true"> *</span>} / 출발지 차량번호 (선택)
            </label>
            <div className="inline-duo">
              <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
                <input type="text" placeholder="예: 카니발, 그랜저, 1톤" autoComplete="off" required={vehicleTypeRequired}
                  value={state.vehicle_type} onChange={(e) => handleVehicleTypeChange(e.target.value)} />
                {vehicleTypeSuggestions.length > 0 && (
                  <div className="addr-results">
                    {vehicleTypeSuggestions.map((s) => (
                      <div className="addr-result-item" key={s} onClick={() => { setField('vehicle_type', s); setVehicleTypeSuggestions([]); }}>{s}</div>
                    ))}
                  </div>
                )}
              </div>
              <input type="text" placeholder="예: 12가3456"
                value={state.vehicle_number} onChange={(e) => setField('vehicle_number', e.target.value)} />
            </div>
          </div>
          </div>

          <div className="route-stop order-payment-stop">
          <div className="route-stop-title" style={{ justifyContent: 'space-between' }}>
            <span className="route-marker">결제 및 요금</span>
            {routeInfo.km != null && <span style={{ fontWeight: 400 }}>거리 : {routeInfo.km.toFixed(1)} km</span>}
          </div>
          <div className="field full">
            <label>결제방식 / 요금(원)</label>
            <div className="inline-duo">
              <select value={state.payment_method_id} onChange={(e) => setField('payment_method_id', e.target.value)}>
                <option value="">선택 안 함</option>
                {paymentMethods.map((pm) => (
                  <option key={pm.id} value={pm.id}>{pm.name}</option>
                ))}
              </select>
              <input type="number" min="0" step="1000" placeholder="0" readOnly={fareLocked}
                value={state.fare_amount} onChange={(e) => setField('fare_amount', e.target.value)} />
            </div>
            {fareHint && <p className="fare-calc-hint calculated">{fareHint}</p>}
            {routeInfo.hasFerryLeg && routeInfo.km != null && (
              <p className="fare-calc-hint">도선요금: {Number(state.ferry_fare_amount || 0).toLocaleString('ko-KR')}원 (구간요금에 포함)</p>
            )}
          </div>
          </div>

          {/* edit 모드에서는 귀속정보/오더타입을 우측 03번 패널(OrderSidePanel, 기사배정
              정보 위쪽)로 옮겼다(사용자 요청) — create 모드는 그 패널 자체가 없으므로
              (RouteMap이 그 자리를 대신함) 원래 위치를 그대로 유지한다. */}
          {!isEdit && (
            <>
              <div className="section-title small">귀속 정보</div>
              <div className="row">
                {isAdmin ? (
                  <div className="field">
                    <label>지사 선택 <span className="required-mark" aria-hidden="true">*</span></label>
                    <select required value={state.branch_id} onChange={(e) => setField('branch_id', e.target.value)}>
                      <option value="">선택하세요</option>
                      {branches.map((b) => (
                        <option key={b.id} value={b.id}>{b.name}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
                {!isClient ? (
                  <div className="field">
                    <label>요청 법인(고객사)</label>
                    <select value={state.requester_group_id} onChange={(e) => setField('requester_group_id', e.target.value)}>
                      <option value="">선택 안 함</option>
                      {groups.map((g) => (
                        <option key={g.id} value={g.id}>{g.name}</option>
                      ))}
                    </select>
                  </div>
                ) : null}
              </div>

              {/* 오더 타입 자체는 01번 자리의 오더구분 라디오로 옮겼다 — 여기는 그 라디오가
                  daily_driver일 때만 의미 있는 왕복/편도만 남긴다. */}
              {state.order_type === 'daily_driver' && (
                <div className="row">
                  <div className="field">
                    <label>이용 형태 (일일기사)</label>
                    <select value={state.trip_type || ''} onChange={(e) => setField('trip_type', e.target.value)}>
                      <option value="">해당 없음</option>
                      <option value="round_trip">왕복</option>
                      <option value="one_way">편도</option>
                    </select>
                  </div>
                </div>
              )}
            </>
          )}
          {state.trip_type === 'round_trip' && (
            <>
              <div className="section-title small">최종 목적지 (왕복 일일기사)</div>
              <div className="field full">
                <label>최종 목적지 주소</label>
                <input type="text" placeholder="기사가 최종적으로 복귀할 주소"
                  value={state.final_destination_address || ''}
                  onChange={(e) => setField('final_destination_address', e.target.value)} />
                <input type="text" placeholder="상세주소" style={{ marginTop: 4 }}
                  value={state.final_destination_address_detail || ''}
                  onChange={(e) => setField('final_destination_address_detail', e.target.value)} />
              </div>
            </>
          )}

          <div className="route-stop order-memo-stop">
          <div className="route-stop-title"><span className="route-marker">요청 메모</span></div>
          <div className="field full">
            <label>메모(콜마너 기사전달사항)</label>
            {/* 100Byte 제한을 라벨 바로 아래 둔다. 다 쓰고 나서 알려주면 이미 늦다 —
                쓰는 사람은 다 갔다고 믿고, 기사는 안 온 줄도 모른다. */}
            <p className="hint" style={{ margin: '0 0 6px' }}>
              콜마너 적요1(기사메모)로 나가며 <b>100Byte까지만</b> 전달됩니다.
              맨 앞에 차량번호가 붙어 본문에 쓸 수 있는 건 <b>{memoBudget.budget}Byte</b>
              (한글 {Math.floor(memoBudget.budget / 3)}자쯤)입니다.
              더 긴 내용은 아래 <b>기사 챗봇 전달사항</b>에 쓰시면 길이 제한 없이 전달됩니다.
            </p>
            {/* 실제 입력된 내용이 없으면 여러 줄짜리 큰 textarea 대신 한 줄 높이로 표시한다
                (사용자 요청) — 값이 생기면(입력 중이든 이미 저장돼 있든) 원래 높이로 돌아온다. */}
            <textarea className={state.memo_customer ? '' : 'single-line-textarea'}
              placeholder="예) 사고 이력 안내&#10;예) 스크래치 등 차량 관련 내용"
              value={state.memo_customer} onChange={(e) => setField('memo_customer', e.target.value)} />
            {/* textarea 안의 글자 일부만 색을 바꿀 수는 없다. 그래서 아래에 "실제로 나가는
                모양"을 따로 그린다 — 잘리는 부분이 눈에 보여야 고쳐 쓸 수 있다. */}
            {!!state.memo_customer && (
              <div className="memo-budget-preview">
                <span className="memo-budget-count">
                  {memoBudget.totalBytes} / {memoBudget.budget}Byte
                  {memoBudget.over ? ' — 회색 부분은 기사에게 전달되지 않습니다' : ''}
                </span>
                <div className="memo-budget-text">
                  <span className="kept">{memoBudget.kept}</span>
                  <span className="dropped">{memoBudget.dropped}</span>
                </div>
              </div>
            )}
          </div>
          <div className="field full">
            <label>업체 전달사항</label>
            <textarea className={state.memo_billing ? '' : 'single-line-textarea'}
              placeholder="예) 계산서/내역서 비고란에 'OOO'로 기재 요청"
              value={state.memo_billing} onChange={(e) => setField('memo_billing', e.target.value)} />
          </div>
          {/* 기사 챗봇 전달사항 — 길이 제한이 없는 유일한 통로다. 위 칸과 나눠 둔 이유가
              그 제한이다. 한 칸에 섞으면 길게 쓴 만큼 콜마너로 나가는 쪽이 잘린다. */}
          <div className="field full">
            <label>기사 챗봇 전달사항</label>
            <p className="hint" style={{ margin: '0 0 6px' }}>
              기사 채팅 화면에 그대로 보입니다. <b>길이 제한이 없습니다</b> —
              적요1에 못 담는 상세 안내를 여기에 쓰세요. 고객에게는 보이지 않습니다.
            </p>
            <textarea className={state.memo_driver_chat ? '' : 'single-line-textarea'}
              placeholder="예) 지하 3층 B구역 기둥 옆, 키는 콘솔박스&#10;예) 인수자 도착 15분 전에 전화 주세요"
              value={state.memo_driver_chat} onChange={(e) => setField('memo_driver_chat', e.target.value)} />
          </div>
          </div>

          {chatSessionId && (
            <div className="field" style={{ maxWidth: 260 }}>
              <label>등록 후 상담 상태</label>
              <select value={state.chat_session_transition} onChange={(e) => setField('chat_session_transition', e.target.value)}>
                <option value="agent_active">상담 계속 진행</option>
                <option value="closed">상담 종료</option>
              </select>
            </div>
          )}

          {error && <div className="error-msg">{error}</div>}

          {/* edit 모드는 저장 버튼을 페이지 상단(오더 리스트로 버튼 앞)으로 옮기고 취소
              버튼은 없앴다(사용자 요청) — 그 버튼은 이 <form id="order-edit-form">을
              form 속성으로 가리키는 별도 버튼(src/app/orders/[id]/page.js)이라 여기엔
              아무것도 남기지 않는다. create 모드는 기존과 동일하게 하단에 유지한다. */}
          {mode !== 'edit' && (
            <div className="order-form-actions">
              <a className="btn secondary" href="/orders">취소</a>
              <button className="btn" type="submit" disabled={submitting}>
                {submitting ? '등록 중...' : '오더 등록'}
              </button>
            </div>
          )}
        </section>
        </form>

        {isEdit ? (
          <>
            {/* 지도는 안 그리지만 경로탐색·요금 자동계산·배송기준 예약시간 역산은 그대로
                동작해야 해서, RouteMap에서 지도 렌더링만 뺀 헤드리스 버전을 붙인다. */}
            <RouteCalculator
              points={routePoints}
              originAddress={state.origin_address}
              destinationAddress={state.destination_address}
              onRouteUpdate={setRouteInfo}
            />
            <OrderSidePanel data={initialData} orderId={orderId} state={state} setField={setField} />
          </>
        ) : (
          <RouteMap
            points={routePoints}
            originAddress={state.origin_address}
            destinationAddress={state.destination_address}
            onRouteUpdate={setRouteInfo}
            priority={state.route_priority}
            onPriorityChange={(v) => setField('route_priority', v)}
          />
        )}
      </div>
      {isEdit && order.callmaner_last_error && (
        // data-error-signature는 callmaner-alert.js의 errorSignature()와 형식이 같아야 한다 —
        // 폴링이 "이미 화면에 보여주고 있는 실패"인지 판단해 팝업 중복을 피하는 데 쓴다.
        <div
          className="callmaner-error-badge"
          role="alert"
          data-error-signature={`${order.callmaner_last_error_code || ''}|${order.callmaner_last_error}`}
        >
          <strong>⚠️ 콜마너 연동 실패</strong>
          {/* 콜마너가 응답한 에러코드(rc). 좌표 누락 같은 우리 쪽 사전검증 실패는 요청이
              나가지 않아 코드가 없으므로 그 줄을 그리지 않는다. */}
          {order.callmaner_last_error_code && (
            <div className="callmaner-error-code">에러코드 {order.callmaner_last_error_code}</div>
          )}
          <div>{order.callmaner_last_error}</div>
        </div>
      )}
    </div>
  );
}
