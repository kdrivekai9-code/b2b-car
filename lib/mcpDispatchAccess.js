// 챗봇 → 콜마너 MCP 도구 호출의 권한 경계.
//
// 핵심 원칙: cid(고객 연락처)와 repNo(대표번호)는 절대 LLM이 정하지 않는다. LLM에게 노출하는
// 도구 스키마에서 이 두 인자를 아예 빼고(lib/mcpDispatchAgent.js), 서버가 로그인 세션에서
// 확정한 값만 주입한다. 주문 단위 조작(수정/취소/요금인상)도 rcptNo만 받으면 남의 주문을
// 건드릴 수 있으므로, 호출 전에 "그 rcptNo가 이 사용자에게 허용된 cid의 주문인지"를 실제
// 조회로 확인한다(assertOwnedOrder).
const db = require('../db');
const mcp = require('./mcpDispatchClient');

// 콜마너 cid는 하이픈 없는 숫자 문자열이다(01012345678). 사용자가 입력한 형태가 어떻든 통일한다.
function normalizeCid(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  // 국가번호(+82) 형태로 들어온 경우 0으로 되돌린다.
  if (digits.length >= 11 && digits.indexOf('82') === 0 && digits[2] !== '0') return '0' + digits.slice(2);
  return digits;
}

function isPlausiblePhone(cid) {
  return !!cid && /^0\d{8,10}$/.test(cid);
}

// 로그인 사용자 기준으로 MCP 호출 문맥(대표번호 + 허용 cid 목록)을 만든다.
// 지사가 없는 사용자(예: 지사 미배정 관리자)는 환경변수 기본 대표번호로만 동작한다.
async function loadDispatchContext(user) {
  const primaryCid = normalizeCid(user && user.phone);
  let branch = null;
  if (user && user.branch_id) {
    // mcp_rep_no는 마이그레이션(20260805010000)으로 추가되는 컬럼이라, 아직 적용 전인 DB에서도
    // 컬럼 목록을 명시하지 않고 전체를 읽어 환경변수 폴백으로 동작하게 한다.
    branch = await db.get('SELECT * FROM branches WHERE id = ?', [user.branch_id]);
  }

  // 대표번호는 지사 설정(branches.mcp_rep_no)이 유일한 출처다. 한때 콜마너 providerId
  // (B100-12345-AP12345)의 가운데 조각을 대표번호로 유도했는데, 실제 대표번호는 그것과 다른
  // 값이었다(B100의 대표번호는 01036462043) — 조용히 틀린 번호로 조회가 나가는 게 더 나쁘므로
  // 유도 로직을 없애고, 설정이 없으면 환경변수 기본값, 그것도 없으면 도우미를 끈다.
  const repNo = String(
    (branch && branch.mcp_rep_no)
    || process.env.MCP_DISPATCH_DEFAULT_REP_NO
    || ''
  ).trim();

  // 같은 이유로(마이그레이션 미적용 DB) 링크 조회 실패는 "연결된 실제이용고객 없음"으로 다룬다 —
  // 본인 주문 조회는 이 테이블 없이도 동작해야 한다.
  let linkRows = [];
  try {
    linkRows = await db.all(
      'SELECT cid, display_name FROM mcp_customer_links WHERE owner_user_id = ? AND revoked_at IS NULL ORDER BY id DESC',
      [user.id]
    );
  } catch (e) {
    console.error('실제이용고객 링크 조회 실패(빈 목록으로 진행):', e.message);
  }

  const linkedCids = [];
  const linkNames = {};
  linkRows.forEach((row) => {
    const cid = normalizeCid(row.cid);
    if (!cid || linkedCids.indexOf(cid) >= 0) return;
    linkedCids.push(cid);
    if (row.display_name) linkNames[cid] = row.display_name;
  });

  const allowedCids = primaryCid ? [primaryCid].concat(linkedCids.filter((c) => c !== primaryCid)) : linkedCids;

  return {
    userId: user.id,
    userName: user.name,
    branchId: branch ? branch.id : null,
    branchName: branch ? branch.name : null,
    repNo: repNo || null,
    primaryCid,
    linkedCids,
    linkNames,
    allowedCids,
  };
}

// 허용된 cid로 정규화한다. LLM이 준 값이 있으면 허용목록 안에 있을 때만 인정하고,
// 없거나 허용목록 밖이면 (신규등록 허용 여부에 따라) 거부하거나 본인 번호로 되돌린다.
function resolveCid(ctx, requestedCid, options) {
  const opts = options || {};
  const requested = normalizeCid(requestedCid);

  if (!requested) {
    if (!ctx.primaryCid) {
      return { error: '고객 연락처가 등록되어 있지 않습니다. 담당자에게 연락처 등록을 요청해주세요.' };
    }
    return { cid: ctx.primaryCid, isNew: false };
  }
  if (ctx.allowedCids.indexOf(requested) >= 0) return { cid: requested, isNew: false };

  if (opts.allowNew) {
    if (!isPlausiblePhone(requested)) {
      return { error: '연락처 형식이 올바르지 않습니다. 010으로 시작하는 휴대폰 번호로 알려주세요.' };
    }
    return { cid: requested, isNew: true };
  }
  return {
    error: '조회/변경 권한이 없는 연락처입니다. 본인 연락처 또는 직접 접수한 실제 이용 고객의 주문만 처리할 수 있습니다.',
  };
}

