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
  }
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
