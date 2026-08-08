// 운영시간 안내 문구를 실제 데이터로 만든다 — lib/fareQuote.js와 같은 생각이다.
//
// 지식베이스에 "고객센터 운영시간은 09:00~18:00입니다" 같은 문구를 넣어두면 지사가 시간을 바꿔도
// 조용히 낡는다. 운영시간은 이미 operating_hours / operating_hour_exceptions에 지사별로 들어
// 있고 오더 등록이 그 값으로 접수를 막고 있으므로(lib/branchPolicy.js checkOperatingHours),
// 안내도 같은 원본을 읽어야 답이 어긋나지 않는다.
//
// 지사를 특정할 수 없으면(카카오 익명 고객 등) 활성 지사가 하나뿐일 때만 답한다 — 여러 지사가
// 서로 다른 시간을 쓰는데 아무 지사 시간이나 알려주면 틀린 안내가 된다.
const db = require('../db');
const { kstNow, toDateStr } = require('./period');

const DAY_LABEL = { weekday: '평일', weekend: '주말·공휴일' };

function normalizeTime(raw) {
  const s = String(raw || '').trim();
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`;
}

// "00:00~23:59"는 사실상 24시간 운영이다 — 숫자를 그대로 읽어주면 고객이 오히려 헷갈린다.
function describeRange(openTime, closeTime) {
  const open = normalizeTime(openTime);
  const close = normalizeTime(closeTime);
  if (!open || !close) return null;
  if (open === '00:00' && (close === '23:59' || close === '24:00')) return '24시간';
  return `${open}~${close}`;
}

// 어느 지사 기준으로 안내할지 정한다.
//   1) 호출부가 지사를 알면(등록 거래처 매칭 등) 그 지사
//   2) 모르면 운영시간이 실제로 설정된 지사 — 설정 안 한 지사는 제한이 없어 안내할 내용도 없다
// 운영시간을 설정한 지사가 여럿이면 서로 시간이 다를 수 있어 안내하지 않는다(상담원에게 넘어간다).
// 활성 지사 수로 판단하지 않는 이유: 지사가 둘 이상이어도 운영시간을 쓰는 곳은 보통 한 곳이라,
// 그 기준으로는 답할 수 있는 질문에도 침묵하게 된다(실측에서 그렇게 막혔다).
async function resolveBranch(branchId) {
  if (branchId) {
    const row = await db.get("SELECT id, name FROM branches WHERE id = ? AND status = 'active'", [branchId]).catch(() => null);
    if (row) return row;
  }
  const configured = await db.all(
    `SELECT b.id, b.name FROM branches b
     WHERE b.status = 'active' AND EXISTS (SELECT 1 FROM operating_hours oh WHERE oh.branch_id = b.id)
     ORDER BY b.id`
  ).catch(() => []);
  return configured.length === 1 ? configured[0] : null;
}

// 운영시간 안내 — 답할 수 없으면 null을 돌려주고 호출부가 기존 경로(지식검색/상담원 연결)로 넘긴다.
async function describeOperatingHours({ branchId } = {}) {
  const branch = await resolveBranch(branchId);
  if (!branch) return null;

  const rows = await db.all(
    'SELECT day_type, open_time, close_time, is_closed FROM operating_hours WHERE branch_id = ?',
    [branch.id]
  ).catch(() => []);
  if (!rows.length) return null; // 미설정 지사는 제한이 없어 안내할 내용도 없다

  const byType = {};
  rows.forEach((r) => { byType[r.day_type] = r; });

  const lines = [];
  ['weekday', 'weekend'].forEach((type) => {
    const row = byType[type];
    if (!row) return;
    const label = DAY_LABEL[type];
    if (row.is_closed) {
      lines.push(`· ${label}: 휴무`);
      return;
    }
    const range = describeRange(row.open_time, row.close_time);
    // 시간이 비어 있으면 제한을 두지 않은 것이다(checkOperatingHours도 통과시킨다).
    lines.push(`· ${label}: ${range || '상시 운영'}`);
  });
  if (!lines.length) return null;

  // 오늘이 임시 휴무/변경일이면 그게 실제 답이다 — 정기 운영시간만 알려주면 틀린 안내가 된다.
  const today = toDateStr(kstNow());
  const exception = await db.get(
    'SELECT date, is_closed, open_time, close_time, note FROM operating_hour_exceptions WHERE branch_id = ? AND date = ?',
    [branch.id, today]
  ).catch(() => null);

  const head = '고객센터 운영시간을 안내드립니다.';
  const body = lines.join('\n');
  const parts = [head, body];

  if (exception) {
    if (exception.is_closed) {
      parts.push(`※ 오늘(${today})은 임시 휴무입니다${exception.note ? ` — ${exception.note}` : ''}.`);
    } else {
      const range = describeRange(exception.open_time, exception.close_time);
      if (range) parts.push(`※ 오늘(${today})은 ${range}로 변경 운영합니다${exception.note ? ` — ${exception.note}` : ''}.`);
    }
  }

  return {
    branchId: branch.id,
    branchName: branch.name,
    hasException: !!exception,
    text: parts.join('\n'),
  };
}

module.exports = { describeOperatingHours, describeRange };
