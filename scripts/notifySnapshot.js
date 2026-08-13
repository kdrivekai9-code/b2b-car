// 통보 검사 스크립트가 건드리는 프로덕션 상태의 스냅샷·복원.
//
// 이 DB는 프로덕션과 같다. 통보 검사는 두 가지를 손대는데, 둘 다 되돌리지 않으면 실제 운영이
// 망가진다:
//
//   1) branch_customer_notifications — 지사가 설정한 문구·지연·사진첨부.
//      복원할 때 attach_photos를 빼먹으면 지사가 켜둔 사진첨부가 검사를 돌릴 때마다 조용히 꺼진다.
//   2) kakao_notification_cursor — 어디까지 전이를 훑었는지. 검사는 "과거 이력을 훑지 않게"
//      커서를 지금 지점으로 밀어놓는데, 복원하지 않으면 커서 뒤에 남아 있던 실제 미처리 전이가
//      영구히 버려진다. 실제로 그렇게 잃었다: 2026-08-13, OID1237의 18:36 배차 전이가 통보 크론이
//      401에서 풀리기 전에 이 검사에 삼켜져 고객이 배차 통보를 못 받았다.
//
// 두 스크립트(check-kakao-order-notify-db, check-order-notify-web-db)가 같은 규칙을 쓰도록
// 여기 한 번만 둔다 — 각자 구현하면 한쪽만 고쳐지고 갈라진다.
const db = require('../db');

const UNDEFINED_COLUMN = '42703';

async function snapshotSettings(branchId) {
  return db.all('SELECT * FROM branch_customer_notifications WHERE branch_id = ?', [branchId])
    .catch(() => []);
}

async function restoreSetting(row) {
  const base = [row.branch_id, row.event_type, row.enabled, row.delay_minutes, row.message_template];
  // 컬럼이 없는 DB(마이그레이션 전)에서는 attach_photos를 빼고 다시 넣는다.
  if (row.attach_photos !== undefined) {
    try {
      await db.run(
        `INSERT INTO branch_customer_notifications
           (branch_id, event_type, enabled, delay_minutes, message_template, attach_photos)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [...base, row.attach_photos]
      );
      return;
    } catch (e) {
      if (!e || e.code !== UNDEFINED_COLUMN) {
        console.error('지사 통보 설정 복원 실패:', e.message);
        return;
      }
    }
  }
  await db.run(
    `INSERT INTO branch_customer_notifications (branch_id, event_type, enabled, delay_minutes, message_template)
     VALUES (?, ?, ?, ?, ?)`,
    base
  ).catch((e) => console.error('지사 통보 설정 복원 실패:', e.message));
}

async function restoreSettings(branchId, rows) {
  if (!branchId) return;
  await db.run('DELETE FROM branch_customer_notifications WHERE branch_id = ?', [branchId]).catch(() => {});
  for (const row of rows || []) await restoreSetting(row);
}

// 커서를 떠두고 "지금 지점"으로 민다. 반환값을 finally에서 restoreCursor에 그대로 넘긴다.
async function advanceCursorToNow() {
  const saved = await db.get('SELECT last_history_id FROM kakao_notification_cursor WHERE id = 1')
    .catch(() => null);
  const maxHistory = await db.get('SELECT COALESCE(MAX(id), 0) AS id FROM order_status_history');
  await db.run('UPDATE kakao_notification_cursor SET last_history_id = ? WHERE id = 1', [maxHistory.id]);
  return saved;
}

// 반드시 검사용 이력 행을 지운 뒤에 부른다 — 먼저 되돌리면 크론이 검사용 전이를 실제 통보로
// 잡을 수 있다. 되돌린 뒤 남는 실제 미처리 전이는 크론이 이어서 처리하며, 그사이 상황이 지난
// 건은 발송 직전 상태 재확인(EXPECTED_STATUS_AT_SEND)이 skipped로 막는다.
async function restoreCursor(saved) {
  if (!saved) return;
  await db.run(
    'UPDATE kakao_notification_cursor SET last_history_id = ? WHERE id = 1',
    [saved.last_history_id]
  ).catch((e) => console.error('통보 커서 복원 실패:', e.message));
  console.log(`커서 복원: last_history_id=${saved.last_history_id}`);
}

module.exports = {
  snapshotSettings,
  restoreSetting,
  restoreSettings,
  advanceCursorToNow,
  restoreCursor,
};
