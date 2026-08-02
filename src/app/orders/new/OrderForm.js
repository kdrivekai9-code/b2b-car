'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import AddressField from './AddressField';
import RouteMap from './RouteMap';
import OrderSidePanel from '../[id]/OrderSidePanel';

// Submits to the exact same POST /orders the legacy form.ejs uses, with the exact same
// field names and urlencoded wire format (verified directly against the live endpoint).
// Still deliberately NOT implemented in this slice (see docs/ai-stage-2-checklist.md for
// the disclosed scope trim): vehicle-type autocomplete, registered-address (favorites)
// picker beyond a simple list.

const DELIVERY_BUFFER_SECONDS = 30 * 60;
const DELIVERY_RESERVATION_MEMO_PREFIX = '**도착지 예약**:';

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
  return `${dt.getFullYear()}년 ${pad2(dt.getMonth() + 1)}월 ${pad2(dt.getDate())} 일 ${pad2(dt.getHours())}시 ${pad2(dt.getMinutes())} 분 도착요망`;
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
      lat: null, lon: null,
    }))
    : [];
  return {
    origin_address: order.origin_address || '', origin_detail_address: order.origin_detail_address || '', origin_contact: order.origin_contact || '',
    origin_lat: null, origin_lon: null,
    destination_address: order.destination_address || '', destination_detail_address: order.destination_detail_address || '', destination_contact: order.destination_contact || '',
    destination_lat: null, destination_lon: null,
    waypoints: prefillWaypoints,
    reservation_basis: order.reservation_basis === 'delivery' ? 'delivery' : 'pickup',
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
    sameAsMyPhone: false, sameAsOriginContact: false,
    chat_session_transition: 'agent_active',
  };
}

function reducer(state, action) {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.name]: action.value };
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
        waypoints: [...state.waypoints, { id: action.id, address: '', detail: '', contact: '', vehicleNumber: '', lat: null, lon: null }],
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

let waypointSeq = 0;

