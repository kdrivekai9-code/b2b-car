#!/usr/bin/env node
// 외부 연동(콜마너 / MCP / 카카오 상담톡) 실패를 한 번에 훑어본다.
//
// 실패 기록이 네 곳에 흩어져 있어서(각자 고유한 컬럼과 화면 연동이 있어 하나로 합치지 않았다)
// "어디를 봐야 하는지" 자체가 매번 문제였다. 이 스크립트가 그 네 곳을 순서대로 읽어준다.
//   1. integration_errors        — 통합 오류 로그(크론 실패·카카오 발신 실패·MCP 예외 등)
//   2. orders.callmaner_last_error — 콜마너 오더접수 실패(화면 배지와 같은 값)
//   3. mcp_tool_calls            — MCP 도구 호출 실패
//   4. kakao_consult_events      — 카카오 수신 이벤트 중 미처리 건
//
// 사용법:
//   node scripts/check-integration-errors.js            # 최근 24시간
//   node scripts/check-integration-errors.js --days 7
//   node scripts/check-integration-errors.js --hours 3 --limit 30
require('dotenv').config();
const db = require('../db');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
}

function head(title) {
  console.log(`\n${'─'.repeat(78)}\n${title}\n${'─'.repeat(78)}`);
}

// 테이블이 아직 없는 환경(마이그레이션 전)에서도 나머지 섹션은 계속 보여준다.
async function safeAll(sql, params, label) {
  try {
    return await db.all(sql, params);
  } catch (e) {
    console.log(`  (조회 실패 — ${label}: ${e.message})`);
    return null;
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const limit = Math.max(1, Math.min(Number(args.limit) || 20, 200));
  const interval = args.hours ? `${Number(args.hours)} hours` : `${Number(args.days) || 1} days`;
  const since = `to_char((now() at time zone 'Asia/Seoul') - interval '${interval}', 'YYYY-MM-DD HH24:MI:SS')`;

  const now = await db.get(`SELECT to_char(now() at time zone 'Asia/Seoul','YYYY-MM-DD HH24:MI:SS') AS t`);
  console.log(`기준 시각(KST): ${now.t} / 조회 범위: 최근 ${interval}`);

  head('1. 통합 오류 로그 (integration_errors)');
  const summary = await safeAll(
    `SELECT source, operation, count(*) AS cnt, max(created_at) AS last
     FROM integration_errors WHERE created_at >= ${since}
     GROUP BY source, operation ORDER BY count(*) DESC`, [], 'integration_errors');
  if (summary && summary.length) {
    summary.forEach((r) => console.log(`  ${r.source.padEnd(10)} ${r.operation.padEnd(16)} ${String(r.cnt).padStart(4)}건  최근 ${r.last}`));
    const rows = await safeAll(
      `SELECT created_at, source, operation, ref_type, ref_id, error_code, message
       FROM integration_errors WHERE created_at >= ${since} ORDER BY id DESC LIMIT ${limit}`, [], 'integration_errors');
    console.log('\n  최근 건:');
    (rows || []).forEach((r) => console.log(
      `   ${r.created_at} [${r.source}/${r.operation}]${r.ref_id ? ` ${r.ref_type}=${r.ref_id}` : ''}`
      + `${r.error_code ? ` (${r.error_code})` : ''} ${String(r.message).slice(0, 90)}`));
  } else if (summary) {
    console.log('  기록 없음');
  }

  head('2. 콜마너 오더접수 실패 (orders.callmaner_last_error)');
  const orders = await safeAll(
    `SELECT oid, callmaner_last_error_code AS code, callmaner_last_error AS err, created_at
     FROM orders WHERE callmaner_last_error IS NOT NULL AND created_at >= ${since}
     ORDER BY id DESC LIMIT ${limit}`, [], 'orders');
  if (orders && orders.length) {
    orders.forEach((r) => console.log(`  ${r.created_at} ${r.oid} [${r.code || '-'}] ${String(r.err).slice(0, 90)}`));
  } else if (orders) {
    console.log('  기록 없음');
  }

  head('3. MCP 도구 호출 실패 (mcp_tool_calls)');
  const mcp = await safeAll(
    `SELECT created_at, tool_name, error FROM mcp_tool_calls
     WHERE ok = false AND created_at >= ${since} ORDER BY id DESC LIMIT ${limit}`, [], 'mcp_tool_calls');
  if (mcp && mcp.length) {
    mcp.forEach((r) => console.log(`  ${r.created_at} ${r.tool_name.padEnd(28)} ${String(r.error).slice(0, 70)}`));
  } else if (mcp) {
    console.log('  기록 없음');
  }

  head('4. 카카오 수신 이벤트 중 미처리 (kakao_consult_events)');
  const kakao = await safeAll(
    `SELECT created_at, event_type, error_message, session_id FROM kakao_consult_events
     WHERE handled = false AND created_at >= ${since} ORDER BY id DESC LIMIT ${limit}`, [], 'kakao_consult_events');
  if (kakao && kakao.length) {
    kakao.forEach((r) => console.log(`  ${r.created_at} ${r.event_type.padEnd(16)} ${r.error_message || ''}${r.session_id ? ` (session=${r.session_id})` : ''}`));
  } else if (kakao) {
    console.log('  기록 없음');
  }

  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
