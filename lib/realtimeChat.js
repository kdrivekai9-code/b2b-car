// 상담 채팅 Realtime 계층 — 브라우저에는 Supabase 키를 전혀 노출하지 않는다.
// 서버(서비스 롤 키)만 Supabase Realtime(Broadcast/Presence)에 연결하고,
// 브라우저에는 우리 서버가 SSE로 중계한다(인증은 기존 세션 쿠키 그대로 사용).
//
// 주의: 같은 Supabase 클라이언트 인스턴스로 동일한 토픽명에 channel()을 두 번 구독하면
// (예: 세션 채널을 SSE 수신용으로 열어둔 상태에서 같은 클라이언트로 브로드캐스트 발송을 또 구독하면)
// 두 번째 subscribe 콜백이 영원히 응답하지 않는 문제를 실측으로 확인했다.
// 그래서 "구독을 유지하는 연결"(SSE 릴레이, presence)과 "한 번 보내고 끝내는 발송"은
// 절대 클라이언트 인스턴스를 공유하지 않고 매번/매 연결마다 별도 클라이언트를 새로 만든다.
const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const db = require('../db');

const AGENT_PRESENCE_CHANNEL = 'chat-agents-presence';
const SESSION_LIST_CHANNEL = 'chat-sessions-list';
const ORDER_LIST_CHANNEL = 'orders-list';
const PRESENCE_HEARTBEAT_MS = 15000;
const PRESENCE_STALE_SECONDS = 30;
const PRESENCE_DELETE_GRACE_MS = 10000; // 재연결(끊김->재접속) 사이 짧은 순간 "아무도 없음"으로 보이는 걸 막기 위한 유예시간
const BROADCAST_TIMEOUT_MS = 5000;

function newClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.');
  }
  return createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
}

function sessionChannelName(sessionId) {
  return `chat-session-${sessionId}`;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 타임아웃(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 메시지 저장 직후 호출 — 세션 채널 구독자(고객/관리자 SSE 스트림)에게 즉시 중계한다.
// 매 호출마다 전용 클라이언트를 새로 만들어 쓰고 끝나면 완전히 끊는다(구독 중인 연결과 절대 공유하지 않음).
// 호출부는 이 함수를 await하지 않고 fire-and-forget으로 쓴다 — Realtime이 느려져도
// 이미 DB에 저장된 메시지에 대한 응답까지 늦어지면 안 되기 때문. 그래도 내부적으로는
// 커넥션이 무한정 붙잡혀 있지 않도록 타임아웃을 건다.
async function broadcastMessage(sessionId, message) {
  const supabase = newClient();
  const channel = supabase.channel(sessionChannelName(sessionId));
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            channel.send({ type: 'broadcast', event: 'new_message', payload: message }).then(resolve).catch(reject);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            reject(new Error(`broadcast subscribe 실패: ${status}`));
          }
        });
      }),
      BROADCAST_TIMEOUT_MS,
      '메시지 브로드캐스트'
    );
  } finally {
    try { supabase.removeChannel(channel); } catch (e) { /* noop */ }
    try { supabase.realtime.disconnect(); } catch (e) { /* noop */ }
  }
}

// 읽음 처리(상담원이 고객 메시지를 읽음 / 고객이 상담원 메시지를 읽음) 직후 호출 —
// 이미 그 세션을 보고 있는 상대측 화면(카드뷰/상세뷰)에 실시간으로 "읽음" 배지를 갱신시킨다.
// 이게 없으면 DB는 갱신되어도 이미 렌더링된 말풍선의 배지는 새로고침 전까지 미읽음으로 남아 있었다.
async function broadcastReadReceipt(sessionId, reader) {
  const supabase = newClient();
  const channel = supabase.channel(sessionChannelName(sessionId));
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            channel.send({ type: 'broadcast', event: 'read_receipt', payload: { reader } }).then(resolve).catch(reject);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            reject(new Error(`읽음 신호 subscribe 실패: ${status}`));
          }
        });
      }),
      BROADCAST_TIMEOUT_MS,
      '읽음 신호 브로드캐스트'
    );
  } finally {
    try { supabase.removeChannel(channel); } catch (e) { /* noop */ }
    try { supabase.realtime.disconnect(); } catch (e) { /* noop */ }
  }
}

