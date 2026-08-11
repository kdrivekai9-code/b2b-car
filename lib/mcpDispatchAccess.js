// 챗봇 → 콜마너 MCP 도구 호출의 권한 경계.
//
// 핵심 원칙: cid(고객 연락처)와 repNo(대표번호)는 절대 LLM이 정하지 않는다. LLM에게 노출하는
// 도구 스키마에서 이 두 인자를 아예 빼고(lib/mcpDispatchAgent.js), 서버가 로그인 세션에서
// 확정한 값만 주입한다. 주문 단위 조작(수정/취소/요금인상)도 rcptNo만 받으면 남의 주문을
// 건드릴 수 있으므로, 호출 전에 "그 rcptNo가 이 사용자에게 허용된 cid의 주문인지"를 실제
// 조회로 확인한다(assertOwnedOrder).
const db = require('../db');
const mcp = require('./mcpDispatchClient');

// 실제 이용고객 후보로 볼 최근 접수건 수 — 너무 늘리면 조회 한 번에 MCP 호출이 그만큼 늘어난다.
const MAX_USAGE_CIDS = 5;

// 콜마너 cid는 하이픈 없는 숫자 문자열이다(01012345678). 사용자가 입력한 형태가 어떻든 통일한다.
function normalizeCid(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  // 국가번호(+82) 형태로 들어온 경우 0으로 되돌린다.
  if (digits.length >= 11 && digits.indexOf('82') === 0 && digits[2] !== '0') return '0' + digits.slice(2);
  return digits;
}

// 챗봇 답변/모델에 노출할 때 쓰는 마스킹 — 가운데 자리를 별표로 가린다(010-****-1240).
// 원본 번호는 서버가 도구 인자로만 쓰고, 화면에 나가는 값은 항상 이 형태다.
function maskPhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '');
  if (!digits) return '';
  if (digits.length < 7) return digits;
  // 지역번호 02만 두 자리, 나머지(010/011/070/031…)는 세 자리를 앞자리로 본다.
  const head = digits.indexOf('02') === 0 ? digits.slice(0, 2) : digits.slice(0, 3);
  const tail = digits.slice(-4);
  return `${head}-${'*'.repeat(Math.max(digits.length - head.length - 4, 3))}-${tail}`;
}

function isPlausiblePhone(cid) {
  return !!cid && /^0\d{8,10}$/.test(cid);
}

// 대표번호(repNo)는 "고객이 등록된 회사(지사)의 전화번호"다. 콜마너 providerId가
// {지사코드}-{대표번호}-{관련어플코드} 형식이라(예: B100-12345-AP12345) 가운데 조각이 대표번호다.
function repNoFromProviderId(providerId) {
  const parts = String(providerId || '').split('-');
  return parts.length >= 3 ? String(parts[1] || '').trim() : '';
}

// 실제 이용 고객(cid) 후보 — 이 사용자가 접수한 오더의 "출발지 연락처"다.
// 요청자(계정 소유자)가 대신 접수하는 경우가 많아서, 콜마너에 고객으로 잡혀 있는 쪽은
// 접수자가 아니라 실제 차량을 이용한 사람인 경우가 흔하다. 그래서 조회는 이 번호들을 먼저 쓰고
// (1차), 여기서 못 찾으면 접수자 본인 번호로 2차 조회한다(사용자 확정 규칙).
async function loadUsageCids(user, limit) {
  if (!user || !user.id) return [];
  try {
    const rows = await db.all(
      `SELECT origin_contact FROM orders
       WHERE created_by = ? AND origin_contact IS NOT NULL AND origin_contact <> ''
       ORDER BY id DESC LIMIT ?`,
      [user.id, Math.max(1, Math.min(Number(limit) || 5, 20))]
    );
    const out = [];
    rows.forEach((row) => {
      const cid = normalizeCid(row.origin_contact);
      if (cid && isPlausiblePhone(cid) && out.indexOf(cid) < 0) out.push(cid);
    });
    return out;
  } catch (e) {
    console.error('실제 이용고객 연락처 조회 실패(빈 목록으로 진행):', e.message);
    return [];
  }
}