// 실제이용고객 번호를 등록고객 밑에 연결한다(주문 등록이 성공한 뒤에만 호출).
async function linkCustomerCid(ctx, cid, displayName) {
  const normalized = normalizeCid(cid);
  if (!normalized || normalized === ctx.primaryCid) return;
  try {
    await db.run(
      `INSERT INTO mcp_customer_links (owner_user_id, cid, display_name) VALUES (?, ?, ?)
       ON CONFLICT (owner_user_id, cid) DO UPDATE SET revoked_at = NULL,
         display_name = COALESCE(EXCLUDED.display_name, mcp_customer_links.display_name)`,
      [ctx.userId, normalized, displayName || null]
    );
    if (ctx.allowedCids.indexOf(normalized) < 0) ctx.allowedCids.push(normalized);
    if (ctx.linkedCids.indexOf(normalized) < 0) ctx.linkedCids.push(normalized);
  } catch (e) {
    // 링크 저장 실패가 이미 성공한 주문 접수를 되돌릴 이유는 없다 — 로그만 남긴다
    // (다음 조회 때는 권한이 없어 보일 수 있으므로 오류는 그대로 노출한다).
    console.error('실제이용고객 연락처 링크 저장 실패:', e.message);
  }
}

async function logToolCall(ctx, sessionId, toolName, args, ok, error) {
  try {
    await db.run(
      'INSERT INTO mcp_tool_calls (user_id, session_id, tool_name, arguments_json, ok, error) VALUES (?, ?, ?, ?, ?, ?)',
      [ctx.userId, sessionId || null, toolName, JSON.stringify(args || {}), !!ok, error ? String(error).slice(0, 500) : null]
    );
  } catch (e) {
    console.error('MCP 도구 호출 감사 로그 저장 실패:', e.message);
  }
}

// 허용된 cid들의 주문(진행 중 + 최근 이력)을 모아 rcptNo → 주문 맵을 만든다.
// 수정/취소/요금인상 직전 소유 확인과, "내 주문 목록" 응답에 함께 쓴다.
async function loadOwnedOrders(ctx, options) {
  const opts = options || {};
  const includeHistory = !!opts.includeHistory;
  const byRcptNo = new Map();
  const orders = [];

  for (const cid of ctx.allowedCids) {
    const tools = includeHistory ? ['call.list.active', 'call.list.history'] : ['call.list.active'];
    for (const toolName of tools) {
      const args = { repNo: ctx.repNo, cid };
      if (toolName === 'call.list.history') {
        args.page = 1;
        args.pageSize = opts.historyPageSize || 10;
        if (opts.startDate) args.startDate = opts.startDate;
        if (opts.endDate) args.endDate = opts.endDate;
      }
      let out;
      try {
        out = await mcp.callTool(toolName, args);
      } catch (e) {
        console.error(`${toolName} 조회 실패(${cid}):`, e.message);
        continue;
      }
      // 미등록 고객(CUSTOMER_NOT_FOUND) 등은 조용히 건너뛴다 — 여러 cid를 순회하는 자리라
      // 하나가 미등록이어도 나머지 결과는 그대로 쓸 수 있어야 한다.
      if (!out.ok) continue;
      const list = (out.data && out.data.orders) || [];
      list.forEach((order) => {
        if (!order) return;
        const rcptNo = String(order.rcptNo || '').trim();
        const enriched = { ...order, cid, isHistory: toolName === 'call.list.history' };
        orders.push(enriched);
        if (rcptNo && !byRcptNo.has(rcptNo)) byRcptNo.set(rcptNo, enriched);
      });
    }
  }
  return { orders, byRcptNo };
}

// rcptNo(또는 orderId)가 이 사용자에게 허용된 주문인지 확인한다. 진행 중 주문에서 먼저 찾고,
// 없으면 이력까지 넓혀 한 번 더 본다(취소/수정 대상은 보통 진행 중이지만, 예약 건이 이력
// 조회에만 걸리는 경우가 있어 두 단계로 확인한다).
async function assertOwnedOrder(ctx, rcptNo) {
  const target = String(rcptNo || '').trim();
  if (!target) return { error: '대상 주문번호(접수번호)가 없습니다.' };

  const active = await loadOwnedOrders(ctx, { includeHistory: false });
  if (active.byRcptNo.has(target)) return { order: active.byRcptNo.get(target) };

  const withHistory = await loadOwnedOrders(ctx, { includeHistory: true, historyPageSize: 20 });
  if (withHistory.byRcptNo.has(target)) return { order: withHistory.byRcptNo.get(target) };

  return { error: '해당 접수번호의 주문을 고객님 주문 목록에서 찾지 못했습니다. 접수번호를 다시 확인해주세요.' };
}

module.exports = {
  normalizeCid,
  isPlausiblePhone,
  loadDispatchContext,
  resolveCid,
  linkCustomerCid,
  logToolCall,
  loadOwnedOrders,
  assertOwnedOrder,
};
