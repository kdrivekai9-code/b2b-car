#!/usr/bin/env node
// 콜마너 MCP 배차 연동 실서버 점검 — 장소검색 → 예상요금 → 주문등록 → 진행중조회 → 요금인상 → 취소.
//
// 실제 주문을 만들었다 지우므로 반드시 테스트 지사/테스트 고객으로만 돌린다.
// 등록에 성공하면 어떤 단계에서 실패하든 마지막에 취소를 시도한다(테스트 건이 남지 않게).
//
// 사용법:
//   node scripts/mcp-dispatch-smoke.js --cid 01012345678 [--repNo 12345]
//                                      [--origin 사당역] [--destination 강남역]
//                                      [--raise 5000] [--skip-create]
//
// 사전 조건: .env의 MCP_DISPATCH_API_KEY, 그리고 cid가 콜마너에 고객으로 등록돼 있어야 한다
// (미등록이면 call.create가 CUSTOMER_NOT_FOUND로 거부한다 — 이 스크립트로 확인 가능).
require('dotenv').config();
const mcp = require('../lib/mcpDispatchClient');

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

function log(step, value) {
  console.log(`\n=== ${step} ===`);
  if (value !== undefined) console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 1));
}

function fail(message) {
  console.error('\n실패: ' + message);
  process.exitCode = 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cid = args.cid || process.env.TEST_CID;
  const repNo = args.repNo || process.env.MCP_DISPATCH_DEFAULT_REP_NO || '12345';
  const originKeyword = args.origin || '사당역';
  const destinationKeyword = args.destination || '강남역';
  const raiseFare = Number(args.raise || 5000);

  if (!cid) return fail('--cid 로 테스트 고객 연락처를 지정해주세요 (예: --cid 01012345678).');
  if (!mcp.isConfigured()) return fail('MCP_DISPATCH_API_KEY 환경변수가 없습니다 (.env 확인).');
  console.log(`대상: repNo=${repNo} cid=${cid} 경로=${originKeyword}→${destinationKeyword}`);

  const customer = await mcp.callTool('cust.get', { repNo, cid });
  log('1. 고객 조회(cust.get)', customer.ok
    ? { 등급: (customer.data.customer || {}).grade, 지사: (customer.data.customer || {}).branch, capabilities: customer.data.capabilities }
    : { ok: false, error: customer.error });
  if (!customer.ok) {
    return fail('이 연락처는 콜마너에 등록된 고객이 아닙니다. 콜마너에 테스트 고객 등록이 필요합니다.');
  }

  const origin = await mcp.callTool('place.find.origin', { keyword: originKeyword });
  const destination = await mcp.callTool('place.find.destination', { keyword: destinationKeyword });
  if (!origin.ok || !destination.ok) return fail('장소 검색 실패: ' + (origin.error || destination.error));
  const departure = origin.data.hits[0];
  const arrival = destination.data.hits[0];
  log('2. 장소 검색(place.find.*)', { departure, arrival });

  const quote = await mcp.callTool('fare.get', { repNo, departure, arrival });
  log('3. 예상 요금(fare.get)', quote.ok ? { 추천요금: quote.data.recommendedFare, 거리km: quote.data.distKm } : quote);

  if (args['skip-create']) {
    console.log('\n--skip-create 지정됨 — 등록/인상/취소는 건너뜁니다.');
    return;
  }

  const createArgs = {
    repNo, cid, serviceType: 'immediate',
    departure: { name: departure.name, region: departure.region, xy: departure.xy, address: '' },
    arrival: { name: arrival.name, region: arrival.region, xy: arrival.xy, address: '' },
    notes: '연동 점검 테스트(등록 후 자동 취소)',
  };
  if (quote.ok && quote.data.recommendedFare) createArgs.fare = quote.data.recommendedFare;

  const created = await mcp.callTool('call.create', createArgs, { timeoutMs: 20000 });
  log('4. 주문 등록(call.create)', created);
  if (!created.ok) return fail('주문 등록 실패: ' + created.error);
  const rcptNo = created.data.rcptNo;

  // 등록에 성공한 이상, 이후 단계가 실패해도 테스트 건은 반드시 취소하고 끝낸다.
  try {
    const active = await mcp.callTool('call.list.active', { repNo, cid });
    log('5. 진행중 주문 조회(call.list.active)', active.ok
      ? (active.data.orders || []).map((o) => ({
        접수번호: o.rcptNo, 경로: `${(o.departure || {}).name}→${(o.arrival || {}).name}`,
        상태: o.st, 요금: o.fare, 기사배정: !!(o.driver && o.driver.matched),
        취소가능: o.isCancellable, 요금조정가능: o.isFareAdjustable, 접수시각: o.requestedAt,
      }))
      : active);

    const target = active.ok ? (active.data.orders || []).find((o) => o.rcptNo === rcptNo) : null;
    const currentFare = (target && target.fare) || createArgs.fare || 0;
    if (currentFare > 0) {
      const raised = await mcp.callTool('call.raise', { rcptNo, currentFare, raiseFare });
      log(`6. 요금 인상(call.raise, ${currentFare} + ${raiseFare})`, raised);
    } else {
      log('6. 요금 인상 건너뜀', '현재 요금을 확인하지 못했습니다.');
    }
  } finally {
    const cancelled = await mcp.callTool('call.cancel', { rcptNo, reason: '연동 점검 종료' }, { timeoutMs: 20000 });
    log('7. 주문 취소(call.cancel) — 테스트 건 정리', cancelled);
    if (!cancelled.ok) {
      fail(`테스트 주문(${rcptNo})이 취소되지 않았습니다. 콜마너에서 직접 취소해주세요.`);
    }
  }
}

main().catch((e) => fail(e.message));
