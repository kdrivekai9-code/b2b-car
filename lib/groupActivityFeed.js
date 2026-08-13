// 법인 공유 피드 — 같은 법인 소속 사용자들이 서로의 접수·취소·변경 요청을 볼 수 있게 한다.
// 실사용 요청: 카카오/웹톡이 "고객 1 : 상담원 다수" 구조라, 같은 회사 동료들끼리는 서로
// 무엇을 요청했는지 알 방법이 없었다. 법인 단위 옵트인(groups_tbl.share_activity_feed)이라
// 기본은 꺼져 있다 — 켠 법인만 기록이 쌓이므로, 대다수 법인에는 이 기능으로 인한 쓰기 비용이
// 전혀 없다.
//
// 무엇을 담는가(사용자 확정 범위) — 대화 원문이 아니라 "동료가 직접 한 요청/결정"만 구조화된
// 한 줄로 담는다:
//   · 신규 접수(created)  — 출발지·도착지(연락처)·차량·일시·경유지·요청사항
//   · 취소(cancelled)     — 취소 시점·사유(있으면)
//   · 변경(updated)       — 경로·일시·차량·요금이 바뀐 내용, 요청사항(메모) 추가·변경도 포함
// 콜마너 폴링에 의한 자동 상태 전이(대기→접수→기사배정→완료)나 기사 배정/위치 갱신 같은
// 운영 정보는 담지 않는다 — 그건 "동료의 요청"이 아니라 시스템이 처리 중인 이행 정보라
// 넣으면 피드가 시끄러워지기만 한다. 필요하면 오더 상세로 들어가서 본다.
const db = require('../db');
const { broadcastMessage } = require('./realtimeChat');
const kakaoConsult = require('./kakaoConsult');
const { isSessionBusy } = require('./sessionBusy');

const KIND_VERB = { created: '새 오더를 접수했습니다', cancelled: '오더를 취소했습니다', updated: '오더 내용을 변경했습니다' };

// 대화창 안에서 "내 질문에 대한 답"이 아니라는 걸 한눈에 알 수 있게, 항상 같은 머리말을 쓴다.
// 카카오는 배경색/아이콘 같은 스타일링이 안 되므로(단순 텍스트 스트림) 구분선까지 텍스트로 넣는다 —
// 웹은 같은 문구에 CSS(.ai-system)로 옅은 배경을 추가로 입힌다(public/css/style.css).
function buildNoticeBody(kind, actorLabel, summary) {
  const who = actorLabel ? `${actorLabel}님이` : '팀 동료가';
  const verb = KIND_VERB[kind] || '오더를 처리했습니다';
  return `${who} ${verb}\n${summary}`;
}

function buildWebNoticeText(kind, actorLabel, summary) {
  return `팀 접수 현황 안내\n${buildNoticeBody(kind, actorLabel, summary)}`;
}

function buildKakaoNoticeText(kind, actorLabel, summary) {
  return `📋 팀 접수 현황 안내\n──────────────\n${buildNoticeBody(kind, actorLabel, summary)}`;
}

// 웹: 같은 법인 소속의 다른 로그인 사용자가 지금 열어둔(닫히지 않은) 챗봇 세션에 system 메시지를
// 남기고 SSE로 즉시 알린다. 방해 안 가기: 그 세션이 지금 봇 질문에 답을 기다리는 중
// (draft_json.phase==='collecting' && pendingField)이면 이번 알림은 건너뛴다 — 재시도 큐는 두지
// 않는다(다음 접수·취소·변경 이벤트 때 정상 수신되며, 그 사이 알림 하나를 놓치는 정도의 트레이드오프).
async function notifyWebMembers(groupId, actorUserId, text) {
  let targets;
  try {
    targets = await db.all(
      `SELECT id, draft_json FROM chat_sessions
       WHERE channel = 'web' AND status <> 'closed'
         AND user_id IN (SELECT id FROM users WHERE group_id = ? AND status = 'active')
         AND (CAST(? AS integer) IS NULL OR user_id <> ?)`,
      [groupId, actorUserId || null, actorUserId || null]
    );
  } catch (e) {
    console.error('법인 알림 대상(웹) 조회 실패:', e.message);
    return;
  }
  for (const session of targets) {
    // 판정은 lib/sessionBusy.js에 모아뒀다 — 오더 능동 통보(lib/kakaoOrderNotify.js)도 같은
    // 기준을 써야 한쪽만 조용해지는 일이 없다.
    if (isSessionBusy(session)) continue; // 응답 대기 중 — 끼어들지 않음
    try {
      const inserted = await db.get(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
        [session.id, text]
      );
      broadcastMessage(session.id, inserted).catch((e) => console.error('법인 알림(웹) 브로드캐스트 실패:', e.message));
    } catch (e) {
      console.error('법인 알림(웹) 전달 실패:', e.message);
    }
  }
}

