'use client';

import { useEffect, useReducer, useRef, useState } from 'react';
import RouteCalculator from '../../orders/new/RouteCalculator';

// views/chat/session_list.ejs의 #cardOrderForm(전용 접수 미니폼)을 그대로 React로 이식한
// 것 — public/js/chat-session-cards.js의 관련 로직(주소검색/차종 자동완성/경유지 추가/
// 픽업-인도 자동계산)을 필드 단위로 재현한다. /orders/new의 OrderForm과는 완전히 다른,
// 채팅 접수 전용의 더 단순한 폼(지도·프리미엄/일일기사 필드·즐겨찾기·요금 자동계산 없음 —
// legacy에도 없던 것들이라 여기서도 안 넣는다)이라 별도 컴포넌트로 둔다. 제출은 legacy처럼
// 순수 form POST로 다른 화면(주문 등록 폼)으로 튕겨나가지 않도록 fetch 기반으로 하되,
// 최종적으로 POST /orders에 legacy와 동일한 필드/이름으로 보내고 성공 시 /orders/:id로
// 이동한다(서버 응답은 legacy의 res.redirect와 완전히 동일한 목적지).

const DELIVERY_BUFFER_SECONDS = 30 * 60;
// OrderForm.js와 동일한 규칙(사용자 요청) — 도착지 인도시간 기준일 때만 요청사항에 원래
// 고객이 말한 인도 요청 시각을 남긴다. 예전엔 "메모는 자유 텍스트라 자동 삽입 안 함"이라고
// 미뤄뒀었는데, 실제로는 픽업 시각만 남으면 기사에게 "몇 시까지 인도해야 하는지"가 전달이
// 안 돼서 다른 화면과 맞춰 넣기로 했다.
const DELIVERY_RESERVATION_MEMO_PREFIX = '일시:';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function formatDeliveryReservationMemoDateTime(dt) {
  return `${pad2(dt.getMonth() + 1)}/${pad2(dt.getDate())} ${pad2(dt.getHours())}시${pad2(dt.getMinutes())}분 도착요망`;
}