// 로그인 사용자 기준으로 MCP 호출 문맥(대표번호 + 허용 cid 목록)을 만든다.
// 지사가 없는 사용자(예: 지사 미배정 관리자)는 환경변수 기본 대표번호로만 동작한다.
// options.viewerCid — "지금 말하고 있는 사람"의 확인된 본인 번호(카카오 개인정보 동의로 받은
// chat_sessions.external_phone). 이게 넘어오면 조회 범위를 그 번호 하나로 좁힌다.
//
// 왜 필요한가: 카카오 세션은 로그인 사용자가 없어 **매핑 계정의 자격**으로 조회한다. 그 계정이
// 여러 이용고객을 대신 접수했으면(실측 9명) 계정 자격으로는 그 전부가 보인다. 접수자 본인이라면
// 맞는 동작이지만, 출발지 연락처로 신원이 확인된 "이용고객"이 물어본 경우라면 본인 건만 보여야
// 한다(사용자 확정 규칙). 호출부가 둘을 구분해 이 옵션을 넘긴다.
async function loadDispatchContext(user, options) {
  const primaryCid = normalizeCid(user && user.phone);
  let branch = null;
  if (user && user.branch_id) {
    // mcp_rep_no는 마이그레이션(20260805010000)으로 추가되는 컬럼이라, 아직 적용 전인 DB에서도
    // 컬럼 목록을 명시하지 않고 전체를 읽어 환경변수 폴백으로 동작하게 한다.
    branch = await db.get('SELECT * FROM branches WHERE id = ?', [user.branch_id]);
  }

  const repNo = String(
    (branch && branch.mcp_rep_no)
    || repNoFromProviderId(branch && branch.callmaner_provider_id)
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

  // 조회 순서를 그대로 담는다: 실제 이용고객(최근 접수건의 출발지 연락처) → 접수자 본인 →
  // 대신 접수해준 이력이 있는 번호(mcp_customer_links).
  const usageCids = await loadUsageCids(user, MAX_USAGE_CIDS);
  const allowedCids = [];
  usageCids.concat(primaryCid ? [primaryCid] : []).concat(linkedCids).forEach((cid) => {
    if (cid && allowedCids.indexOf(cid) < 0) allowedCids.push(cid);
  });

  // 이용고객 본인으로 신원이 확인된 경우 — 계정이 대신 접수해준 다른 사람의 건은 보이면 안 된다.
  // 허용 목록 자체를 본인 번호 하나로 갈아끼운다(도구가 다른 번호를 지정해도 resolveCid에서 막힌다).
  const viewerCid = normalizeCid(options && options.viewerCid);
  if (viewerCid && isPlausiblePhone(viewerCid)) {
    return {
      userId: user.id,
      userName: user.name,
      branchId: branch ? branch.id : null,
      branchName: branch ? branch.name : null,
      repNo: repNo || null,
      primaryCid: viewerCid,
      usageCids: [viewerCid],
      linkedCids: [],
      linkNames: {},
      allowedCids: [viewerCid],
      lookupOrder: [viewerCid],
      viewerScoped: true,
    };
  }

  return {
    userId: user.id,
    userName: user.name,
    branchId: branch ? branch.id : null,
    branchName: branch ? branch.name : null,
    repNo: repNo || null,
    primaryCid,
    usageCids,
    linkedCids,
    linkNames,
    allowedCids,
    // 도구가 cid를 지정하지 않았을 때의 조회 순서(1차 실제이용고객 → 2차 접수자).
    lookupOrder: usageCids.concat(primaryCid && usageCids.indexOf(primaryCid) < 0 ? [primaryCid] : []),
    viewerScoped: false,
  };
}

// 허용된 cid로 정규화한다. LLM이 준 값이 있으면 허용목록 안에 있을 때만 인정하고,
// 없거나 허용목록 밖이면 (신규등록 허용 여부에 따라) 거부하거나 본인 번호로 되돌린다.
function resolveCid(ctx, requestedCid, options) {
  const opts = options || {};
  // 모델이 안내 문구에 쓰인 마스킹 번호(010-****-1240)를 그대로 도구 인자로 되돌려주는 경우가
  // 있다 — 숫자만 남기면 엉뚱한 번호가 되므로 "지정하지 않음"으로 보고 기본 순서를 따른다.
  if (String(requestedCid || '').indexOf('*') >= 0) {
    return resolveCid(ctx, null, options);
  }
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

// 콜마너 접수번호 → 우리 오더번호(OID) 매핑. 챗봇이 "179098847" 같은 콜마너 번호만 안내하면
// 고객은 우리 시스템에서 그 주문을 찾을 수 없다 — orders.callmaner_conf_slip으로 되짚어
// "OID1132(179098847)" 형태로 안내하기 위한 조회다.
async function loadOidsByCallmanerSlips(slips) {
  const list = Array.from(new Set((slips || []).map((v) => String(v || '').trim()).filter(Boolean)));
  if (!list.length) return new Map();
  try {
    const placeholders = list.map(() => '?').join(',');
    const rows = await db.all(
      // 기사 이름·연락처는 콜마너 동기화(routes/callmanerSync.js의 syncDriverInfo)가 채워둔 값이다.
      // "기사님 연락처 좀 알려주세요"가 상담원 발화의 2.8%인데, 그때마다 상담원이 콜마너를 열어
      // 확인해줬다. 조회 결과에 함께 실어주면 그 왕복이 사라진다.
      // 주소도 가져온다. 콜마너 응답의 주소는 잘려서 온다("판교역로 160"이 "판교역로 16"으로) —
      // 고객에게 그대로 보여주면 틀린 주소를 읽어주는 셈이고, 그 값으로 재접수를 시도하면
      // 좌표를 못 찾아 실패한다(실측). 우리 오더가 매칭되면 우리가 가진 원본을 쓴다.
      // 도착지 연락처·요청사항(기사 전달사항)도 가져온다 — 상세 조회에서 출발지 아래 출발지
      // 연락처, 도착지 아래 도착지 연락처를 붙여 안내해야 하는데(사용자 확정 규칙) 콜마너
      // 응답에는 도착지 연락처가 없다. 상세주소는 주소와 따로 저장돼 있어(lib/kakaoIntakeParser.js
      // splitRoadAddress) 합쳐서 보여줘야 고객이 입력한 그대로 보인다.
      `SELECT oid, callmaner_conf_slip, status, created_at, origin_contact, destination_contact,
              origin_address, origin_address_detail, destination_address, destination_address_detail,
              memo_customer,
              reserved_date, reserved_time, order_type, requester_group_id, branch_id,
              callmaner_driver_name, callmaner_driver_phone
       FROM orders WHERE callmaner_conf_slip IN (${placeholders})`,
      list
    );
    const map = new Map();
    rows.forEach((row) => map.set(String(row.callmaner_conf_slip), row));
    return map;
  } catch (e) {
    console.error('콜마너 접수번호 ↔ OID 매핑 조회 실패:', e.message);
    return new Map();
  }
}

// 관리자(지사관리 > 배차지연 알림)가 고객사별로 등록한 설정. 등록되지 않은 고객사에는
// 챗봇이 지연 안내를 먼저 보내지 않는다(옵트인).
const DISPATCH_CALL_TYPE_TO_ORDER_TYPE = {
  corporate_call: 'premium',
  daily_driver: 'daily_driver',
  dispatch: 'dispatch',
};

async function loadDispatchDelaySettings(branchId) {
  if (!branchId) return new Map();
  try {
    const rows = await db.all(
      'SELECT group_id, call_types, delay_minutes, raise_amount FROM dispatch_delay_settings WHERE branch_id = ?',
      [branchId]
    );
    const map = new Map();
    rows.forEach((row) => {
      const orderTypes = String(row.call_types || '')
        .split(',')
        .map((k) => DISPATCH_CALL_TYPE_TO_ORDER_TYPE[k.trim()])
        .filter(Boolean);
      map.set(Number(row.group_id), {
        orderTypes,
        delayMinutes: Number(row.delay_minutes) || null,
        raiseAmount: Number(row.raise_amount) || null,
      });
    });
    return map;
  } catch (e) {
    // 마이그레이션 전이면 설정이 없는 것으로 본다 — 선제 안내가 안 나갈 뿐, 조회는 그대로 동작한다.
    console.error('배차지연 알림 설정 조회 실패(설정 없음으로 진행):', e.message);
    return new Map();
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

  // 우리 오더번호를 알고 있으면 안내 문구에도 같은 규칙(OID(콜마너번호))으로 보여준다.
  const oidMap = await loadOidsByCallmanerSlips([target]);
  const mine = oidMap.get(target);
  const shown = mine && mine.oid ? `${mine.oid}(${target})` : target;
  return { error: `접수번호 ${shown} 주문을 고객님 주문 목록에서 찾지 못했습니다. 접수번호를 다시 확인해주세요.` };
}

module.exports = {
  normalizeCid,
  isPlausiblePhone,
  maskPhone,
  repNoFromProviderId,
  loadUsageCids,
  loadOidsByCallmanerSlips,
  loadDispatchDelaySettings,
  loadDispatchContext,
  resolveCid,
  linkCustomerCid,
  logToolCall,
  loadOwnedOrders,
  assertOwnedOrder,
};
