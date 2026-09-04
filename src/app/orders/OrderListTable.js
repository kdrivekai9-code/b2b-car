'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';

// public/js/order-list-columns.js를 React로 이식 — 서버에 저장하지 않고 이 브라우저
// (localStorage)에만 저장한다는 계약과 저장 키(STORAGE_KEY/WIDTH_KEY/DENSITY_KEY)를
// legacy와 그대로 맞춰서, 이미 legacy 화면을 쓰던 사용자의 설정이 그대로 이어지게 한다.
// DOM을 직접 옮기는 대신(legacy 방식) 표시/순서/너비/정렬 전부 React state로 관리하고
// 그 상태에 따라 매번 다시 그린다.
//
// 실시간 갱신: 오더 생성/상태변경/배정 등은 서버(routes/orders.js)가 /orders/stream으로
// "뭔가 바뀌었다" 신호만 보낸다(상담 카드뷰의 agent-needs-count와 동일한 패턴). 여기서는
// fetch로 데이터를 직접 다시 받는 대신 router.refresh()로 부모 서버 컴포넌트(page.js)의
// /orders/data.json 재조회를 트리거한다 — 필터/페이지네이션은 URL에 이미 있으니 그대로
// 유지되고, 이 컴포넌트의 클라이언트 상태(컬럼/정렬/펼침 등)는 리마운트 없이 보존된다.

const STATUS_COLORS = {
  '오더등록': 'gray', '대기': 'gray', '대기(확인중)': 'amber', '접수': 'blue',
  '접수(배차중)': 'blue', '기사배정': 'amber', '운행시작': 'teal', '문의': 'purple', '사고': 'red',
  '과태료': 'red', '취소요청': 'red', '취소': 'dark', '완료': 'green',
};

function formatMoney(n) {
  return (Number(n) || 0).toLocaleString('ko-KR') + '원';
}

// "YYYY-MM-DD HH:MM:SS" -> "YYYY-MM-DD HH:MM" (초 단위는 목록에서 굳이 안 보여줘도 됨).
function formatDateTimeNoSeconds(raw) {
  const s = String(raw || '');
  const m = /^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}):\d{2}/.exec(s);
  return m ? m[1] : s;
}

const COLUMN_LABELS = {
  oid: 'OID', branch: '지사', group: '요청 법인', group_phone: '대표번호',
  origin: '출발지', waypoints: '경유지', destination: '도착지', vehicle: '차량번호',
  driver: '기사정보', reserved_at: '예약일시', payment_method: '결제방식',
  // 요금은 둘이다 — 고객에게 청구하는 계약 요금과, 콜마너에 거는 배차 요금(관리자만 본다).
  fare: '요금', dispatch_fare: '배차 요금', status: '상태', voc: 'VOC', photo: '사진',
  // 담당자 = 이 오더를 등록한 사람. 문의가 오면 먼저 찾는 값이라 기본으로 켠다.
  created_by: '담당자', created_at: '등록일시',
};
const ALWAYS_VISIBLE = ['oid'];
const DEFAULT_ORDER = ['oid', 'branch', 'group', 'group_phone', 'origin', 'waypoints', 'destination', 'vehicle', 'driver', 'reserved_at', 'payment_method', 'fare', 'dispatch_fare', 'status', 'voc', 'photo', 'created_by', 'created_at'];
const DEFAULT_VISIBLE = ['oid', 'branch', 'group', 'group_phone', 'origin', 'destination', 'vehicle', 'reserved_at', 'payment_method', 'fare', 'dispatch_fare', 'status', 'created_by', 'created_at'];

