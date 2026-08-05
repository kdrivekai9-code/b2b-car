// 콜마너 MCP 서버(callmaner-mcp, Streamable HTTP) JSON-RPC 클라이언트.
//
// 왜 REST(/api/v1)가 아니라 MCP(/mcp)인가: 이 서버는 같은 백엔드 오퍼레이션을 REST와 MCP 두 가지로
// 노출하는데(openapi.yaml의 설명 참조), 챗봇이 "툴 목록을 조회해서 상황에 맞는 툴을 골라 응답"하는 게
// 목표라 도구 카탈로그(tools/list)와 호출 규약(tools/call)을 그대로 쓰는 MCP 쪽이 맞다.
//
// 전송 규약에서 실제로 걸렸던 것들:
// - 응답 Content-Type이 대개 text/event-stream이다(JSON이 아님). 그래서 res.json()으로 못 읽고
//   SSE 프레임의 data: 줄을 직접 파싱해야 한다. Accept 헤더에 두 타입을 모두 넣어야 401/406이 안 난다.
// - initialize 응답 헤더의 mcp-session-id를 이후 모든 요청에 Mcp-Session-Id로 되돌려줘야 한다.
//   서버가 세션을 만료시키면(재시작 등) 그 세션으로 온 요청은 실패하므로, 한 번은 재초기화 후 재시도한다.
// - tools/call은 성공해도 result.isError로 도구 자체의 실패를 알려준다(JSON-RPC error가 아니라).
const DEFAULT_BASE_URL = 'https://mcp-n-rest-api.xmobiai.com';
const PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15000;

let session = null; // { id, initializedAt }
let initInFlight = null;
let nextRequestId = 1;

