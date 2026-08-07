// 외부 연동(콜마너 / MCP 배차 / 카카오 상담톡) 실패 현황 — 관리자 전용.
//
// 실패 기록이 네 곳에 흩어져 있다(각자 고유한 컬럼과 화면 연동이 있어 하나로 합치지 않았다).
// 이 화면은 그 넷을 한 번에 보여주는 읽기 전용 대시보드다. 터미널에서 같은 내용을 보려면
// scripts/check-integration-errors.js를 쓴다.
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const router = express.Router();
router.use(requireAuth, requireRole('admin'));

const RANGE_OPTIONS = [
  { key: '24h', label: '최근 24시간', interval: '24 hours' },
  { key: '3d', label: '최근 3일', interval: '3 days' },
  { key: '7d', label: '최근 7일', interval: '7 days' },
  { key: '30d', label: '최근 30일', interval: '30 days' },
];

// integration_errors는 마이그레이션(20260807050000) 대상이라 아직 없는 환경이 있을 수 있다.
// 한 섹션이 없다고 화면 전체가 죽으면 안 되므로 섹션별로 따로 감싼다.
async function safeAll(sql, params) {
  try {
    return { rows: await db.all(sql, params), error: null };
  } catch (e) {
    return { rows: [], error: e.message };
  }
}

async function loadPageData(rangeKey, limit) {
  const range = RANGE_OPTIONS.find((r) => r.key === rangeKey) || RANGE_OPTIONS[0];
  const since = `to_char((now() at time zone 'Asia/Seoul') - interval '${range.interval}', 'YYYY-MM-DD HH24:MI:SS')`;

  const [summary, unified, callmaner, mcp, kakao] = await Promise.all([
    safeAll(`SELECT source, operation, count(*) AS cnt, max(created_at) AS last
             FROM integration_errors WHERE created_at >= ${since}
             GROUP BY source, operation ORDER BY count(*) DESC`),
    safeAll(`SELECT created_at, source, operation, ref_type, ref_id, error_code, message
             FROM integration_errors WHERE created_at >= ${since}
             ORDER BY id DESC LIMIT ${limit}`),
    safeAll(`SELECT id, oid, callmaner_last_error_code AS code, callmaner_last_error AS err, created_at
             FROM orders WHERE callmaner_last_error IS NOT NULL AND created_at >= ${since}
             ORDER BY id DESC LIMIT ${limit}`),
    safeAll(`SELECT created_at, tool_name, error, session_id
             FROM mcp_tool_calls WHERE ok = false AND created_at >= ${since}
             ORDER BY id DESC LIMIT ${limit}`),
    safeAll(`SELECT created_at, event_type, error_message, session_id
             FROM kakao_consult_events WHERE handled = false AND created_at >= ${since}
             ORDER BY id DESC LIMIT ${limit}`),
  ]);

  return { range, summary, unified, callmaner, mcp, kakao };
}

router.get('/', asyncHandler(async (req, res) => {
  const limit = Math.max(10, Math.min(Number(req.query.limit) || 30, 200));
  const data = await loadPageData(String(req.query.range || '24h'), limit);
  res.render('integration_errors/index', {
    title: '연동 오류 현황',
    rangeOptions: RANGE_OPTIONS,
    limit,
    ...data,
  });
}));

// 화면을 새로고침하지 않고 갱신할 때 쓰는 JSON 버전(뷰의 자동 갱신에서 사용).
router.get('/data.json', asyncHandler(async (req, res) => {
  const limit = Math.max(10, Math.min(Number(req.query.limit) || 30, 200));
  const data = await loadPageData(String(req.query.range || '24h'), limit);
  res.json({
    currentUser: req.session.user,
    range: data.range,
    summary: data.summary,
    unified: data.unified,
    callmaner: data.callmaner,
    mcp: data.mcp,
    kakao: data.kakao,
  });
}));

module.exports = router;