// 고객 화면은 볼 것이 다르다. EJS 쪽(public/js/order-list-columns.js)과 같은 규칙이다 —
// 한쪽만 고치면 플래그를 되돌렸을 때 컬럼 구성이 달라진다.
//   지사      아예 뺀다. 고객은 자기 지사 하나뿐이라 모든 줄이 같은 값이고 칸만 차지한다.
//   요청 법인  기본으로 끄고 맨 뒤로 보낸다(같은 이유). 지우지는 않는다 — 여러 법인을 걸친
//             계정이 생기면 그때 켜면 된다. 끈 컬럼이 앞자리를 차지하면 컬럼 설정 창에서
//             매번 그 줄을 지나쳐야 한다.
//   담당자     켜고, 비워진 요청 법인 자리로 올린다. 같은 법인 안에서 "누가 넣은 건인지"가
//             고객이 실제로 찾는 값이라 앞쪽에 있어야 한다.
function clientOrder(base) {
  const o1 = base.filter((k) => k !== 'branch');
  const groupIdx = o1.indexOf('group');
  const o2 = o1.filter((k) => k !== 'group' && k !== 'created_by');
  o2.splice(groupIdx, 0, 'created_by');
  o2.push('group');
  return o2;
}

// 컬럼 기본값을 바꿔도, 설정을 한 번이라도 저장한 사람에게는 저장값이 이겨서 영영 안 바뀐다.
// 그렇다고 매번 덮어쓰면 사용자가 직접 켠 컬럼이 계속 꺼져서 더 나쁘다 — 한 번만 적용하고
// 표시를 남긴다(EJS 쪽 LAYOUT_REV와 같은 값이어야 한다. 저장소를 공유하기 때문이다).
const LAYOUT_REV = 2; // 2 = 고객 화면에서 요청 법인을 맨 뒤·기본 해제로, 담당자를 그 자리로.

function columnConfigFor(role) {
  const isClient = role === 'client';
  const labels = { ...COLUMN_LABELS };
  if (isClient) delete labels.branch;
  return {
    isClient,
    labels,
    order: isClient ? clientOrder(DEFAULT_ORDER) : DEFAULT_ORDER,
    visible: isClient
      ? DEFAULT_VISIBLE.filter((k) => k !== 'branch' && k !== 'group')
      : DEFAULT_VISIBLE,
  };
}
const NUMERIC_COLUMNS = ['oid', 'fare', 'dispatch_fare', 'photo'];

const STORAGE_KEY = 'orderList.columns.v1';
const WIDTH_KEY = 'orderList.widths.v1';
const DENSITY_KEY = 'orderList.density.v1';
// 새로 등록/변경된 오더 행을 강조해서 보여주는 시간(사용자 확정 사항: 5초)
const HIGHLIGHT_MS = 5000;
// 상태변경 깜빡임 3초(사용자 지정). CSS 애니메이션(0.5초 × 6회)과 같은 길이라, 여기만 바꾸면
// 색이 남은 채로 멈추거나 먼저 꺼진다 — public/css/style.css의 order-row-status-flash도 같이 본다.
const STATUS_FLASH_MS = 3000;

function loadColumnState(config) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { saved = null; }
  if (!saved || !saved.order || !saved.visible) {
    return { order: config.order.slice(), visible: config.visible.slice() };
  }
  ['order', 'visible'].forEach((listKey) => {
    const i = saved[listKey].indexOf('uid');
    if (i !== -1) saved[listKey][i] = 'oid';
  });
  config.order.forEach((key) => {
    // 이 사람이 설정을 저장한 뒤에 새로 생긴 컬럼만 걸린다 — 저장된 순서에 아예 없다는 뜻이다.
    // 기본 표시 컬럼이면 켜준 채로 넣는다. 컬럼을 추가해도 저장된 설정이 있는 사람에게는
    // 영영 안 보이던 문제(배차 요금이 그랬다)를 여기서 막는다. 반대로 사용자가 직접 끈 컬럼은
    // saved.order에 남아 있어 여기 걸리지 않으므로 되살아나지 않는다.
    if (saved.order.indexOf(key) !== -1) return;
    saved.order.push(key);
    if (config.visible.indexOf(key) !== -1 && saved.visible.indexOf(key) === -1) saved.visible.push(key);
  });
  // 이 역할에 없는 컬럼은 저장값에 남아 있어도 버린다 — 고객 화면에서 '지사'를 켠 채로
  // 저장해둔 사람이 있으면 체크박스 목록에 이름 없는 줄이 뜬다.
  const known = Object.keys(config.labels);
  saved.order = saved.order.filter((k) => known.indexOf(k) !== -1);
  saved.visible = saved.visible.filter((k) => known.indexOf(k) !== -1);
  // 위 LAYOUT_REV 주석 참고 — 바뀐 기본 배치를 한 번만 저장값에 반영한다.
  if (config.isClient && Number(saved.rev || 1) < LAYOUT_REV) {
    saved.order = clientOrder(saved.order);
    saved.visible = saved.visible.filter((k) => k !== 'group');
  }
  saved.rev = LAYOUT_REV;
  return saved;
}