// 세션 목록 화면에 "뭔가 바뀌었다"는 신호를 보낸다 — 새 세션 생성/상태 변경 때만 부른다.
// 메시지 하나하나마다 부르면 목록 화면이 너무 자주 갱신되므로 일부러 이 계기에서만 쓴다.
// payload는 대개 빈 객체(그냥 "다시 조회해라" 신호)지만, 상담원 호출처럼 알림센터 팝업에
// 바로 띄울 내용(세션id/고객명/메시지)이 있을 때는 채워서 넘긴다.
async function broadcastSessionListChanged(payload) {
  const supabase = newClient();
  const channel = supabase.channel(SESSION_LIST_CHANNEL);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            channel.send({ type: 'broadcast', event: 'changed', payload: payload || {} }).then(resolve).catch(reject);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            reject(new Error(`session-list broadcast subscribe 실패: ${status}`));
          }
        });
      }),
      BROADCAST_TIMEOUT_MS,
      '세션 목록 갱신 신호'
    );
  } finally {
    try { supabase.removeChannel(channel); } catch (e) { /* noop */ }
    try { supabase.realtime.disconnect(); } catch (e) { /* noop */ }
  }
}

// 오더 리스트 화면(고객/관리자 공용) 실시간 갱신 — 위 세션 목록 갱신 신호와 완전히 동일한
// 패턴을 오더 생성/상태변경/배정/수정/VOC 등에도 재사용한다. payload 없이 "뭔가 바뀌었다"는
// 신호만 보내고, 각 클라이언트는 이미 인증/스코프가 적용된 자기 화면의 데이터를 다시
// 불러온다(고객은 scopeFilter로 자기 오더만 다시 보이므로, 전체 공용 채널 하나로도 안전하다).
async function broadcastOrderListChanged(payload) {
  const supabase = newClient();
  const channel = supabase.channel(ORDER_LIST_CHANNEL);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        channel.subscribe((status) => {
          if (status === 'SUBSCRIBED') {
            channel.send({ type: 'broadcast', event: 'changed', payload: payload || {} }).then(resolve).catch(reject);
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            reject(new Error(`order-list broadcast subscribe 실패: ${status}`));
          }
        });
      }),
      BROADCAST_TIMEOUT_MS,
      '오더 목록 갱신 신호'
    );
  } finally {
    try { supabase.removeChannel(channel); } catch (e) { /* noop */ }
    try { supabase.realtime.disconnect(); } catch (e) { /* noop */ }
  }
}

// 오더 리스트 화면의 SSE 라우트에서 호출 — "뭔가 바뀌었다" 신호를 onSignal로 넘겨준다.
function openOrderListStream(onSignal) {
  const supabase = newClient();
  const channel = supabase.channel(ORDER_LIST_CHANNEL);
  channel.on('broadcast', { event: 'changed' }, ({ payload }) => onSignal(payload));
  channel.subscribe();
  return { supabase, channel };
}

// SSE 라우트에서 호출 — 해당 세션 채널을 구독하고 새 메시지가 올 때마다 onMessage로 넘겨준다.
// 이 연결 전용 클라이언트를 새로 만들어 반환하며, 종료 시 반드시 closeChannel()로 정리해야 한다.
// onReadReceipt(선택)을 넘기면 같은 세션 채널의 읽음 신호도 함께 구독한다(관리자 화면 전용 —
// 고객 화면은 읽음 배지 UI가 없어서 이 이벤트를 구독할 필요가 없다).
function openSessionStream(sessionId, onMessage, onReadReceipt) {
  const supabase = newClient();
  const channel = supabase.channel(sessionChannelName(sessionId));
  channel.on('broadcast', { event: 'new_message' }, ({ payload }) => onMessage(payload));
  if (onReadReceipt) {
    channel.on('broadcast', { event: 'read_receipt' }, ({ payload }) => onReadReceipt(payload));
  }
  channel.subscribe();
  return { supabase, channel };
}

// 관리자 세션 목록 화면의 SSE 라우트에서 호출 — "뭔가 바뀌었다" 신호(+있으면 payload)를 onSignal로 넘겨준다.
function openSessionListStream(onSignal) {
  const supabase = newClient();
  const channel = supabase.channel(SESSION_LIST_CHANNEL);
  channel.on('broadcast', { event: 'changed' }, ({ payload }) => onSignal(payload));
  channel.subscribe();
  return { supabase, channel };
}

function closeChannel(handle) {
  if (!handle) return;
  try { handle.supabase.removeChannel(handle.channel); } catch (e) { /* noop */ }
  try { handle.supabase.realtime.disconnect(); } catch (e) { /* noop */ }
}

