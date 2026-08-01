const express = require('express');
const db = require('../db');
const { requireAuth, scopeFilter } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ORDER_STATUSES } = require('../config');
const { periodRange, previousPeriod, PRESET_LABELS } = require('../lib/period');

const router = express.Router();
router.use(requireAuth);

const DOW_LABELS = ['일', '월', '화', '수', '목', '금', '토'];

function pct(curr, prev) {
  if (!prev) return curr ? null : 0; // 이전 데이터가 없으면 증감률 계산 불가
  return Math.round(((curr - prev) / prev) * 1000) / 10;
}

async function fetchOrdersInRange(scope, from, to) {
  const where = [];
  const params = [];
  if (scope.branch_id) { where.push('branch_id = ?'); params.push(scope.branch_id); }
  if (scope.group_id) { where.push('requester_group_id = ?'); params.push(scope.group_id); }
  if (from) { where.push('SUBSTRING(created_at,1,10) >= ?'); params.push(from); }
  if (to) { where.push('SUBSTRING(created_at,1,10) <= ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  return db.all(`SELECT * FROM orders ${whereSql}`, params);
}

// EJS 렌더 라우트와 Next.js 프리뷰(GET /dashboard/data.json)가 완전히 동일한 쿼리/스코핑/집계
// 로직을 공유하도록 분리했다 — 인증/RBAC 로직을 두 곳에 중복 구현하지 않기 위함
// (docs/ai-stage-migration-workorder.md Stage 1 원칙: 데이터 계약/세션/RBAC 유지).
async function buildDashboardData(scope, query) {
  const preset = query.period || 'all';
  const { from, to } = periodRange(preset, query.from, query.to);
  const prevRange = previousPeriod(from, to);

  // 넷 다 서로 의존관계 없는 독립 조회라 병렬로 실행한다 — 가장 자주 열리는 페이지라
  // 순차 대기의 왕복시간 합산이 특히 체감된다.
  const [orders, branches, groups, prevOrders] = await Promise.all([
    fetchOrdersInRange(scope, from, to),
    db.all('SELECT * FROM branches ORDER BY name'),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
    (from && to) ? fetchOrdersInRange(scope, prevRange.from, prevRange.to) : Promise.resolve([]),
  ]);

  const counts = {};
  ORDER_STATUSES.forEach((s) => { counts[s] = 0; });
  let totalFare = 0;
  orders.forEach((o) => { counts[o.status] = (counts[o.status] || 0) + 1; totalFare += o.fare_amount || 0; });

  const unassigned = counts['오더등록'] + counts['대기'] + counts['접수'];
  const inProgress = counts['진행중'] + counts['배정중'] + counts['기사배정'];
  const completed = counts['완료'];
  const issues = counts['문의'] + counts['사고'] + counts['과태료'] + counts['취소요청'] + counts['취소'];

  // ---------- 시간대 분포 (등록 시각 기준) ----------
  const hourly = new Array(24).fill(0);
  const heatmap = Array.from({ length: 7 }, () => new Array(24).fill(0));
  orders.forEach((o) => {
    const hour = Number(o.created_at.substring(11, 13));
    hourly[hour] += 1;
    const d = new Date(o.created_at.substring(0, 10) + 'T00:00:00Z');
    heatmap[d.getUTCDay()][hour] += 1;
  });
  const peakHour = hourly.indexOf(Math.max(...hourly));
  const activeHours = hourly.filter((c) => c > 0).length;
  const avgPerActiveHour = activeHours ? Math.round((orders.length / activeHours) * 10) / 10 : 0;
  const heatmapMax = Math.max(1, ...heatmap.map((row) => Math.max(...row)));

  const branchNameById = {}; branches.forEach((b) => { branchNameById[b.id] = b.name; });
  const corporationNameById = {}; groups.forEach((g) => { corporationNameById[g.id] = g.name; });

  // ---------- 지사별 비교 (직전 동일 기간 대비) ----------
  function aggByBranch(list) {
    const map = {};
    list.forEach((o) => {
      if (!map[o.branch_id]) map[o.branch_id] = { cnt: 0, fare: 0 };
      map[o.branch_id].cnt += 1;
      map[o.branch_id].fare += o.fare_amount || 0;
    });
    return map;
  }
  const currByBranch = aggByBranch(orders);
  const prevByBranch = aggByBranch(prevOrders);
  const branchCompare = branches
    .filter((b) => !scope.branch_id || String(b.id) === String(scope.branch_id))
    .map((b) => {
      const curr = currByBranch[b.id] || { cnt: 0, fare: 0 };
      const prev = prevByBranch[b.id] || { cnt: 0, fare: 0 };
      return {
        branch_name: b.name, cnt: curr.cnt, prev_cnt: prev.cnt, cnt_pct: pct(curr.cnt, prev.cnt),
        fare: curr.fare, prev_fare: prev.fare, fare_pct: pct(curr.fare, prev.fare),
      };
    });

  // ---------- 지사별 상태 디테일 ----------
  const statusMatrix = branches
    .filter((b) => !scope.branch_id || String(b.id) === String(scope.branch_id))
    .map((b) => {
      const row = { branch_name: b.name, statuses: {}, total: 0, fare: 0 };
      ORDER_STATUSES.forEach((s) => { row.statuses[s] = 0; });
      orders.filter((o) => o.branch_id === b.id).forEach((o) => {
        row.statuses[o.status] = (row.statuses[o.status] || 0) + 1;
        row.total += 1;
        row.fare += o.fare_amount || 0;
      });
      return row;
    })
    .filter((row) => row.total > 0 || branches.length <= 1);

  // ---------- 그룹별 콜수·매출 ----------
  const corporationAgg = {};
  orders.forEach((o) => {
    if (!o.requester_group_id) return;
    if (!corporationAgg[o.requester_group_id]) corporationAgg[o.requester_group_id] = { cnt: 0, fare: 0 };
    corporationAgg[o.requester_group_id].cnt += 1;
    corporationAgg[o.requester_group_id].fare += o.fare_amount || 0;
  });
  const groupCompare = Object.keys(corporationAgg)
    .map((gid) => ({
      group_name: corporationNameById[gid] || '-', cnt: corporationAgg[gid].cnt, fare: corporationAgg[gid].fare,
    }))
    .sort((a, b) => b.cnt - a.cnt);

  return {
    title: '통합 대시보드',
    totalOrders: orders.length, totalFare, unassigned, inProgress, completed, issues,
    counts, ORDER_STATUSES,
    hourly, peakHour, activeHours, avgPerActiveHour,
    heatmap, heatmapMax, DOW_LABELS,
    branchCompare, statusMatrix, groupCompare,
    showBranchSections: currentUserIsMultiBranch(scope, branches),
    period: { preset, from, to, label: PRESET_LABELS[preset] || '전체 기간' },
  };
}

function currentUserIsMultiBranch(scope, branches) {
  return !scope.branch_id && branches.length > 1;
}

router.get('/', asyncHandler(async (req, res) => {
  const data = await buildDashboardData(scopeFilter(req), req.query);
  res.render('dashboard', data);
}));

// Next.js Stage 1 프리뷰(app/page.js)가 fetch()로 호출하는 JSON 버전 — 같은 requireAuth
// (router.use 위쪽에 이미 적용됨)와 같은 scopeFilter/쿼리/집계를 그대로 재사용한다.
router.get('/dashboard/data.json', asyncHandler(async (req, res) => {
  const data = await buildDashboardData(scopeFilter(req), req.query);
  res.json({ ...data, currentUser: req.session.user });
}));

module.exports = router;
