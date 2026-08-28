// 기타 정산 내역(통행료 · 주차비 · 주유비 · 세차비) — 항목 정의와 저장 규칙.
//
// 오더상세(입력)와 법인 정산내역(집계)이 함께 쓴다. 항목 이름을 양쪽에 각각 적어두면
// 한쪽에만 항목이 늘어나 정산서에서 조용히 빠지는 일이 생긴다.
const db = require('../db');
const fareSurcharge = require('./fareSurcharge');

// 항목 이름은 요금설정의 부대비용 항목(lib/fareSurcharge.js)에서 그대로 가져온다.
// 두 곳에 각각 적어두면 요금설정에서 "제외(실비 정산)"로 켠 항목이 정산 화면 선택지에는
// 없는 상태가 생긴다 — 설정은 했는데 청구할 방법이 없는 셈이다.
const EXTRA_CHARGE_TYPES = fareSurcharge.EXTRA_COST_ITEMS.map((it) => it.chargeType);

// 이 오더(법인/지사)에서 실제로 청구할 수 있는 항목만. 요금설정에서 "포함"으로 둔 항목은
// 이미 기본요금에 들어 있어 정산서에 또 올리면 이중 청구가 된다.
function billableTypes(extra) {
  return fareSurcharge.billableChargeTypes(extra);
}

function normalizeType(raw) {
  const v = String(raw || '').trim();
  return EXTRA_CHARGE_TYPES.includes(v) ? v : null;
}

// 'YYYY-MM-DD'만 받는다. 형식이 어긋나면 null — 정산 목록의 일자 칸이 비는 편이,
// 엉뚱한 날짜가 찍혀 그 달 정산서에 잘못 들어가는 것보다 낫다.
function normalizeDate(raw) {
  const v = String(raw || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null;
}

function normalizeAmount(raw) {
  const n = Math.round(Number(raw));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// 화면에서 올라온 행들을 저장 가능한 형태로 거른다.
// 항목이 없거나 금액이 0인 줄은 버린다 — 빈 줄을 저장하면 정산서에 0원짜리가 늘어선다.
function parseRows(body, fallbackDate) {
  const arr = (v) => [].concat(v || []);
  const types = arr(body.extra_charge_type);
  const amounts = arr(body.extra_charge_amount);
  const dates = arr(body.extra_charge_date);
  const billables = arr(body.extra_charge_billable);
  const notes = arr(body.extra_charge_note);

  const rows = [];
  for (let i = 0; i < types.length; i++) {
    const chargeType = normalizeType(types[i]);
    const amount = normalizeAmount(amounts[i]);
    if (!chargeType || !amount) continue;
    rows.push({
      chargeType,
      amount,
      // 일자를 비워두면 오더 예약일로 본다 — 대부분 그날 쓴 돈이고, 매번 같은 날짜를
      // 손으로 넣게 하면 안 넣는다.
      chargedOn: normalizeDate(dates[i]) || normalizeDate(fallbackDate),
      // 체크박스는 체크됐을 때만 올라온다. 행 인덱스를 값으로 실어 보내 어느 줄인지 가린다
      // (같은 이름의 체크박스 여러 개는 체크된 것만 순서 없이 오기 때문).
      billable: billables.map(String).includes(String(i)),
      note: String(notes[i] || '').trim() || null,
    });
  }
  return rows;
}

// 통째로 갈아끼운다. 행 단위 수정/삭제를 따로 만들지 않고 화면이 보낸 상태를 그대로 반영한다
// — VOC 저장(routes/orders.js POST /:id/voc)과 같은 방식이라 사용자가 다르게 배울 것이 없다.
async function replaceForOrder(orderId, rows, userId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM order_extra_charges WHERE order_id = $1', [orderId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable, note, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [orderId, r.chargeType, r.amount, r.chargedOn, r.billable, r.note, userId || null]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    // 지우고 넣는 사이에 실패하면 그 오더의 실비가 통째로 사라진다 — 청구할 돈이라 되돌려야 한다.
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

async function loadForOrder(orderId) {
  return db.all(
    `SELECT * FROM order_extra_charges WHERE order_id = ? ORDER BY charged_on NULLS LAST, id`,
    [orderId]
  );
}

// 항목별 합계 + 총합. 정산 화면의 합계표와 통계가 같은 계산을 쓰도록 한 곳에 둔다.
function summarize(items) {
  const byType = {};
  EXTRA_CHARGE_TYPES.forEach((t) => { byType[t] = { count: 0, amount: 0 }; });
  let total = 0;
  for (const it of items) {
    const amount = Number(it.amount) || 0;
    total += amount;
    if (!byType[it.charge_type]) byType[it.charge_type] = { count: 0, amount: 0 };
    byType[it.charge_type].count += 1;
    byType[it.charge_type].amount += amount;
  }
  return { count: items.length, total, byType };
}


// 이 오더에 적용되는 요금설정(법인 우선, 없으면 지사)을 찾아 청구 가능한 항목만 돌려준다.
// 오더상세의 정산 입력이 이 목록으로 선택지를 만든다 — 요금설정에서 "포함"으로 둔 항목이
// 선택지에 남아 있으면 기본요금에 이미 든 비용을 한 번 더 청구하게 된다.
async function billableTypesForOrder(order) {
  if (!order) return EXTRA_CHARGE_TYPES;
  try {
    if (order.requester_group_id) {
      const g = await db.get('SELECT * FROM group_fare_extra_settings WHERE group_id = ?', [order.requester_group_id]);
      if (g && g.fare_table_enabled) return billableTypes(g);
    }
    const b = await db.get('SELECT * FROM fare_extra_settings WHERE branch_id = ?', [order.branch_id]);
    return billableTypes(b || {});
  } catch (e) {
    // 마이그레이션 전이면 컬럼이 없다 — 항목을 좁히지 못할 뿐이니 전체를 준다.
    console.error('청구 가능 항목 조회 실패:', e.message);
    return EXTRA_CHARGE_TYPES;
  }
}

module.exports = { EXTRA_CHARGE_TYPES, billableTypes, billableTypesForOrder, normalizeType, normalizeDate, normalizeAmount, parseRows, replaceForOrder, loadForOrder, summarize };