// 관리자가 상담 관리 화면(목록/상세)을 열어두는 동안 SSE 연결 하나당 호출(연결마다 전용 클라이언트).
// 실제 Supabase Presence에 track()하고, 동시에 DB(chat_agent_presence)에도 반영해서
// 서버리스 인스턴스가 달라도(고객 요청 처리 인스턴스에서) 빠르게 조회할 수 있게 한다.
// 반환하는 wasAnyoneOnlineBefore로 "이 연결이 등록되기 전에는 접속자가 0명이었는지"를 알려준다
// (0->1 전환 시 대기 중인 상담 세션에 알림을 보내는 데 쓰기 위함).
async function startAgentPresence(userId, userName) {
  const wasAnyoneOnlineBefore = await isAnyAgentOnline();

  const connectionId = crypto.randomUUID();
  await db.run(`INSERT INTO chat_agent_presence (id, user_id) VALUES (?, ?)`, [connectionId, userId]);

  const supabase = newClient();
  const channel = supabase.channel(AGENT_PRESENCE_CHANNEL);
  try {
    await withTimeout(
      new Promise((resolve, reject) => {
        channel.subscribe(async (status) => {
          if (status === 'SUBSCRIBED') {
            try { await channel.track({ user_id: userId, name: userName, connection_id: connectionId }); resolve(); }
            catch (e) { reject(e); }
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            reject(new Error(`presence subscribe 실패: ${status}`));
          }
        });
      }),
      BROADCAST_TIMEOUT_MS,
      '상담원 presence 등록'
    );
  } catch (e) {
    // Presence 채널 등록이 실패/지연되어도 "온라인 여부" 판단은 DB 행(위에서 이미 INSERT함)만으로 계속 동작한다.
    // Presence 트래킹은 부가 기능(향후 실시간 접속자 목록 등)이지 온라인 판정의 필수 조건이 아니다.
    console.error('상담원 presence 채널 등록 실패(DB 기반 온라인 판정에는 영향 없음):', e.message);
  }

  const heartbeat = setInterval(() => {
    db.run(`UPDATE chat_agent_presence SET last_seen_at = now() WHERE id = ?`, [connectionId]).catch(() => {});
  }, PRESENCE_HEARTBEAT_MS);

  async function stop() {
    clearInterval(heartbeat);
    try { await channel.untrack(); } catch (e) { /* noop */ }
    try { supabase.removeChannel(channel); } catch (e) { /* noop */ }
    try { supabase.realtime.disconnect(); } catch (e) { /* noop */ }
    // 바로 지우지 않고 잠깐 남겨둔다 — EventSource가 끊기자마자 재연결하는 흔한 경우,
    // 새 행이 채 들어오기 전에 이 행이 먼저 사라지면 그 찰나에 "아무도 없음"으로 잘못 보일 수 있다.
    setTimeout(() => {
      db.run(`DELETE FROM chat_agent_presence WHERE id = ?`, [connectionId]).catch(() => {});
    }, PRESENCE_DELETE_GRACE_MS);
  }
  return { stop, wasAnyoneOnlineBefore };
}

// 지금 응대 가능한 상담원이 한 명이라도 있는지 — DB 캐시를 빠르게 조회만 한다(Realtime 재구독 없음).
async function isAnyAgentOnline() {
  const row = await db.get(
    `SELECT EXISTS (SELECT 1 FROM chat_agent_presence WHERE last_seen_at > now() - interval '${PRESENCE_STALE_SECONDS} seconds') AS online`
  );
  return !!(row && row.online);
}

async function listOnlineAgentNames() {
  const rows = await db.all(
    `SELECT DISTINCT u.name FROM chat_agent_presence p
     JOIN users u ON u.id = p.user_id
     WHERE p.last_seen_at > now() - interval '${PRESENCE_STALE_SECONDS} seconds'
     ORDER BY u.name`
  );
  return rows.map((r) => r.name);
}

module.exports = {
  // routes/chat.js의 목록 버전 계산이 같은 기준을 써야 한다 — 여기서 30초를 쓰고 저기서
  // 다른 값을 쓰면 "접속 중" 판정이 화면과 버전에서 갈린다.
  PRESENCE_STALE_SECONDS,
  broadcastMessage,
  broadcastReadReceipt,
  broadcastSessionListChanged,
  broadcastOrderListChanged,
  openSessionStream,
  openSessionListStream,
  openOrderListStream,
  closeChannel,
  startAgentPresence,
  isAnyAgentOnline,
  listOnlineAgentNames,
};