// 카카오: kakao_consult_accounts에 개인 단위로 매핑된(external_user_key가 있는) 같은 법인 소속
// 담당자에게 선제 발송한다. 상담 세션(Event Key)은 고객의 마지막 메시지로부터 30일간 유지·연장
// 되고 그 안에서는 상담원이 먼저 말을 걸 수 있다(docs/kakao-consult-api-spec.txt 용어집) — 최근
// 활동이 있던 담당자라면 사실상 즉시 도달한다. 방해 안 가기: 그 세션이 접수 진행 중이거나
// (intake_slots_json) 배차 도우미 확인 대기 중(mcp_pending_json)이면 이번 알림은 건너뛴다.
async function notifyKakaoMembers(groupId, actorUserId, text) {
  let targets;
  try {
    targets = await db.all(
      `SELECT DISTINCT ON (kca.external_user_key)
              cs.id AS session_id, cs.kakao_service_key, cs.kakao_user_key, cs.kakao_event_key,
              cs.intake_slots_json, cs.mcp_pending_json
       FROM kakao_consult_accounts kca
       JOIN chat_sessions cs ON cs.channel = 'kakao' AND cs.kakao_event_key IS NOT NULL
         AND (cs.external_user_key = kca.external_user_key OR cs.kakao_user_key = kca.external_user_key)
       WHERE kca.requester_group_id = ? AND kca.enabled = true AND kca.external_user_key IS NOT NULL
         AND (CAST(? AS integer) IS NULL OR kca.user_id IS DISTINCT FROM ?)
       ORDER BY kca.external_user_key, cs.id DESC`,
      [groupId, actorUserId || null, actorUserId || null]
    );
  } catch (e) {
    console.error('법인 알림 대상(카카오) 조회 실패:', e.message);
    return;
  }
  for (const row of targets) {
    if (isSessionBusy(row)) continue; // 접수/도우미 확인 진행 중 — 끼어들지 않음
    const sessionShape = {
      kakao_service_key: row.kakao_service_key,
      kakao_user_key: row.kakao_user_key,
      kakao_event_key: row.kakao_event_key,
    };
    try {
      const inserted = await db.get(
        `INSERT INTO chat_messages (session_id, sender, message) VALUES (?, 'system', ?) RETURNING *`,
        [row.session_id, text]
      );
      broadcastMessage(row.session_id, inserted).catch(() => {});
    } catch (e) {
      console.error('법인 알림(카카오) 대화 기록 실패:', e.message);
    }
    const result = await kakaoConsult.sendMessage(sessionShape, text).catch((e) => ({ ok: false, error: e.message }));
    if (!result.ok) console.error('법인 알림(카카오) 발신 실패:', result.error);
  }
}

async function notifyGroupMembers({ groupId, kind, summary, actorUserId, actorLabel }) {
  await Promise.all([
    notifyWebMembers(groupId, actorUserId, buildWebNoticeText(kind, actorLabel, summary)),
    notifyKakaoMembers(groupId, actorUserId, buildKakaoNoticeText(kind, actorLabel, summary)),
  ]);
}

// 옵트인이 아닌 법인은 조회조차 하지 않고 조용히 빠진다 — 매 오더 생성마다 groups_tbl을
// 보긴 하지만(가벼운 단건 SELECT, 이미 인덱스가 있는 PK 조회), 켜지 않은 법인이 절대다수일
// 실사용 분포를 고려하면 이 조회 자체가 병목이 될 일은 없다.
async function isFeedEnabled(groupId) {
  if (!groupId) return false;
  try {
    const row = await db.get('SELECT share_activity_feed FROM groups_tbl WHERE id = ?', [groupId]);
    return !!(row && row.share_activity_feed);
  } catch (e) {
    // 마이그레이션 전이면 컬럼이 없다 — 기능 자체가 없는 셈치고 조용히 꺼진다.
    if (e && e.code === '42703') return false;
    console.error('법인 공유 피드 옵트인 조회 실패(꺼진 것으로 간주):', e.message);
    return false;
  }
}

// 기록 자체는 절대 호출부를 막지 않는다 — 오더 생성/취소/변경은 이 기능과 무관하게 항상
// 성공해야 한다. 실패는 로그만 남기고 삼킨다(카카오 알림 발송과 같은 원칙).
//
// 기록에 성공하면(=옵트인 법인) 곧바로 같은 법인의 다른 담당자들에게도 알린다("팀 접수 현황
// 안내") — 웹은 대화창에 실시간으로, 카카오는 선제 발송으로. 둘 다 fire-and-forget이라 이
// 함수의 응답 시간에는 영향이 없다.
async function recordActivity({ groupId, orderId, oid, kind, summary, actorUserId, actorLabel }) {
  if (!groupId || !summary) return;
  try {
    if (!(await isFeedEnabled(groupId))) return;
    await db.run(
      `INSERT INTO group_activity_feed (group_id, order_id, oid, kind, summary, actor_user_id, actor_label)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [groupId, orderId || null, oid || null, kind, summary, actorUserId || null, actorLabel || null]
    );
  } catch (e) {
    if (e && e.code === '42703') return; // 마이그레이션 전 — 조용히 무시
    console.error('법인 공유 피드 기록 실패(무시하고 진행):', e.message);
    return;
  }
  notifyGroupMembers({ groupId, kind, summary, actorUserId, actorLabel })
    .catch((e) => console.error('팀 접수 현황 알림 실패(무시하고 진행):', e.message));
}

// 조회 — 로그인 사용자가 속한 법인(group_id) 기준. actor_label이 없으면(오래된 행 등)
// actor_user_id로 이름을 붙인다.
async function listRecentActivity(groupId, limit) {
  if (!groupId) return [];
  try {
    return await db.all(
      `SELECT f.id, f.order_id, f.oid, f.kind, f.summary, f.created_at,
              COALESCE(f.actor_label, u.name, '알 수 없음') AS actor_label
       FROM group_activity_feed f
       LEFT JOIN users u ON u.id = f.actor_user_id
       WHERE f.group_id = ?
       ORDER BY f.id DESC
       LIMIT ?`,
      [groupId, Math.max(1, Math.min(Number(limit) || 30, 100))]
    );
  } catch (e) {
    if (e && e.code === '42703') return [];
    console.error('법인 공유 피드 조회 실패:', e.message);
    return [];
  }
}

const KIND_LABELS = { created: '접수', cancelled: '취소', updated: '변경' };

module.exports = { isFeedEnabled, recordActivity, listRecentActivity, KIND_LABELS };