function cellValue(o, key) {
  switch (key) {
    case 'oid': return o.oid;
    case 'branch': return o.branch_name;
    case 'group': return o.group_name || '-';
    case 'group_phone': return o.group_phone || '-';
    case 'origin': return o.origin_address;
    case 'waypoints': return o.waypoints_text || '-';
    case 'destination': return o.destination_address;
    case 'vehicle': return [o.vehicle_type, o.vehicle_number].filter(Boolean).join(' / ') || '-';
    case 'driver': {
      // 구간 릴레이: leg_count > 0이면(order_legs 마이그레이션 이후 생성된 오더) "N/M명 배정"
      // 요약, 아니면(레거시 오더) 기존 단일 기사 표시 그대로.
      if (Number(o.leg_count) > 0) {
        return `기사 ${o.legs_assigned_count}/${o.leg_count}명 배정` + (o.leg_driver_names ? ` (${o.leg_driver_names})` : '');
      }
      return o.driver_name ? (o.driver_name + (o.driver_phone ? ` (${o.driver_phone})` : '')) : '미배정';
    }
    case 'reserved_at': return `${o.reserved_date} ${o.reserved_time}`;
    case 'payment_method': return o.payment_method_name || '-';
    case 'fare': return formatMoney(o.fare_amount);
    // 배차 요금은 요금표를 등록한 지사에서만 채워진다 — 없으면 0원이 아니라 "-"다.
    // 0원으로 보이면 "무료로 배차를 걸었다"로 읽힌다.
    case 'dispatch_fare': return o.dispatch_fare_amount == null ? '-' : formatMoney(o.dispatch_fare_amount);
    case 'status': return o.status;
    case 'voc': return [o.voc_accident_note ? '사고' : null, o.voc_fine_note ? '과태료' : null, o.voc_claim_note ? '클레임' : null].filter(Boolean).join(', ') || '-';
    case 'photo': return Number(o.photo_count) > 0 ? `📷 ${o.photo_count}` : '-';
    // 회사명을 뗀 사람 이름. 서버가 만들어 내려준다(lib/orderDisplay.js creatorLabel) —
    // 여기서 다시 가공하면 EJS 표와 다른 값이 나올 수 있다.
    case 'created_by': return o.created_by_display || '-';
    case 'created_at': return formatDateTimeNoSeconds(o.created_at);
    default: return '';
  }
}

function sortValue(o, key) {
  const v = cellValue(o, key);
  const text = String(v == null ? '' : v);
  if (NUMERIC_COLUMNS.includes(key)) {
    const digits = text.replace(/[^0-9]/g, '');
    return digits ? Number(digits) : 0;
  }
  return text;
}

