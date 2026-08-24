const express = require('express');
const db = require('../db');
const { requireAuth, scopeFilter } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { ORDER_STATUSES } = require('../config');
const { collectSystemHealth } = require('../lib/systemHealth');
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
// AI(Gemini) 사용량 — ai_call_logs를 집계한다. 이 표는 오더와 무관해서 지사/법인 스코프가 없다
// (호출 주체가 시스템이라 어느 지사 몫인지 나눌 근거가 없다). 그래서 기간만 맞춘다.
//
// 왜 대시보드에 두나: 지금까지 "챗봇이 느리다"·"비용이 얼마나 나가나"를 볼 곳이 DB뿐이었다.
// 용도(op)별로 나눠 보여야 무엇을 줄일지 판단할 수 있다.
//
// 용도 이름은 코드가 넘기는 값이라(lib/vertexAi.js의 op) 화면에 그대로 쓰면 알아보기 어렵다.
const AI_OP_LABELS = {
  intake_extract: '접수 내용 추출',
  intent_light: '의도 분류',
  mcp_dispatch: '배차 도우미',
  odometer_ocr: '계기판 인식',
  address_correct: '주소 보정',
  generate_with_tools: '도구 호출',
  generate_json: 'JSON 생성',
};

function aiOpLabel(op) {
  if (AI_OP_LABELS[op]) return AI_OP_LABELS[op];
  // 임베딩은 태스크 종류가 뒤에 붙는다(embed_RETRIEVAL_QUERY 등) — 묶어서 보여준다.
  if (String(op || '').startsWith('embed_')) return '지식검색 임베딩';
  return op || '(미분류)';
}

async function fetchAiUsage(from, to) {
  const where = [];
  const params = [];
  // ai_call_logs.created_at은 텍스트(KST 문자열)라 오더 조회와 같은 방식으로 자른다.
  if (from) { where.push('SUBSTRING(created_at,1,10) >= ?'); params.push(from); }
  if (to) { where.push('SUBSTRING(created_at,1,10) <= ?'); params.push(to); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  // 마이그레이션 전이거나 표가 없으면 이 카드만 비운다 — 대시보드 전체가 막히면 안 된다.
  const rows = await db.all(
    `SELECT op,
            COUNT(*) AS calls,
            SUM(CASE WHEN ok THEN 0 ELSE 1 END) AS failures,
            ROUND(AVG(duration_ms)) AS avg_ms,
            MAX(duration_ms) AS max_ms
       FROM ai_call_logs
       ${whereSql}
      GROUP BY op
      ORDER BY COUNT(*) DESC`,
    params
  ).catch((e) => {
    console.error('AI 사용량 집계 실패(카드를 비웁니다):', e.message);
    return null;
  });
  if (!rows) return null;

  const byOp = rows.map((r) => ({
    op: r.op,
    label: aiOpLabel(r.op),
    calls: Number(r.calls) || 0,
    failures: Number(r.failures) || 0,
    avgMs: Number(r.avg_ms) || 0,
    maxMs: Number(r.max_ms) || 0,
  }));
  const totalCalls = byOp.reduce((sum, r) => sum + r.calls, 0);
  const totalFailures = byOp.reduce((sum, r) => sum + r.failures, 0);
  // 전체 평균은 호출 수로 가중해야 한다 — op별 평균을 그냥 평균내면 호출이 적은 op가 과대평가된다.
  const weighted = byOp.reduce((sum, r) => sum + r.avgMs * r.calls, 0);
  return {
    totalCalls,
    totalFailures,
    avgMs: totalCalls ? Math.round(weighted / totalCalls) : 0,
    slowest: byOp.reduce((a, b) => (b.maxMs > (a ? a.maxMs : -1) ? b : a), null),
    byOp,
  };
}

async function buildDashboardData(scope, query, options = {}) {
  const preset = query.period || 'all';
  const { from, to } = periodRange(preset, query.from, query.to);
  const prevRange = previousPeriod(from, to);

  // 넷 다 서로 의존관계 없는 독립 조회라 병렬로 실행한다 — 가장 자주 열리는 페이지라
  // 순차 대기의 왕복시간 합산이 특히 체감된다.
  const [orders, branches, groups, prevOrders, aiUsage] = await Promise.all([
    fetchOrdersInRange(scope, from, to),
    db.all('SELECT * FROM branches ORDER BY name'),
    db.all('SELECT * FROM groups_tbl ORDER BY name'),
    (from && to) ? fetchOrdersInRange(scope, prevRange.from, prevRange.to) : Promise.resolve([]),
    fetchAiUsage(from, to),
  ]);

  // 시스템 상태는 관리자에게만 보여준다 — 고객사·지사 사용자가 볼 값이 아니고, 볼 수 있어도
  // 할 수 있는 일이 없다. 조회도 그때만 한다.
  const systemHealth = options.isAdmin ? await collectSystemHealth().catch((e) => {
    console.error('시스템 상태 조회 실패:', e.message);
    return null;
  }) : null;

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
    aiUsage,
    systemHealth,
    showBranchSections: currentUserIsMultiBranch(scope, branches),
    period: { preset, from, to, label: PRESET_LABELS[preset] || '전체 기간' },
  };
}

function currentUserIsMultiBranch(scope, branches) {
  return !scope.branch_id && branches.length > 1;
}

router.get('/', asyncHandler(async (req, res) => {
  const data = await buildDashboardData(scopeFilter(req), req.query, { isAdmin: req.session.user.role === 'admin' });
  res.render('dashboard', data);
}));

// Next.js Stage 1 프리뷰(app/page.js)가 fetch()로 호출하는 JSON 버전 — 같은 requireAuth
// (router.use 위쪽에 이미 적용됨)와 같은 scopeFilter/쿼리/집계를 그대로 재사용한다.
router.get('/dashboard/data.json', asyncHandler(async (req, res) => {
  const data = await buildDashboardData(scopeFilter(req), req.query, { isAdmin: req.session.user.role === 'admin' });
  res.json({ ...data, currentUser: req.session.user });
}));

module.exports = router;
