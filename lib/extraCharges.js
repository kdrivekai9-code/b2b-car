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
// feeExtra를 받으면 줄마다 정산구분을 박아둔다. 예전에는 컬럼만 있고 아무도 안 채워서,
// 청구한 뒤 요금설정을 바꾸면 이미 청구한 건의 월/개별 구분이 따라 바뀌었다 — 월 정산서로
// 청구한 건이 나중에 개별정산으로 바뀌면 건별 청구서에 또 나와 두 번 청구된다.
async function replaceForOrder(orderId, rows, userId, feeExtra) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM order_extra_charges WHERE order_id = $1', [orderId]);
    for (const r of rows) {
      await client.query(
        `INSERT INTO order_extra_charges (order_id, charge_type, amount, charged_on, billable, note, created_by, settle_mode)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [orderId, r.chargeType, r.amount, r.chargedOn, r.billable, r.note, userId || null,
         feeExtra === undefined ? null : fareSurcharge.settleModeOf(feeExtra, r.chargeType)]
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


// ── 접수 단계 부대비용 ───────────────────────────────────────────────────────
//
// 오더상세의 정산입력(위 parseRows)은 **끝난 뒤** 영수증을 보고 넣는 것이다. 이쪽은 접수할 때
// "주유 가득 채워주세요", "손세차로" 처럼 **미리 정하는** 것이라 다루는 값이 다르다.
//   - 금액을 아직 모를 수 있다('가득'). 그래서 amount 0인 줄을 버리지 않는다.
//   - 대신 무엇을 하기로 했는지를 option_code로 남긴다 — 비고에 글로 적으면 집계도 검색도 안 되고
//     기사에게 전달할 때마다 사람이 읽어야 한다.
//   - 정산구분을 줄에 박아둔다(settle_mode). 요금설정이 나중에 바뀌어도 이미 접수한 건의
//     청구 방식이 따라 바뀌면 안 된다.
//
// 도선료는 이 목록에 있지만 **줄을 만들지 않는다** — 금액이 orders.ferry_fare_amount 하나에서
// 오므로 줄까지 만들면 두 번 청구된다. 접수 화면에서만 같이 다루고 저장은 orders에 한다.
const INTAKE_EXTRA_ITEMS = [
  {
    chargeType: '주유비', label: '주유비',
    options: [{ value: 'full', label: '가득(full)' }, { value: 'amount', label: '금액입력' }],
    amountOption: 'amount',
  },
  {
    chargeType: '충전비', label: '충전비',
    options: [{ value: 'full', label: '가득(full)' }, { value: 'amount', label: '금액입력' }],
    amountOption: 'amount',
  },
  {
    chargeType: '세차비', label: '세차비',
    options: [{ value: 'auto_wash', label: '인근주유소 자동세차' }, { value: 'hand_wash', label: '손세차' }],
  },
  { chargeType: '주차요금', label: '주차비', options: [] },
  // 아래 셋은 줄(order_extra_charges)이 아니라 orders의 컬럼에 저장된다. 줄로도 만들면
  // 같은 돈이 두 군데서 집계돼 두 번 청구된다. 한 오더에 하나뿐이라 중복 추가도 막는다.
  { chargeType: '도선료', label: '도선료', options: [], single: true, ferry: true, orderColumn: 'ferry' },
  // 대기요금·취소요금은 부대비용이 아니라 운행요금이다(정산서에서 구간요금·할증과 한 묶음).
  // 그래도 여기 두는 이유는 사용자 지시다 — 관리자가 접수/수정 화면에서 금액을 직접 넣을 수
  // 있어야 한다. 정산구분은 두지 않는다: 실비가 아니라 운행요금이라 월/개별로 나눌 것이 없다.
  {
    chargeType: '대기요금', label: '대기요금', options: [], single: true,
    orderColumn: 'wait', noSettleMode: true,
    hint: '비워두면 요금설정의 오더구분별 대기요금으로 자동 계산됩니다.',
  },
  {
    chargeType: '취소요금', label: '취소요금', options: [], single: true,
    orderColumn: 'cancel', noSettleMode: true,
    hint: '비워두면 취소 시점에 요금설정으로 자동 계산됩니다.',
  },
];

const INTAKE_TYPES = INTAKE_EXTRA_ITEMS.map((it) => it.chargeType);
const FERRY_TYPE = '도선료';

function intakeItem(chargeType) {
  return INTAKE_EXTRA_ITEMS.find((it) => it.chargeType === chargeType) || null;
}

function normalizeOption(item, raw) {
  if (!item || !item.options.length) return null;
  const v = String(raw || '').trim();
  return item.options.some((o) => o.value === v) ? v : null;
}

function normalizeMode(raw) {
  const v = String(raw || '').trim();
  return fareSurcharge.EXTRA_COST_MODES.some((m) => m.value === v) ? v : null;
}

// 화면에 내려보낼 선택지. 정산구분 기본값은 요금설정에서 가져오되(사용자 지시) 화면에서
// 바꿀 수 있다 — 기본값을 서버에서 정해야 화면과 저장이 같은 규칙을 쓴다.
function intakeOptionsFor(feeExtra) {
  return {
    items: INTAKE_EXTRA_ITEMS.map((it) => ({
      chargeType: it.chargeType,
      label: it.label,
      options: it.options,
      amountOption: it.amountOption || null,
      single: !!it.single,
      ferry: !!it.ferry,
      orderColumn: it.orderColumn || null,
      // 정산구분 칸을 아예 안 그린다 — 고를 것이 없는데 칸만 있으면 무엇을 고르라는 건지 모른다.
      noSettleMode: !!it.noSettleMode,
      hint: it.hint || null,
      defaultMode: fareSurcharge.settleModeOf(feeExtra, it.chargeType),
    })),
    modes: fareSurcharge.EXTRA_COST_MODES,
  };
}

// 접수/수정 화면이 보낸 줄들을 거른다. 도선료는 줄이 아니라 orders에 저장하므로 따로 빼서 준다.
function parseIntakeRows(body, feeExtra, fallbackDate) {
  const arr = (v) => [].concat(v === undefined || v === null ? [] : v);
  const types = arr(body.intake_extra_type);
  const options = arr(body.intake_extra_option);
  const amounts = arr(body.intake_extra_amount);
  const modes = arr(body.intake_extra_mode);
  const ids = arr(body.intake_extra_id);

  const rows = [];
  // orders 컬럼에 저장되는 항목(도선료·대기요금·취소요금). 줄로 만들지 않는다.
  const orderFees = {};
  for (let i = 0; i < types.length; i++) {
    const item = intakeItem(String(types[i] || '').trim());
    if (!item) continue;
    const mode = normalizeMode(modes[i]) || fareSurcharge.settleModeOf(feeExtra, item.chargeType);
    const amount = normalizeAmount(amounts[i]);
    if (item.orderColumn) {
      // 한 오더에 하나뿐인 항목이라 여러 번 와도 마지막 것을 쓴다 — 화면이 막고 있으므로
      // 여기까지 오는 건 조작된 요청뿐이고, 그때 여러 줄을 만들면 두 번 청구된다.
      //
      // 금액이 0이어도 기록한다: 관리자가 줄을 만들어 0을 넣었다면 "이 건은 안 받는다"는 뜻이고,
      // 그걸 무시하면 자동 계산이 다시 붙어 관리자의 판단이 뒤집힌다.
      orderFees[item.orderColumn] = { amount, settleMode: mode };
      continue;
    }
    rows.push({
      id: /^\d+$/.test(String(ids[i] || '')) ? Number(ids[i]) : null,
      chargeType: item.chargeType,
      optionCode: normalizeOption(item, options[i]),
      amount,
      settleMode: mode,
      // 포함(청구불가)은 청구하지 않는다 — billable을 켜두면 정산서에 올라간다.
      billable: mode !== 'included',
      chargedOn: normalizeDate(fallbackDate),
    });
  }
  return {
    rows, orderFees,
    // 도선료는 이 이름으로 이미 쓰이고 있어 그대로 둔다(routes/orders.js).
    ferry: orderFees.ferry || null,
    knownIds: arr(body.intake_extra_known_id).map(Number).filter(Number.isFinite),
  };
}

// 접수 화면이 관리하는 줄만 반영한다.
//
// 왜 통째로 갈아끼우지 않나: 같은 테이블을 오더상세 정산입력(replaceForOrder)도 쓴다. 여기서
// DELETE ALL을 하면 관리자가 영수증 보고 넣은 톨게이트·특수구간 줄까지 같이 지워진다.
// 그래서 화면이 처음에 들고 있던 id(knownIds) 중 이번에 안 돌아온 것만 지운다.
async function saveIntakeRows(orderId, parsed, userId) {
  const client = await db.pool.connect();
  try {
    await client.query('BEGIN');
    const submitted = new Set(parsed.rows.map((r) => r.id).filter(Boolean));
    const removed = parsed.knownIds.filter((id) => !submitted.has(id));
    if (removed.length) {
      await client.query(
        `DELETE FROM order_extra_charges WHERE order_id = $1 AND id = ANY($2::bigint[])`,
        [orderId, removed]
      );
    }
    for (const r of parsed.rows) {
      if (r.id) {
        // 접수 화면이 아는 칸만 고친다 — 일자·비고는 정산입력에서 채웠을 수 있어 건드리지 않는다.
        await client.query(
          `UPDATE order_extra_charges
              SET charge_type = $1, amount = $2, option_code = $3, settle_mode = $4, billable = $5
            WHERE id = $6 AND order_id = $7`,
          [r.chargeType, r.amount, r.optionCode, r.settleMode, r.billable, r.id, orderId]
        );
      } else {
        await client.query(
          `INSERT INTO order_extra_charges
             (order_id, charge_type, amount, charged_on, billable, option_code, settle_mode, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [orderId, r.chargeType, r.amount, r.chargedOn, r.billable, r.optionCode, r.settleMode, userId || null]
        );
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// 수정 화면에 기존 줄을 되돌려준다. 접수 화면이 다루는 5개 항목만 — 톨게이트·특수구간은
// 관리자가 정산입력에서 넣는 것이라 여기 섞으면 지워버릴 위험이 생긴다.
async function loadIntakeRows(orderId) {
  const tableTypes = INTAKE_EXTRA_ITEMS.filter((it) => !it.orderColumn).map((it) => it.chargeType);
  const rows = await db.all(
    `SELECT id, charge_type, amount, option_code, settle_mode
       FROM order_extra_charges
      WHERE order_id = ? AND charge_type = ANY(?::text[])
      ORDER BY id`,
    [orderId, tableTypes]
  );
  const out = rows.map((r) => ({
    id: r.id, chargeType: r.charge_type, amount: r.amount || 0,
    optionCode: r.option_code || '', settleMode: r.settle_mode || '',
  }));

  // orders 컬럼에 있는 항목도 줄처럼 보여준다 — 화면에 안 나오면 관리자가 "왜 대기요금이
  // 붙었는지" 보지도 고치지도 못한다. id는 없다(테이블 줄이 아니다).
  const o = await db.get(
    'SELECT ferry_fare_amount, ferry_settle_mode, wait_fee_amount, cancel_fee_amount FROM orders WHERE id = ?',
    [orderId]
  ).catch(() => null);
  if (o) {
    const push = (chargeType, amount, settleMode) => {
      // null은 "아직 안 정함" — 줄을 만들면 관리자가 0을 확정한 것처럼 보인다.
      if (amount === null || amount === undefined) return;
      out.push({ id: null, chargeType, amount: Number(amount) || 0, optionCode: '', settleMode: settleMode || '' });
    };
    if (Number(o.ferry_fare_amount) > 0) push(FERRY_TYPE, o.ferry_fare_amount, o.ferry_settle_mode);
    push('대기요금', o.wait_fee_amount, '');
    push('취소요금', o.cancel_fee_amount, '');
  }
  return out;
}

// orders 컬럼에 저장되는 항목을 반영한다. 도선료 금액은 폼의 ferry_fare_amount로 이미
// 저장되므로 여기서는 정산구분만 건드린다.
async function saveOrderFeeFields(orderId, orderFees) {
  if (!orderFees) return;
  const sets = [];
  const args = [];
  if (orderFees.ferry) { sets.push('ferry_settle_mode = ?'); args.push(orderFees.ferry.settleMode); }
  if (orderFees.wait) {
    sets.push('wait_fee_amount = ?', 'wait_fee_note = ?');
    args.push(orderFees.wait.amount, orderFees.wait.amount > 0 ? '관리자 입력' : '관리자 확인 — 받지 않음');
  }
  if (orderFees.cancel) {
    sets.push('cancel_fee_amount = ?', 'cancel_fee_note = ?');
    args.push(orderFees.cancel.amount, orderFees.cancel.amount > 0 ? '관리자 입력' : '관리자 확인 — 받지 않음');
  }
  if (!sets.length) return;
  args.push(orderId);
  await db.run(`UPDATE orders SET ${sets.join(', ')} WHERE id = ?`, args);
}

module.exports = {
  EXTRA_CHARGE_TYPES, billableTypes, billableTypesForOrder, normalizeType, normalizeDate,
  normalizeAmount, parseRows, replaceForOrder, loadForOrder, summarize,
  INTAKE_EXTRA_ITEMS, INTAKE_TYPES, FERRY_TYPE, intakeItem, intakeOptionsFor,
  parseIntakeRows, saveIntakeRows, loadIntakeRows, saveOrderFeeFields,
};