export default function OrderForm({ initialData, chatSessionId, mode = 'create', orderId, externalPrefill }) {
  const { order, branches, groups, paymentMethods, defaultBranch, currentUserRole, currentUserPhone } = initialData;
  const isEdit = mode === 'edit';
  const [state, dispatch] = useReducer(reducer, initialFieldState(order, defaultBranch, mode));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  const [routeInfo, setRouteInfo] = useState({ km: null, durationSec: null, toll: null, hasFerryLeg: false, isFinal: false });
  const [fareHint, setFareHint] = useState('');
  const [fareLocked, setFareLocked] = useState(false);
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

  // 예약기준 역산: order-form.js의 syncReservationBasisPreview/syncDeliveryReservationMemo를
  // 그대로 이식. routeInfo.durationSec(RouteMap이 실제 경로 확정 후 넘겨줌)에 의존하므로
  // 지도 레이어보다 먼저 만들 수 없었던 부분 — 이제 둘 다 있으니 여기서 연결한다.
  useEffect(() => {
    const deliveryDateTime = new Date(
      Number(state.reservedDateYear), Number(state.reservedDateMonth) - 1, Number(state.reservedDateDay),
      Number(state.reservedTimeHour), Number(state.reservedTimeMinute), 0, 0
    );
    const isDelivery = state.reservation_basis === 'delivery';

    if (!isDelivery) {
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
      dispatch({ type: 'SET_FIELD', name: 'ferry_fare_amount', value: data.ferryFare != null ? data.ferryFare : 0 });

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

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);

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

    const params = new URLSearchParams();
    params.set('branch_id', state.branch_id);
    params.set('requester_group_id', state.requester_group_id);
    params.set('origin_address', state.origin_address);
    params.set('origin_detail_address', state.origin_detail_address);
    params.set('origin_contact', state.origin_contact);
    params.set('destination_address', state.destination_address);
    params.set('destination_detail_address', state.destination_detail_address);
    params.set('destination_contact', state.destination_contact);
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
    params.set('memo_billing', state.memo_billing);
    if (chatSessionId) {
      params.set('chat_session_id', String(chatSessionId));
      params.set('chat_session_transition', state.chat_session_transition);
    }
    state.waypoints.forEach((w) => {
      params.append('waypoints[]', w.address);
      params.append('waypoint_details[]', w.detail);
      params.append('waypoint_contacts[]', w.contact);
      params.append('waypoint_vehicle_numbers[]', w.vehicleNumber);
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
        setSubmitting(false);
        return;
      }
      if (!res.ok) {
        setError('저장에 실패했습니다. 다시 시도해주세요.');
        setSubmitting(false);
        return;
      }
      if (mode === 'edit') {
        window.location.assign('/orders/' + orderId);
        return;
      }
      const data = await res.json();
      window.location.assign('/orders/' + data.orderId);
    } catch {
      setError('저장에 실패했습니다. 다시 시도해주세요.');
      setSubmitting(false);
    }
  }

  return (
    <div className="order-form">
      <div className="order-grid">
        {/* OrderSidePanel(03번 자리, edit 모드)이 기사배정용 <form>을 자체적으로 갖고 있어서
            — HTML은 <form> 중첩을 허용하지 않는다(중첩되면 브라우저가 파서 레벨에서 구조를
            바꿔버려 실제로 hydration mismatch가 났다). 그래서 이 <form>은 grid의 01/02
            섹션만 감싸고, display:contents로 grid 레이아웃 자체에는 관여하지 않게 한다. */}
        <form className="order-form-fields" onSubmit={handleSubmit} style={{ display: 'contents' }}>
        <section className="card order-panel route-panel">
          <div className="panel-title">
            <div className="panel-icon">01</div>
            <div><h2>이동 경로</h2><p>출발지와 도착지의 주소 및 연락처를 입력하세요.</p></div>
          </div>

          <div className="route-stop origin-stop">
            <div className="route-stop-title"><span className="route-marker">출발</span></div>
            <AddressField label="출발지 주소" required favorites={initialData.favorites}
              address={state.origin_address} detail={state.origin_detail_address}
              onAddressChange={(v) => setField('origin_address', v)}
              onDetailChange={(v) => setField('origin_detail_address', v)}
              onResolved={(lat, lon) => { setField('origin_lat', lat); setField('origin_lon', lon); }} />
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
                <button type="button" className="btn small secondary" onClick={() => dispatch({ type: 'REMOVE_WAYPOINT', id: w.id })}>삭제</button>
              </div>
            ))}
          </div>
          <button type="button" className="btn small secondary add-waypoint-btn"
            onClick={() => dispatch({ type: 'ADD_WAYPOINT', id: `wp-${++waypointSeq}` })}>+ 경유지 추가</button>

          <div className="route-stop destination-stop">
            <div className="route-stop-title"><span className="route-marker">도착</span></div>
            <AddressField label="도착지 주소" required favorites={initialData.favorites}
              address={state.destination_address} detail={state.destination_detail_address}
              onAddressChange={(v) => setField('destination_address', v)}
              onDetailChange={(v) => setField('destination_detail_address', v)}
              onResolved={(lat, lon) => { setField('destination_lat', lat); setField('destination_lon', lon); }} />
            <div className="field">
              <label>도착지 연락처 <span className="required-mark" aria-hidden="true">*</span></label>
              <input type="text" className="phone-input" required placeholder="010-0000-0000"
                value={state.destination_contact} onChange={(e) => { setField('sameAsOriginContact', false); setField('destination_contact', e.target.value); }} />
              <label className="checkline">
                <input type="checkbox" checked={state.sameAsOriginContact} onChange={(e) => handleSameAsOriginContact(e.target.checked)} /> 출발지 연락처와 동일
              </label>
            </div>
          </div>
        </section>

        <section className="card order-panel">
          <div className="panel-title">
            <div className="panel-icon">02</div>
            <div><h2>운행 및 요청 정보</h2><p>예약 일정, 귀속 정보, 요금 및 요청 메모를 확인하세요.</p></div>
          </div>

          <div className="section-title small">운행 일정</div>
          <div className="field full">
            <label>예약일시 <span className="required-mark" aria-hidden="true">*</span></label>
            {!isEdit && (
              <div className="inline-duo" style={{ marginBottom: 8, alignItems: 'center' }}>
                <label className="checkline">
                  <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'pickup'}
                    onChange={() => setField('reservation_basis', 'pickup')} /> 출발지 픽업시간 기준
                </label>
                <label className="checkline">
                  <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'delivery'}
                    onChange={() => setField('reservation_basis', 'delivery')} /> 도착지 인도시간 기준
                </label>
              </div>
            )}
            <div className="inline-duo reservation-datetime-row">
              <div className="inline-duo reservation-date-row">
                <select className="date-select" aria-label="예약 연도" value={state.reservedDateYear}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateYear', value: e.target.value })}>
                  {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => (
                    <option key={y} value={String(y)}>{y}년</option>
                  ))}
                </select>
                <select className="date-select" aria-label="예약 월" value={state.reservedDateMonth}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateMonth', value: e.target.value })}>
                  {Array.from({ length: 12 }, (_, i) => pad2(i + 1)).map((mm) => (
                    <option key={mm} value={mm}>{mm}월</option>
                  ))}
                </select>
                <select className="date-select" aria-label="예약 일" value={state.reservedDateDay}
                  onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateDay', value: e.target.value })}>
                  {Array.from({ length: getLastDayOfMonth(state.reservedDateYear, state.reservedDateMonth) }, (_, i) => pad2(i + 1)).map((dd) => (
                    <option key={dd} value={dd}>{dd}일</option>
                  ))}
                </select>
              </div>
              <select className="time-select" value={state.reservedTimeHour} onChange={(e) => setField('reservedTimeHour', e.target.value)}>
                {Array.from({ length: 24 }, (_, h) => pad2(h)).map((hh) => (
                  <option key={hh} value={hh}>{hh}시</option>
                ))}
              </select>
              <select className="time-select" value={state.reservedTimeMinute} onChange={(e) => setField('reservedTimeMinute', e.target.value)}>
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

          <div className="section-title small">결제 및 요금</div>
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

          <div className="section-title small">귀속 정보</div>
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

          <div className="section-title small">요청 메모</div>
          <div className="field full">
            <label>메모(기사전달사항)</label>
            <textarea placeholder="예) 사고 이력 안내&#10;예) 스크래치 등 차량 관련 내용"
              value={state.memo_customer} onChange={(e) => setField('memo_customer', e.target.value)} />
          </div>
          <div className="field full">
            <label>업체 전달사항</label>
            <textarea placeholder="예) 계산서/내역서 비고란에 'OOO'로 기재 요청"
              value={state.memo_billing} onChange={(e) => setField('memo_billing', e.target.value)} />
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

          <div className="order-form-actions">
            <a className="btn secondary" href={mode === 'edit' ? `/orders/${orderId}` : '/orders'}>취소</a>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? (mode === 'edit' ? '저장 중...' : '등록 중...') : (mode === 'edit' ? '오더 정보 저장' : '오더 등록')}
            </button>
          </div>
        </section>
        </form>

        {isEdit ? (
          <OrderSidePanel data={initialData} orderId={orderId} />
        ) : (
          <RouteMap
            points={routePoints}
            originAddress={state.origin_address}
            destinationAddress={state.destination_address}
            onRouteUpdate={setRouteInfo}
          />
        )}
      </div>
    </div>
  );
}