function baseUrl() {
  return String(process.env.MCP_DISPATCH_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function apiKey() {
  const key = String(process.env.MCP_DISPATCH_API_KEY || '').trim();
  if (!key) throw new Error('MCP_DISPATCH_API_KEY 환경변수가 설정되어 있지 않습니다.');
  return key;
}

function isConfigured() {
  return !!String(process.env.MCP_DISPATCH_API_KEY || '').trim();
}

async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (e) {
    if (e.name === 'AbortError') {
      throw new Error(`MCP 서버 응답이 ${Math.round(timeoutMs / 1000)}초 내에 오지 않았습니다.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// text/event-stream 본문에서 첫 JSON-RPC 메시지를 뽑는다. 서버가 application/json으로 줄 때도
// 있으므로(협상 결과에 따라) 그 경우는 본문 전체를 그대로 JSON으로 파싱한다.
function parseRpcBody(contentType, raw) {
  const body = String(raw || '').trim();
  if (!body) return null;
  if (String(contentType || '').indexOf('text/event-stream') === -1) {
    return JSON.parse(body);
  }
  const dataLines = body
    .split(/\r?\n/)
    .filter((line) => line.indexOf('data:') === 0)
    .map((line) => line.slice(5).trim())
    .filter(Boolean);
  for (const line of dataLines) {
    let parsed;
    try { parsed = JSON.parse(line); } catch (e) { continue; }
    // 알림(notification, id 없음)은 건너뛰고 우리가 보낸 요청의 응답만 취한다.
    if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
  }
  return null;
}

async function rpc(method, params, options) {
  const opts = options || {};
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'X-API-Key': apiKey(),
    'MCP-Protocol-Version': PROTOCOL_VERSION,
  };
  if (opts.sessionId) headers['Mcp-Session-Id'] = opts.sessionId;

  const isNotification = !!opts.notification;
  const payload = isNotification
    ? { jsonrpc: '2.0', method, params: params || {} }
    : { jsonrpc: '2.0', id: nextRequestId++, method, params: params || {} };

  const res = await fetchWithTimeout(`${baseUrl()}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  }, opts.timeoutMs || DEFAULT_TIMEOUT_MS);

  const raw = await res.text();
  if (!res.ok) {
    const err = new Error(`MCP ${method} 실패 (HTTP ${res.status}): ${raw.slice(0, 300)}`);
    err.httpStatus = res.status;
    // 세션 만료/미인식은 재초기화로 회복 가능한 오류로 표시한다.
    err.sessionExpired = res.status === 400 || res.status === 404;
    throw err;
  }
  if (isNotification) return { sessionId: res.headers.get('mcp-session-id') || opts.sessionId || null };

  const parsed = parseRpcBody(res.headers.get('content-type'), raw);
  if (!parsed) throw new Error(`MCP ${method} 응답을 해석할 수 없습니다: ${raw.slice(0, 200)}`);
  if (parsed.error) {
    const err = new Error(`MCP ${method} 오류: ${parsed.error.message || JSON.stringify(parsed.error)}`);
    err.rpcCode = parsed.error.code;
    throw err;
  }
  return { result: parsed.result, sessionId: res.headers.get('mcp-session-id') || opts.sessionId || null };
}

async function ensureSession() {
  if (session) return session;
  if (initInFlight) return initInFlight;

  initInFlight = (async () => {
    const init = await rpc('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'b2b-car-chatbot', version: '1.0.0' },
    });
    const id = init.sessionId;
    if (!id) throw new Error('MCP initialize 응답에 세션 ID가 없습니다.');
    // 규약상 initialize 직후 initialized 알림을 보내야 서버가 세션을 활성으로 본다.
    // 이 알림이 실패해도 대부분의 서버는 tools/call을 받아주므로 치명적으로 다루지 않는다.
    try {
      await rpc('notifications/initialized', {}, { sessionId: id, notification: true, timeoutMs: 5000 });
    } catch (e) {
      console.error('MCP initialized 알림 실패(무시하고 진행):', e.message);
    }
    return { id, initializedAt: Date.now() };
  })();

  try {
    session = await initInFlight;
    return session;
  } finally {
    initInFlight = null;
  }
}

// 세션 만료로 실패하면 세션을 버리고 한 번만 재시도한다.
async function withSession(fn) {
  const active = await ensureSession();
  try {
    return await fn(active.id);
  } catch (e) {
    if (!e.sessionExpired) throw e;
    session = null;
    const renewed = await ensureSession();
    return fn(renewed.id);
  }
}

async function listTools() {
  const out = await withSession((sessionId) => rpc('tools/list', {}, { sessionId }));
  return (out.result && out.result.tools) || [];
}

// tools/call 결과에서 구조화된 값을 꺼낸다. 이 서버는 structuredContent를 채워주지만,
// 규약상 없을 수도 있어 content[].text의 JSON 파싱까지 폴백한다.
function extractToolResult(result) {
  if (!result) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const textPart = Array.isArray(result.content)
    ? result.content.find((c) => c && c.type === 'text' && typeof c.text === 'string')
    : null;
  if (!textPart) return null;
  try { return JSON.parse(textPart.text); } catch (e) { return { text: textPart.text }; }
}

function resultErrorText(result) {
  if (!Array.isArray(result && result.content)) return '도구 실행이 실패했습니다.';
  return result.content
    .filter((c) => c && c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join(' ')
    .slice(0, 500) || '도구 실행이 실패했습니다.';
}

// 도구 호출. 도구 자체가 실패하면(isError) Error를 던지는 대신 { ok:false, error }를 돌려준다 —
// 챗봇 에이전트 루프가 "고객이 미등록입니다" 같은 실패도 LLM에게 그대로 알려주고 문장으로 안내해야 하기 때문.
async function callTool(name, args, options) {
  const opts = options || {};
  const out = await withSession((sessionId) => rpc('tools/call', {
    name,
    arguments: args || {},
  }, { sessionId, timeoutMs: opts.timeoutMs || DEFAULT_TIMEOUT_MS }));

  const result = out.result || {};
  const data = extractToolResult(result);
  if (result.isError) {
    return { ok: false, error: resultErrorText(result), data };
  }
  return { ok: true, data };
}

module.exports = { listTools, callTool, isConfigured, baseUrl };