export default function OrderListTable({ orders, filters, statusSummary, currentUserRole }) {
  const router = useRouter();
  const columnConfig = useMemo(() => columnConfigFor(currentUserRole), [currentUserRole]);
  const [columnOrder, setColumnOrder] = useState(columnConfig.order);
  const [visibleColumns, setVisibleColumns] = useState(columnConfig.visible);
  const [widths, setWidths] = useState({});
  const [density, setDensity] = useState('normal');
  const [panelOpen, setPanelOpen] = useState(false);
  const [sortState, setSortState] = useState({ key: null, dir: null });
  const [dragKey, setDragKey] = useState(null);
  const refreshTimerRef = useRef(null);
  // seenRef: 직전에 화면에 있던 오더의 id -> updated_at 스냅샷. null이면 아직 최초 렌더 전.
  const seenRef = useRef(null);
  const highlightTimersRef = useRef(new Map());
  // 상태가 바뀐 행을 잠깐 깜빡이는 데 쓴다(id → 상태색 클래스).
  const [statusFlash, setStatusFlash] = useState(new Map());
  const statusFlashTimersRef = useRef(new Map());
  const [highlightIds, setHighlightIds] = useState(() => new Set());

  // localStorage는 클라이언트에만 있으므로 마운트 후에 불러온다 — legacy도 서버 렌더 HTML이
  // 먼저 기본값으로 뜬 다음 JS가 저장된 설정을 적용했으니 동일한 동작(잠깐의 기본값 표시 후
  // 저장된 설정으로 전환).
  useEffect(() => {
    const state = loadColumnState(columnConfig);
    setColumnOrder(state.order);
    setVisibleColumns(state.visible);
    try { setWidths(JSON.parse(localStorage.getItem(WIDTH_KEY)) || {}); } catch { /* keep default */ }
    setDensity(localStorage.getItem(DENSITY_KEY) || 'normal');
  }, [columnConfig]);

  // 실시간 갱신: /orders/stream 신호가 오면 목록을 다시 조회한다. 짧은 시간에 신호가
  // 연달아 오면(연속 상태변경 등) debounce로 한 번만 반영한다. 재연결(onopen) 시에도 한 번
  // 새로고침해서, 연결이 끊겨 있던 동안 놓친 변경을 따라잡는다 — 단, 최초 연결(마운트 직후)은
  // 이미 서버 렌더 데이터가 최신이므로 건너뛴다.
  useEffect(() => {
    if (!window.EventSource) return;
    let openedOnce = false;
    const scheduleRefresh = () => {
      clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => router.refresh(), 400);
    };
    const es = new EventSource('/orders/stream');
    es.onmessage = scheduleRefresh;
    es.onopen = () => {
      if (!openedOnce) { openedOnce = true; return; }
      scheduleRefresh();
    };
    return () => {
      es.close();
      clearTimeout(refreshTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 새로 등록되거나 내용이 바뀐 오더 행을 5초간 배경색으로 강조한다 — SSE(router.refresh())로
  // 목록이 조용히 갱신되면 무엇이 새로 들어왔는지 알아채기 어려웠다. 직전 스냅샷(id -> updated_at)과
  // 비교해서 새 id이거나 updated_at이 달라진 행만 고른다. 최초 렌더는 전체가 "새 것"이 되어버리니
  // 스냅샷만 기록하고 강조하지 않는다.
  useEffect(() => {
    const snapshot = new Map(orders.map((o) => [o.id, { at: o.updated_at || '', status: o.status || '' }]));
    if (seenRef.current === null) {
      seenRef.current = snapshot;
      return;
    }
    const prev = seenRef.current;
    const changedIds = orders.filter((o) => {
      const before = prev.get(o.id);
      return !before || before.at !== (o.updated_at || '');
    }).map((o) => o.id);

    // 상태가 바뀐 행은 따로 골라 상태색으로 깜빡인다(사용자 요청) — 그냥 노란 배경만으로는
    // "무언가 바뀌었다"까지만 알 수 있고 무엇으로 바뀌었는지는 행을 읽어야 안다.
    // 새로 들어온 오더는 제외한다 — 그건 "변경"이 아니라 등장이고, 이미 노란 배경으로 보인다.
    const statusChanged = orders.filter((o) => {
      const before = prev.get(o.id);
      return before && before.status !== (o.status || '');
    });
    seenRef.current = snapshot;

    if (statusChanged.length) {
      setStatusFlash((cur) => {
        const next = new Map(cur);
        statusChanged.forEach((o) => next.set(o.id, STATUS_COLORS[o.status] || 'gray'));
        return next;
      });
      const flashTimers = statusFlashTimersRef.current;
      statusChanged.forEach((o) => {
        clearTimeout(flashTimers.get(o.id));
        flashTimers.set(o.id, setTimeout(() => {
          setStatusFlash((cur) => {
            const next = new Map(cur);
            next.delete(o.id);
            return next;
          });
          flashTimers.delete(o.id);
        }, STATUS_FLASH_MS));
      });
    }

    if (changedIds.length === 0) return;

    setHighlightIds((cur) => {
      const next = new Set(cur);
      changedIds.forEach((id) => next.add(id));
      return next;
    });
    const timers = highlightTimersRef.current;
    changedIds.forEach((id) => {
      clearTimeout(timers.get(id));
      timers.set(id, setTimeout(() => {
        setHighlightIds((cur) => {
          const next = new Set(cur);
          next.delete(id);
          return next;
        });
        timers.delete(id);
      }, HIGHLIGHT_MS));
    });
  }, [orders]);

  // 언마운트 시 남아있는 강조 타이머 정리
  useEffect(() => {
    const timers = highlightTimersRef.current;
    const flashTimers = statusFlashTimersRef.current;
    return () => {
      timers.forEach((t) => clearTimeout(t));
      timers.clear();
      flashTimers.forEach((t) => clearTimeout(t));
      flashTimers.clear();
    };
  }, []);

  // 행 아무 곳이나 클릭하면 상세페이지로 이동한다(OID 링크만 눌러야 했던 걸 개선 — legacy
  // EJS 목록은 이미 같은 동작이다). 셀 안의 링크/버튼/입력요소를 누른 경우는 그쪽 동작을
  // 그대로 살리고, 사용자가 텍스트를 드래그해 선택한 경우에도 이동하지 않는다.
  function handleRowClick(e, orderId) {
    if (e.target.closest('a, button, input, select, textarea, label')) return;
    if (window.getSelection && String(window.getSelection()).length > 0) return;
    router.push(`/orders/${orderId}`);
  }

  function saveColumnState(order, visible) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ order, visible }));
  }

  function toggleVisible(key) {
    setVisibleColumns((prev) => {
      const next = prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key];
      saveColumnState(columnOrder, next);
      return next;
    });
  }

  function handleDrop(targetKey) {
    if (!dragKey || dragKey === targetKey) return;
    setColumnOrder((prev) => {
      const next = prev.filter((k) => k !== dragKey);
      next.splice(next.indexOf(targetKey), 0, dragKey);
      saveColumnState(next, visibleColumns);
      return next;
    });
    setDragKey(null);
  }

  function handleResizeStart(key, e) {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = e.currentTarget.closest('th').offsetWidth;
    function onMove(ev) {
      const newWidth = Math.max(50, startWidth + (ev.clientX - startX));
      setWidths((prev) => ({ ...prev, [key]: newWidth }));
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      setWidths((prev) => {
        localStorage.setItem(WIDTH_KEY, JSON.stringify(prev));
        return prev;
      });
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleSetDensity(next) {
    setDensity(next);
    localStorage.setItem(DENSITY_KEY, next);
  }

  function handleReset() {
    localStorage.removeItem(STORAGE_KEY);
    localStorage.removeItem(WIDTH_KEY);
    localStorage.removeItem(DENSITY_KEY);
    setColumnOrder(columnConfig.order.slice());
    setVisibleColumns(columnConfig.visible.slice());
    setWidths({});
    setDensity('normal');
    setSortState({ key: null, dir: null });
  }

  function handleSort(key) {
    setSortState((prev) => ({ key, dir: prev.key === key && prev.dir === 'asc' ? 'desc' : 'asc' }));
  }

  const sortedOrders = useMemo(() => {
    if (!sortState.key) return orders;
    const numeric = NUMERIC_COLUMNS.includes(sortState.key);
    const list = orders.slice();
    list.sort((a, b) => {
      const va = sortValue(a, sortState.key);
      const vb = sortValue(b, sortState.key);
      const cmp = numeric ? va - vb : String(va).localeCompare(String(vb), 'ko');
      return sortState.dir === 'asc' ? cmp : -cmp;
    });
    return list;
  }, [orders, sortState]);

  const activeColumns = columnOrder.filter((key) => visibleColumns.includes(key));
  const densityClass = density === 'compact' ? ' density-compact' : density === 'comfortable' ? ' density-comfortable' : '';

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        <div>
          {filters.branch_id ? <span className="chip">지사 필터 적용중</span> : <span className="chip">전체 지사 표시중</span>}
          {filters.status && <span className="chip">상태: {filters.status}</span>}
          {(filters.from || filters.to) && <span className="chip">기간: {filters.from || '전체'} ~ {filters.to || '전체'}</span>}
          <span className="chip">총 {statusSummary.total}건</span>
          <span className="chip">오더등록 {statusSummary.registered}건</span>
          <span className="chip">완료 {statusSummary.completed}건</span>
          <span className="chip">대기 {statusSummary.pending}건</span>
          <span className="chip">취소 {statusSummary.cancelled}건</span>
          <span className="chip">문의 {statusSummary.inquiry}건</span>
        </div>
        <button type="button" className="btn secondary" onClick={() => setPanelOpen((v) => !v)}>⚙️ 항목 설정</button>
      </div>

      {panelOpen && (
        <div className="card column-settings-panel">
          <div className="section-title small">표시할 항목 (체크 해제하면 표에서 숨겨집니다. 표 헤더를 드래그하면 순서를, 헤더 오른쪽 경계를 드래그하면 너비를 바꿀 수 있습니다.)</div>
          <div className="column-checkbox-grid">
            {columnOrder.map((key) => {
              const locked = ALWAYS_VISIBLE.includes(key);
              return (
                <label className="checkline" key={key}>
                  <input type="checkbox" checked={visibleColumns.includes(key)} disabled={locked} onChange={() => toggleVisible(key)} />
                  {' ' + columnConfig.labels[key] + (locked ? ' (고정)' : '')}
                </label>
              );
            })}
          </div>
          <div className="section-title small">행 간격</div>
          <div className="row-density-buttons">
            <button type="button" className="btn small secondary" onClick={() => handleSetDensity('compact')}>좁게</button>
            <button type="button" className="btn small secondary" onClick={() => handleSetDensity('normal')}>보통</button>
            <button type="button" className="btn small secondary" onClick={() => handleSetDensity('comfortable')}>넓게</button>
          </div>
          <div style={{ marginTop: 14 }}>
            <button type="button" className="btn small secondary" onClick={handleReset}>기본값으로 초기화</button>
          </div>
        </div>
      )}

      <div className="table-wrap">
        <table id="ordersTable" className={densityClass.trim()}>
          <thead>
            <tr>
              {activeColumns.map((key) => (
                <th
                  key={key}
                  data-column={key}
                  draggable
                  style={{ position: 'relative', width: widths[key] ? widths[key] + 'px' : undefined }}
                  onDragStart={() => setDragKey(key)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(key)}
                  onClick={(e) => { if (!e.target.closest('.col-resize-handle')) handleSort(key); }}
                >
                  {columnConfig.labels[key]}
                  <span className={`sort-icon${sortState.key === key ? ' sort-icon-active' : ''}`}>
                    {sortState.key === key ? (sortState.dir === 'asc' ? ' ▲' : ' ▼') : ' ⇅'}
                  </span>
                  <span className="col-resize-handle" onMouseDown={(e) => handleResizeStart(key, e)} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sortedOrders.length === 0 && <tr><td colSpan={activeColumns.length} className="empty">조건에 맞는 오더가 없습니다.</td></tr>}
            {sortedOrders.map((o) => (
              <tr key={o.id}
                data-clickable="1"
                className={statusFlash.has(o.id)
                  ? `order-row-status-flash order-flash-${statusFlash.get(o.id)}`
                  : (highlightIds.has(o.id) ? 'order-row-updated' : undefined)}
                onClick={(e) => handleRowClick(e, o.id)}>
                {activeColumns.map((key) => {
                  const value = cellValue(o, key);
                  {/* 나눠 접수한 건은 OID 옆에 "1/2"를 붙인다 — 없으면 같은 요청에서 나온 두 줄이
                      서로 무관해 보인다. views/orders/list.ejs에도 같은 표시가 있다. */}
                  if (key === 'oid') return (
                    <td key={key} data-column={key}>
                      <a href={`/orders/${o.id}`}>{value}</a>
                      {o.split_group_id && Number(o.split_total) > 1 && (
                        <span className="split-mark" title={`분리접수 ${o.split_seq}/${o.split_total}건`}>{o.split_seq}/{o.split_total}</span>
                      )}
                    </td>
                  );
                  if (key === 'status') return <td key={key} data-column={key}><span className={`badge ${STATUS_COLORS[o.status] || 'gray'}`}>{o.status}</span></td>;
                  return <td key={key} data-column={key} title={typeof value === 'string' ? value : undefined}>{value}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