function deriveMemoWithReservationLine(currentMemo, isDeliveryBasis, deliveryDateTime) {
  const hasMemo = String(currentMemo || '').trim().length > 0;
  const rawLines = hasMemo ? String(currentMemo).split(/\r?\n/) : [];
  const keptLines = rawLines.filter((line) => String(line || '').trim().indexOf(DELIVERY_RESERVATION_MEMO_PREFIX) !== 0);
  if (isDeliveryBasis && deliveryDateTime && !Number.isNaN(deliveryDateTime.getTime())) {
    keptLines.push(`${DELIVERY_RESERVATION_MEMO_PREFIX} ${formatDeliveryReservationMemoDateTime(deliveryDateTime)}`);
  }
  return keptLines.join('\n').replace(/^\n+|\n+$/g, '');
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

function formatLocalDateTime(dt) {
  if (!dt || Number.isNaN(dt.getTime())) return '-';
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())} ${pad2(dt.getHours())}:${pad2(dt.getMinutes())}`;
}

function formatDuration(seconds) {
  const totalMin = Math.round(Number(seconds || 0) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

// chat-session-cards.js의 normalizePhoneInput을 그대로 이식(controlled input이라 값을
// 리턴하는 형태로 바꿈).
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '').slice(0, 11);
  if (!digits) return '';
  if (digits.length === 8) return digits.slice(0, 4) + '-' + digits.slice(4);
  if (digits.indexOf('02') === 0) {
    if (digits.length <= 5) return digits.slice(0, 2) + '-' + digits.slice(2);
    if (digits.length <= 9) return digits.slice(0, 2) + '-' + digits.slice(2, 5) + '-' + digits.slice(5);
    return digits.slice(0, 2) + '-' + digits.slice(2, 6) + '-' + digits.slice(6, 10);
  }
  if (digits.length <= 6) return digits.slice(0, 3) + '-' + digits.slice(3);
  if (digits.length <= 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7, 11);
}

async function geocode(query) {
  try {
    const res = await fetch('/kakao/search?q=' + encodeURIComponent(query));
    const data = await res.json();
    return data.documents || [];
  } catch {
    return [];
  }
}

// 콜마너 오더접수 연동에 필요한 시도/시구군/동 — 주소 확정(위경도 확보) 시점에 1회만 조회한다.
async function resolveRegion(lat, lon) {
  try {
    const res = await fetch(`/kakao/region?lat=${lat}&lng=${lon}`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function mainAddressOf(r) {
  return r.road_address || r.jibun_address || '';
}

function resultLabel(r) {
  if (r.type === 'place') {
    const addr = mainAddressOf(r);
    return r.place_name + (addr ? ' · ' + addr : '');
  }
  const main = mainAddressOf(r);
  const sub = r.road_address && r.jibun_address && r.road_address !== r.jibun_address ? r.jibun_address : null;
  return main + (sub ? ' (' + sub + ')' : '');
}

// 출발지/도착지/경유지 공용 — legacy와 동일하게 입력 중 실시간 검색은 없고(검색 버튼/Enter만),
// 2글자 이상, 최대 5건, 하이라이트 없음(legacy도 없음).
function MiniAddressSearch({ address, onAddressChange, onResolved }) {
  const [results, setResults] = useState(null); // null=숨김, []=결과없음, [...]=결과

  async function runSearch() {
    const q = String(address || '').trim();
    if (q.length < 2) {
      setResults([]);
      return;
    }
    setResults('loading');
    const docs = await geocode(q);
    setResults(docs.slice(0, 5));
  }

  return (
    <>
      <div className="addr-input-row">
        <input
          type="text"
          value={address}
          onChange={(e) => onAddressChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); runSearch(); } }}
          placeholder="도로명/지번/상호"
        />
        <button type="button" className="btn small secondary" onClick={runSearch}>🔍 검색</button>
      </div>
      <div className="addr-results">
        {results === 'loading' && <div className="addr-result-item muted">검색 중...</div>}
        {Array.isArray(results) && results.length === 0 && <div className="addr-result-item muted">검색 결과가 없습니다.</div>}
        {Array.isArray(results) && results.map((r, i) => (
          <div className="addr-result-item" key={i} onClick={async () => {
            onAddressChange(mainAddressOf(r));
            const lat = parseFloat(r.lat);
            const lon = parseFloat(r.lon);
            onResolved(lat, lon, await resolveRegion(lat, lon));
            setResults(null);
          }}>
            {resultLabel(r)}
          </div>
        ))}
      </div>
    </>
  );
}

function initialState(order) {
  const now = new Date();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(order.reserved_date || '');
  const t = /^(\d{2}):(\d{2})$/.exec(order.reserved_time || '');
  const waypoints = Array.isArray(order.waypoints)
    ? order.waypoints.map((w, i) => ({ id: 'prefill-' + i, address: w.address || '', detail: w.detail || '', contact: w.contact || '', vehicleNumber: w.vehicleNumber || '', lat: null, lon: null }))
    : [];
  return {
    branch_id: order.branch_id || '',
    requester_group_id: order.requester_group_id || '',
    reservation_basis: (order.reservation_basis === 'delivery' || order.reservation_basis === 'immediate') ? order.reservation_basis : 'pickup',
    // 이 미니폼은 탁송 접수만 다룬다(오더구분 선택 자체가 없음) — 그래서 경로탐색 기본값도
    // 탁송 기준(무료도로)으로 고정한다. 사용자가 드롭다운에서 직접 바꾸면 그 값을 그대로 쓴다.
    route_priority: 'FREE',
    reservedDateYear: m ? m[1] : String(now.getFullYear()),
    reservedDateMonth: m ? m[2] : pad2(now.getMonth() + 1),
    reservedDateDay: m ? m[3] : pad2(now.getDate()),
    reservedTimeHour: t ? t[1] : pad2(now.getHours()),
    reservedTimeMinute: t ? t[2] : pad2(now.getMinutes()),
    pickup_reserved_date: '',
    pickup_reserved_time: '',
    origin_address: order.origin_address || '', origin_detail_address: order.origin_detail_address || '', origin_contact: order.origin_contact || '',
    origin_lat: null, origin_lon: null, origin_sido: '', origin_sigugun: '', origin_dong: '',
    vehicle_type: order.vehicle_type || '', vehicle_number: order.vehicle_number || '',
    waypoints,
    destination_address: order.destination_address || '', destination_detail_address: order.destination_detail_address || '', destination_contact: order.destination_contact || '',
    destination_lat: null, destination_lon: null, destination_sido: '', destination_sigugun: '', destination_dong: '',
    memo_customer: order.memo_customer || '',
    payment_method_id: order.payment_method_id || '',
    fare_amount: order.fare_amount || '',
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
      if (Number(next.reservedDateDay || 1) > lastDay) next.reservedDateDay = pad2(lastDay);
      return next;
    }
    case 'ADD_WAYPOINT':
      return { ...state, waypoints: [...state.waypoints, { id: action.id, address: '', detail: '', contact: '', vehicleNumber: '', lat: null, lon: null }] };
    case 'REMOVE_WAYPOINT':
      return { ...state, waypoints: state.waypoints.filter((w) => w.id !== action.id) };
    case 'SET_WAYPOINT_FIELD':
      return { ...state, waypoints: state.waypoints.map((w) => (w.id === action.id ? { ...w, [action.field]: action.value } : w)) };
    default:
      return state;
  }
}

let waypointSeq = 0;

export default function IntakeMiniForm({ chatSessionId, branches, groups, paymentMethods, order }) {
  const [state, dispatch] = useReducer(reducer, initialState(order));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);
  // 이 세션에서 이미 오더를 등록했는지 — 있으면 제출 버튼이 "오더 등록" 대신 "오더 수정"으로
  // 바뀌고 이후 제출은 새로 만들지 않고 그 오더를 갱신한다. 세션을 바꾸면(부모가
  // key={selected.id}로 리마운트) 자연히 초기화된다.
  const [createdOrder, setCreatedOrder] = useState(null); // { id, oid } | null
  const [successMessage, setSuccessMessage] = useState('');
  const [routeInfo, setRouteInfo] = useState({ km: null, durationSec: null });
  const [vehicleTypeSuggestions, setVehicleTypeSuggestions] = useState([]);
  const [fareHint, setFareHint] = useState('');
  const vehicleTypeDebounceRef = useRef(null);
  // "방금 도착지 인도시간 기준에서 벗어났다"를 판단하기 위한 직전 예약기준.
  const previousReservationBasisRef = useRef(state.reservation_basis);
  const fareRequestIdRef = useRef(0);
  const vehicleTypeRequired = /제주/.test(state.destination_address || '');

  function setField(name, value) {
    dispatch({ type: 'SET_FIELD', name, value });
  }

  const routePoints = [
    { slot: 'origin', lat: state.origin_lat, lon: state.origin_lon },
    ...state.waypoints.map((w) => ({ slot: w.id, lat: w.lat, lon: w.lon })),
    { slot: 'destination', lat: state.destination_lat, lon: state.destination_lon },
  ];

  // 예약기준 역산 — OrderForm.js와 동일 로직(도착지 인도시간 기준일 때만 출발지 픽업시간을
  // 경로탐색 소요시간 + 30분 여유로 역산, 요청사항에 "일시: MM/DD HH시MM분 도착요망" 줄도
  // 같이 남긴다 — 사용자 요청).
  useEffect(() => {
    const justLeftDeliveryForPickup = previousReservationBasisRef.current === 'delivery' && state.reservation_basis === 'pickup';
    previousReservationBasisRef.current = state.reservation_basis;

    if (state.reservation_basis === 'immediate') {
      // 즉시 선택 시 예약 날짜/시간을 현재 시각(10분 단위 반올림)으로 맞춘다.
      const now = roundDateToNearestTenMinutes(new Date());
      const y = String(now.getFullYear());
      const mo = pad2(now.getMonth() + 1);
      const d = pad2(now.getDate());
      const h = pad2(now.getHours());
      const mi = pad2(now.getMinutes());
      if (state.reservedDateYear !== y) setField('reservedDateYear', y);
      if (state.reservedDateMonth !== mo) setField('reservedDateMonth', mo);
      if (state.reservedDateDay !== d) setField('reservedDateDay', d);
      if (state.reservedTimeHour !== h) setField('reservedTimeHour', h);
      if (state.reservedTimeMinute !== mi) setField('reservedTimeMinute', mi);
      if (state.pickup_reserved_date !== `${y}-${mo}-${d}`) setField('pickup_reserved_date', `${y}-${mo}-${d}`);
      if (state.pickup_reserved_time !== `${h}:${mi}`) setField('pickup_reserved_time', `${h}:${mi}`);
      return;
    }
    if (state.reservation_basis !== 'delivery') {
      // 도착지 인도시간 기준에서 막 픽업시간 기준으로 바꾼 경우, 화면에 남은 시각은 인도
      // 요청 시각이지 픽업 시각이 아니다 — 직전에 계산해둔 픽업 시각을 화면에 반영한다
      // (OrderForm.js와 동일한 규칙).
      if (justLeftDeliveryForPickup && state.pickup_reserved_date && state.pickup_reserved_time) {
        const [py, pmo, pd] = state.pickup_reserved_date.split('-');
        const [ph, pmi] = state.pickup_reserved_time.split(':');
        if (py && pmo && pd && ph && pmi) {
          if (state.reservedDateYear !== py) setField('reservedDateYear', py);
          if (state.reservedDateMonth !== pmo) setField('reservedDateMonth', pmo);
          if (state.reservedDateDay !== pd) setField('reservedDateDay', pd);
          if (state.reservedTimeHour !== ph) setField('reservedTimeHour', ph);
          if (state.reservedTimeMinute !== pmi) setField('reservedTimeMinute', pmi);
          const nextMemo = deriveMemoWithReservationLine(state.memo_customer, false, null);
          if (nextMemo !== state.memo_customer) setField('memo_customer', nextMemo);
          return;
        }
      }
      const nextDate = `${state.reservedDateYear}-${state.reservedDateMonth}-${state.reservedDateDay}`;
      const nextTime = `${state.reservedTimeHour}:${state.reservedTimeMinute}`;
      if (state.pickup_reserved_date !== nextDate) setField('pickup_reserved_date', nextDate);
      if (state.pickup_reserved_time !== nextTime) setField('pickup_reserved_time', nextTime);
      const nextMemo = deriveMemoWithReservationLine(state.memo_customer, false, null);
      if (nextMemo !== state.memo_customer) setField('memo_customer', nextMemo);
      return;
    }
    const deliveryDateTime = new Date(
      Number(state.reservedDateYear), Number(state.reservedDateMonth) - 1, Number(state.reservedDateDay),
      Number(state.reservedTimeHour), Number(state.reservedTimeMinute), 0, 0
    );
    const durationSec = routeInfo.durationSec;
    if (!Number.isFinite(durationSec) || durationSec <= 0) {
      if (state.pickup_reserved_date) setField('pickup_reserved_date', '');
      if (state.pickup_reserved_time) setField('pickup_reserved_time', '');
    } else {
      const rounded = roundDateToNearestTenMinutes(new Date(deliveryDateTime.getTime() - (durationSec + DELIVERY_BUFFER_SECONDS) * 1000));
      const nextDate = `${rounded.getFullYear()}-${pad2(rounded.getMonth() + 1)}-${pad2(rounded.getDate())}`;
      const nextTime = `${pad2(rounded.getHours())}:${pad2(rounded.getMinutes())}`;
      if (state.pickup_reserved_date !== nextDate) setField('pickup_reserved_date', nextDate);
      if (state.pickup_reserved_time !== nextTime) setField('pickup_reserved_time', nextTime);
    }
    const nextMemo = deriveMemoWithReservationLine(state.memo_customer, true, deliveryDateTime);
    if (nextMemo !== state.memo_customer) setField('memo_customer', nextMemo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.reservation_basis, state.reservedDateYear, state.reservedDateMonth, state.reservedDateDay, state.reservedTimeHour, state.reservedTimeMinute, routeInfo.durationSec]);

  // 고객이 AI 접수 챗봇에서 계속 답변하면 CardBoard가 접수 초안을 다시 불러와 order prop을
  // 갱신한다(handleNewCustomerMessage) — 세션을 다시 선택한 게 아니라 컴포넌트가 리마운트되지
  // 않으므로, 여기서 최신 값을 상태에 반영한다. 주소는 검색/좌표확정이 얽혀있어 자동 덮어쓰기
  // 대상에서 뺐고, 상담원이 이미 손댔을 수 있는 값을 무조건 덮지 않도록 폼이 아직 비어있거나
  // 챗봇 쪽 값이 더 최신(다른 값)일 때만 반영한다.
  useEffect(() => {
    if (order.origin_contact && order.origin_contact !== state.origin_contact) setField('origin_contact', order.origin_contact);
    if (order.destination_contact && order.destination_contact !== state.destination_contact) setField('destination_contact', order.destination_contact);
    if (order.memo_customer && order.memo_customer !== state.memo_customer) setField('memo_customer', order.memo_customer);
    if (order.fare_amount && String(order.fare_amount) !== String(state.fare_amount)) setField('fare_amount', order.fare_amount);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.origin_contact, order.destination_contact, order.memo_customer, order.fare_amount]);

  // 요금 자동계산 — OrderForm.js와 동일 로직(경로 거리(routeInfo.km)가 나오면
  // /orders/fare-preview 호출). 이 미니폼은 도선료 관련 안내 UI가 따로 없어서 결과의
  // ferryFare는 화면에 안 보여주고 fare_amount에만 총액을 반영한다.
  useEffect(() => {
    if (routeInfo.km == null || !state.branch_id) {
      setFareHint('');
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
        return;
      }
      setField('fare_amount', String(data.totalFare != null ? data.totalFare : data.fare));
      setFareHint(`구간요금 설정에 따라 자동 계산되었습니다 (${routeInfo.km.toFixed(1)}km 기준). 필요 시 직접 수정할 수 있습니다.`);
    }, 250);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.branch_id, routeInfo.km, routeInfo.hasFerryLeg, JSON.stringify(routeInfo.ferrySegments), state.vehicle_type, state.origin_address, state.reservation_basis, state.pickup_reserved_date, state.pickup_reserved_time, state.reservedDateYear, state.reservedDateMonth, state.reservedDateDay, state.reservedTimeHour, state.reservedTimeMinute]);

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

  async function handleSubmit(e) {
    e.preventDefault();
    setError(null);
    setSuccessMessage('');

    if (state.reservation_basis === 'delivery' && (!state.pickup_reserved_date || !state.pickup_reserved_time)) {
      window.alert('도착지 인도시간 기준은 경로가 확정되어야 출발지 픽업일시를 계산할 수 있습니다. 주소를 확인한 뒤 다시 시도해주세요.');
      return;
    }

    const reservedDate = `${state.reservedDateYear}-${state.reservedDateMonth}-${state.reservedDateDay}`;
    const reservedTime = `${state.reservedTimeHour}:${state.reservedTimeMinute}`;
    const params = new URLSearchParams();
    params.set('branch_id', state.branch_id);
    params.set('requester_group_id', state.requester_group_id);
    params.set('origin_address', state.origin_address);
    params.set('origin_detail_address', state.origin_detail_address);
    params.set('origin_contact', state.origin_contact);
    params.set('destination_address', state.destination_address);
    params.set('destination_detail_address', state.destination_detail_address);
    params.set('destination_contact', state.destination_contact);
    if (state.origin_lat != null) params.set('origin_lat', String(state.origin_lat));
    if (state.origin_lon != null) params.set('origin_lon', String(state.origin_lon));
    if (state.origin_sido) params.set('origin_sido', state.origin_sido);
    if (state.origin_sigugun) params.set('origin_sigugun', state.origin_sigugun);
    if (state.origin_dong) params.set('origin_dong', state.origin_dong);
    if (state.destination_lat != null) params.set('destination_lat', String(state.destination_lat));
    if (state.destination_lon != null) params.set('destination_lon', String(state.destination_lon));
    if (state.destination_sido) params.set('destination_sido', state.destination_sido);
    if (state.destination_sigugun) params.set('destination_sigugun', state.destination_sigugun);
    if (state.destination_dong) params.set('destination_dong', state.destination_dong);
    params.set('vehicle_type', state.vehicle_type);
    params.set('vehicle_number', state.vehicle_number);
    params.set('reserved_date', reservedDate);
    params.set('reserved_time', reservedTime);
    params.set('pickup_reserved_date', state.pickup_reserved_date || reservedDate);
    params.set('pickup_reserved_time', state.pickup_reserved_time || reservedTime);
    params.set('payment_method_id', state.payment_method_id);
    params.set('fare_amount', state.fare_amount);
    params.set('memo_customer', state.memo_customer);
    params.set('chat_session_id', String(chatSessionId));
    params.set('chat_session_transition', state.chat_session_transition);
    state.waypoints.forEach((w) => {
      params.append('waypoints[]', w.address);
      params.append('waypoint_details[]', w.detail);
      params.append('waypoint_contacts[]', w.contact);
      params.append('waypoint_vehicle_numbers[]', w.vehicleNumber);
    });

    const isEdit = !!createdOrder;
    setSubmitting(true);
    try {
      const res = await fetch(isEdit ? `/orders/${createdOrder.id}` : '/orders', {
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
      const data = await res.json();
      if (isEdit) {
        setSuccessMessage(`${createdOrder.oid} 오더 정보를 수정했습니다.`);
      } else {
        setCreatedOrder({ id: data.orderId, oid: data.oid });
        setSuccessMessage(`${data.oid} 오더가 정상적으로 등록되었습니다.`);
        // 콜마너 오더접수는 fire-and-forget이라 이 시점엔 아직 결과가 안 나왔을 수 있다 —
        // 실패하면 짧게 폴링해서 팝업으로 알려준다(public/js/callmaner-alert.js).
        if (typeof window !== 'undefined' && window.__callmanerAlert) window.__callmanerAlert.poll(data.orderId);
      }
      setSubmitting(false);
    } catch {
      setError('저장에 실패했습니다. 다시 시도해주세요.');
      setSubmitting(false);
    }
  }

  return (
    <form className="chat-order-form chat-admin-order-form" onSubmit={handleSubmit}>
      <RouteCalculator points={routePoints} originAddress={state.origin_address} destinationAddress={state.destination_address} onRouteUpdate={setRouteInfo} priority={state.route_priority} />

      <div className="route-search-header">
        <div className="section-title small" style={{ margin: 0 }}>🧭 경로탐색</div>
        <select className="route-priority-select" value={state.route_priority} onChange={(e) => setField('route_priority', e.target.value)}>
          <option value="RECOMMEND">추천</option>
          <option value="TIME">최단시간</option>
          <option value="DISTANCE">최단거리</option>
          <option value="FREE">무료도로</option>
        </select>
      </div>

      <div className="row">
        <div className="field">
          <label>지사 선택 <span className="required-mark" aria-hidden="true">*</span></label>
          <select required value={state.branch_id} onChange={(e) => setField('branch_id', e.target.value)}>
            <option value="">선택하세요</option>
            {branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>요청 법인(고객사)</label>
          <select value={state.requester_group_id} onChange={(e) => setField('requester_group_id', e.target.value)}>
            <option value="">선택 안 함</option>
            {groups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
        </div>
      </div>

      <div className="inline-duo" style={{ marginBottom: 8, alignItems: 'center' }}>
        <label className="checkline">
          <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'immediate'} onChange={() => setField('reservation_basis', 'immediate')} /> 즉시
        </label>
        <label className="checkline">
          <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'pickup'} onChange={() => setField('reservation_basis', 'pickup')} /> 출발지 픽업시간 기준
        </label>
        <label className="checkline">
          <input type="radio" name="reservation_basis" checked={state.reservation_basis === 'delivery'} onChange={() => setField('reservation_basis', 'delivery')} /> 도착지 인도시간 기준
        </label>
      </div>

      <div className="row">
        <div className="field">
          <label>예약일시 <span className="required-mark" aria-hidden="true">*</span></label>
          <div className="inline-duo reservation-date-row">
            <select className="date-select" aria-label="예약 연도" value={state.reservedDateYear} disabled={state.reservation_basis === 'immediate'}
              onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateYear', value: e.target.value })}>
              {Array.from({ length: 5 }, (_, i) => new Date().getFullYear() - 1 + i).map((y) => <option key={y} value={String(y)}>{y}년</option>)}
            </select>
            <select className="date-select" aria-label="예약 월" value={state.reservedDateMonth} disabled={state.reservation_basis === 'immediate'}
              onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateMonth', value: e.target.value })}>
              {Array.from({ length: 12 }, (_, i) => pad2(i + 1)).map((mm) => <option key={mm} value={mm}>{mm}월</option>)}
            </select>
            <select className="date-select" aria-label="예약 일" value={state.reservedDateDay} disabled={state.reservation_basis === 'immediate'}
              onChange={(e) => dispatch({ type: 'SET_RESERVED_DATE_PART', name: 'reservedDateDay', value: e.target.value })}>
              {Array.from({ length: getLastDayOfMonth(state.reservedDateYear, state.reservedDateMonth) }, (_, i) => pad2(i + 1)).map((dd) => <option key={dd} value={dd}>{dd}일</option>)}
            </select>
          </div>
        </div>
        <div className="field">
          <label>예약 시간 <span className="required-mark" aria-hidden="true">*</span></label>
          <div className="time-inline-row">
            <div className="time-inline-cell">
              <select aria-label="예약 시간 시" value={state.reservedTimeHour} disabled={state.reservation_basis === 'immediate'} onChange={(e) => setField('reservedTimeHour', e.target.value)}>
                {Array.from({ length: 24 }, (_, h) => pad2(h)).map((hh) => <option key={hh} value={hh}>{hh}시</option>)}
              </select>
            </div>
            <div className="time-inline-cell">
              <select aria-label="예약 시간 분" value={state.reservedTimeMinute} disabled={state.reservation_basis === 'immediate'} onChange={(e) => setField('reservedTimeMinute', e.target.value)}>
                {Array.from({ length: 60 }, (_, m) => pad2(m)).map((mm) => <option key={mm} value={mm}>{mm}분</option>)}
              </select>
            </div>
          </div>
        </div>
      </div>

      <div className="field full">
        <label>출발지 주소 <span className="required-mark" aria-hidden="true">*</span></label>
        <MiniAddressSearch address={state.origin_address} onAddressChange={(v) => setField('origin_address', v)}
          onResolved={(lat, lon, region) => {
            setField('origin_lat', lat); setField('origin_lon', lon);
            if (region) { setField('origin_sido', region.sido); setField('origin_sigugun', region.sigugun); setField('origin_dong', region.dong); }
          }} />
      </div>
      <div className="field full">
        <label>출발지 상세주소</label>
        <input type="text" value={state.origin_detail_address} onChange={(e) => setField('origin_detail_address', e.target.value)} placeholder="건물명, 동/호수, 주차위치" />
      </div>
      <div className="row">
        <div className="field">
          <label>출발지 연락처 <span className="required-mark" aria-hidden="true">*</span></label>
          <input type="text" required placeholder="010-0000-0000" value={state.origin_contact}
            onChange={(e) => setField('origin_contact', e.target.value)} onBlur={(e) => setField('origin_contact', normalizePhone(e.target.value))} />
        </div>
      </div>

      {state.reservation_basis === 'delivery' && (
        <div className="card-reservation-summary">
          <div className="card-reservation-summary-title">도착지 인도시간 기준 자동 계산</div>
          <div className="card-reservation-summary-main">
            <span className="label">예상 픽업시간</span>
            <strong>{state.pickup_reserved_date && state.pickup_reserved_time ? `${state.pickup_reserved_date} ${state.pickup_reserved_time}` : '경로 확정 후 자동 계산'}</strong>
          </div>
          <div className="card-reservation-summary-sub">
            {routeInfo.durationSec ? `(경로탐색 : ${formatDuration(routeInfo.durationSec)} +30분여유)` : '(경로탐색 : 경로 확정 후 자동 계산)'}
          </div>
        </div>
      )}

      <div className="row">
        <div className="field" style={{ position: 'relative' }}>
          <label>
            차종{vehicleTypeRequired && <span className="required-mark" aria-hidden="true"> *</span>} ({vehicleTypeRequired ? '필수' : '선택'})
          </label>
          <input type="text" autoComplete="off" required={vehicleTypeRequired} placeholder="예: 카니발, 1톤"
            value={state.vehicle_type} onChange={(e) => handleVehicleTypeChange(e.target.value)} />
          {vehicleTypeSuggestions.length > 0 && (
            <div className="addr-results">
              {vehicleTypeSuggestions.map((s) => (
                <div className="addr-result-item" key={s} onClick={() => { setField('vehicle_type', s); setVehicleTypeSuggestions([]); }}>{s}</div>
              ))}
            </div>
          )}
        </div>
        <div className="field">
          <label>출발지 차량번호 (선택)</label>
          <input type="text" placeholder="예: 12가3456" value={state.vehicle_number} onChange={(e) => setField('vehicle_number', e.target.value)} />
        </div>
      </div>

      <div className="field full" style={{ marginTop: 4 }}>
        <div className="chat-order-waypoint-head">
          <button type="button" className="btn small secondary" onClick={() => dispatch({ type: 'ADD_WAYPOINT', id: `wp-${++waypointSeq}` })}>+ 경유지 추가</button>
        </div>
        <div className="chat-waypoint-list">
          {state.waypoints.map((w) => (
            <div className="chat-waypoint-item" key={w.id}>
              <div className="chat-waypoint-address-col">
                <MiniAddressSearch address={w.address}
                  onAddressChange={(v) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'address', value: v })}
                  onResolved={(lat, lon) => {
                    dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'lat', value: lat });
                    dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'lon', value: lon });
                  }} />
              </div>
              <input type="text" placeholder="경유지 연락처 (선택)" value={w.contact}
                onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'contact', value: e.target.value })}
                onBlur={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'contact', value: normalizePhone(e.target.value) })} />
              <input type="text" placeholder="경유지 차량번호 (선택)" value={w.vehicleNumber}
                onChange={(e) => dispatch({ type: 'SET_WAYPOINT_FIELD', id: w.id, field: 'vehicleNumber', value: e.target.value })} />
              <button type="button" className="btn small secondary" onClick={() => dispatch({ type: 'REMOVE_WAYPOINT', id: w.id })}>삭제</button>
            </div>
          ))}
        </div>
      </div>

      <div className="field full">
        <label>도착지 주소 <span className="required-mark" aria-hidden="true">*</span></label>
        <MiniAddressSearch address={state.destination_address} onAddressChange={(v) => setField('destination_address', v)}
          onResolved={(lat, lon, region) => {
            setField('destination_lat', lat); setField('destination_lon', lon);
            if (region) { setField('destination_sido', region.sido); setField('destination_sigugun', region.sigugun); setField('destination_dong', region.dong); }
          }} />
      </div>
      <div className="field full">
        <label>도착지 상세주소</label>
        <input type="text" value={state.destination_detail_address} onChange={(e) => setField('destination_detail_address', e.target.value)} placeholder="건물명, 동/호수, 주차위치" />
      </div>
      <div className="field">
        <label>도착지 연락처 <span className="required-mark" aria-hidden="true">*</span></label>
        <input type="text" required placeholder="010-0000-0000" value={state.destination_contact}
          onChange={(e) => setField('destination_contact', e.target.value)} onBlur={(e) => setField('destination_contact', normalizePhone(e.target.value))} />
      </div>

      <div className="field full">
        <label>메모</label>
        <textarea value={state.memo_customer} onChange={(e) => setField('memo_customer', e.target.value)} placeholder="요청사항, 차량 상태, 전달 메모" />
      </div>

      <div className="row">
        <div className="field">
          <label>결제방식</label>
          <select value={state.payment_method_id} onChange={(e) => setField('payment_method_id', e.target.value)}>
            <option value="">선택 안 함</option>
            {paymentMethods.map((pm) => <option key={pm.id} value={pm.id}>{pm.name}</option>)}
          </select>
        </div>
        <div className="field">
          <label>요금(원)</label>
          <input type="number" min="0" step="1000" placeholder="0" value={state.fare_amount} onChange={(e) => setField('fare_amount', e.target.value)} />
          {fareHint && <p className="fare-calc-hint calculated">{fareHint}</p>}
        </div>
      </div>

      {error && <div className="error-msg">{error}</div>}
      {successMessage && <div className="badge green" style={{ display: 'block', marginBottom: 14 }}>{successMessage}</div>}

      <div className="chat-order-actions">
        <div className="field" style={{ margin: 0, minWidth: 220 }}>
          <label style={{ margin: '0 0 6px' }}>등록 후 상담 상태</label>
          <select value={state.chat_session_transition} onChange={(e) => setField('chat_session_transition', e.target.value)}>
            <option value="agent_active">상담 계속 진행</option>
            <option value="closed">상담 종료</option>
          </select>
        </div>
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? (createdOrder ? '수정 중...' : '등록 중...') : (createdOrder ? '오더 수정' : '오더 등록')}
        </button>
        {createdOrder && (
          <a className="btn small secondary" href={`/orders/${createdOrder.id}`} target="_blank" rel="noreferrer">오더 상세 열기</a>
        )}
      </div>
    </form>
  );
}
