// seed.js - 데모 계정/샘플 데이터 시드 스크립트 (필요할 때만 수동 실행: npm run seed)
require('dotenv').config();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { pool, get, run } = require('./db');

function dateStr(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  const existing = await get('SELECT COUNT(*) AS c FROM users');
  if (Number(existing.c) > 0) {
    console.log('이미 데이터가 존재합니다. 시드를 건너뜁니다.');
    return;
  }

  const b1 = await run(
    `INSERT INTO branches (name, code, main_phone, address, contact_name, status)
     VALUES (?, ?, ?, ?, ?, 'active') RETURNING id`,
    ['서울지사', 'B001', '1566-0000', '서울특별시 강남구 테헤란로 1', '김지사']
  );
  const b2 = await run(
    `INSERT INTO branches (name, code, main_phone, address, contact_name, status)
     VALUES (?, ?, ?, ?, ?, 'active') RETURNING id`,
    ['경기지사', 'B002', '1566-0001', '경기도 성남시 분당구 판교로 1', '이지사']
  );

  const g1 = await run(
    `INSERT INTO groups_tbl (branch_id, parent_group_id, name, main_phone) VALUES (?, NULL, ?, ?) RETURNING id`,
    [b1.lastInsertRowid, '서울모터스', '1566-1004']
  );
  const g2 = await run(
    `INSERT INTO groups_tbl (branch_id, parent_group_id, name, main_phone) VALUES (?, NULL, ?, ?) RETURNING id`,
    [b2.lastInsertRowid, '판교오토', '1566-2004']
  );

  for (const n of ['현금', '후불', '카드', '계좌이체', '착불']) {
    await run(`INSERT INTO payment_methods (name, is_active) VALUES (?, 1)`, [n]);
  }

  // 시드 계정 비밀번호는 소스에 두지 않는다.
  //
  // 예전에는 여기에 고정 문자열을 박아뒀는데, 그렇게 만들어진 계정이 그대로 운영 DB에 살아
  // 있었고 같은 값이 로그인 화면의 "데모 계정" 안내로도 노출돼 있었다(2026-08-26에 걷어냄).
  // 저장소에 있는 값은 비밀번호가 아니다.
  //
  // 환경변수로 주면 그 값을 쓰고, 없으면 실행할 때마다 임의로 만들어 화면에 한 번만 출력한다 —
  // `npm run seed`가 환경변수 없이도 그대로 돌아가되, 값이 저장소에 남지는 않는다.
  const generated = [];
  const seedPassword = (envKey, loginId) => {
    const fromEnv = String(process.env[envKey] || '').trim();
    if (fromEnv) return fromEnv;
    const made = 'seed-' + crypto.randomBytes(9).toString('base64url');
    generated.push({ loginId, envKey, password: made });
    return made;
  };
  const hash = (pw) => bcrypt.hashSync(pw, 10);

  await run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, grade, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ['admin', hash(seedPassword('SEED_ADMIN_PASSWORD', 'admin')), '시스템 관리자', '010-0000-0000', 'admin', null, null, null]
  );
  await run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, grade, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ['seoul_manager', hash(seedPassword('SEED_BRANCH_MANAGER_PASSWORD', 'seoul_manager')), '김지사', '010-1111-2222', 'branch_manager', b1.lastInsertRowid, null, null]
  );
  const clientRes = await run(
    `INSERT INTO users (login_id, password_hash, name, phone, role, branch_id, group_id, grade, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active') RETURNING id`,
    ['seoulmotors', hash(seedPassword('SEED_CLIENT_PASSWORD', 'seoulmotors')), '서울모터스 담당자', '010-3333-4444', 'client', b1.lastInsertRowid, g1.lastInsertRowid, 'leader']
  );

  const pmCash = await get(`SELECT id FROM payment_methods WHERE name = ?`, ['현금']);

  const o1 = await run(
    `INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_contact,
      destination_address, destination_contact, vehicle_number,
      reserved_date, reserved_time, payment_method_id, fare_amount, status, memo_customer, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      'OID1001', b1.lastInsertRowid, g1.lastInsertRowid,
      '서울 강남구 테헤란로 152', '010-3333-4444',
      '경기 성남시 분당구 판교역로 235', '010-5555-6666', '12가3456',
      dateStr(0), '14:00', pmCash.id, 45000, '대기', '조심히 부탁드립니다', clientRes.lastInsertRowid,
    ]
  );
  await run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, '오더등록', '최초 등록')`,
    [o1.lastInsertRowid, clientRes.lastInsertRowid]
  );
  await run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, '오더등록', '대기', '접수 대기 전환')`,
    [o1.lastInsertRowid, clientRes.lastInsertRowid]
  );

  const o2 = await run(
    `INSERT INTO orders (oid, branch_id, requester_group_id, origin_address, origin_contact,
      destination_address, destination_contact, vehicle_number,
      reserved_date, reserved_time, payment_method_id, fare_amount, status, memo_customer, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
    [
      'OID1002', b2.lastInsertRowid, g2.lastInsertRowid,
      '경기 성남시 분당구 판교역로 231', '010-7777-8888',
      '경기 화성시 동탄대로 537', '010-9999-0000', null,
      dateStr(1), '10:30', pmCash.id, 62000, '완료', null, clientRes.lastInsertRowid,
    ]
  );
  await run(
    `INSERT INTO order_waypoints (order_id, seq, address) VALUES (?, 1, ?)`,
    [o2.lastInsertRowid, '경기 용인시 수지구 포은대로 435']
  );
  await run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, NULL, '오더등록', '최초 등록')`,
    [o2.lastInsertRowid, clientRes.lastInsertRowid]
  );
  await run(
    `INSERT INTO order_status_history (order_id, actor_user_id, old_status, new_status, note) VALUES (?, ?, '오더등록', '완료', '배차/이동 완료')`,
    [o2.lastInsertRowid, clientRes.lastInsertRowid]
  );

  console.log('시드 완료: 데모 계정 3개(admin/seoul_manager/seoulmotors), 오더 2건 생성됨.');
  if (generated.length) {
    // 임의로 만든 값은 여기서만 볼 수 있다 — 어디에도 저장하지 않는다. 다시 보려면 재설정해야 한다.
    console.log('\n환경변수를 주지 않아 임의 비밀번호로 만들었습니다. 지금 한 번만 표시됩니다:');
    generated.forEach((g) => console.log(`  ${g.loginId.padEnd(16)} ${g.password}   (고정하려면 ${g.envKey})`));
    console.log('');
  }
}

seed()
  .catch((err) => {
    console.error('시드 실패:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
