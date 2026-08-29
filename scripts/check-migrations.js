// 마이그레이션이 실제 DB에 적용됐는지 대조한다.
//
// 왜 필요한가: 이 저장소는 마이그레이션을 사람이 직접 실행한다(자동 적용이 없다). 그래서
// "코드는 올라갔는데 컬럼이 없는" 구간이 생기고, 그 상태에서는 기능이 조용히 건너뛰어진다 —
// 화면은 멀쩡해 보이는데 값만 저장되지 않는다. 파일 이름만 봐서는 무엇이 남았는지 알 수 없다.
//
// 파일에서 CREATE TABLE / ADD COLUMN 대상을 뽑아 information_schema와 맞춰본다.
// 완벽한 판정은 아니다(인덱스·제약·UPDATE는 안 본다) — 남은 것을 찾는 용도다.
require('dotenv').config();

const fs = require('fs');
const path = require('path');
const db = require('../db');

const DIR = path.join(__dirname, '..', 'supabase', 'migrations');

const TABLE_RE = /create\s+table\s+(?:if\s+not\s+exists\s+)?["']?(\w+)["']?/gi;
const COLUMN_RE = /alter\s+table\s+["']?(\w+)["']?\s+add\s+column\s+(?:if\s+not\s+exists\s+)?["']?(\w+)["']?/gi;
// 나중에 이름이 바뀐 컬럼은 원래 이름으로 찾으면 당연히 없다 — 그걸 "미실행"으로 세면
// 이미 적용된 마이그레이션을 다시 돌리라고 하게 된다(실측: callmaner_app_code →
// callmaner_provider_id가 그렇게 잡혔다). 뒤에 오는 RENAME을 미리 모아 제외한다.
const RENAME_RE = /alter\s+table\s+["']?(\w+)["']?\s+rename\s+column\s+["']?(\w+)["']?\s+to\s+["']?(\w+)["']?/gi;
// 지워진 컬럼도 마찬가지다.
const DROP_RE = /alter\s+table\s+["']?(\w+)["']?\s+drop\s+column\s+(?:if\s+exists\s+)?["']?(\w+)["']?/gi;

function targetsOf(sql) {
  const tables = new Set();
  const columns = [];
  let m;
  while ((m = TABLE_RE.exec(sql))) tables.add(m[1].toLowerCase());
  while ((m = COLUMN_RE.exec(sql))) columns.push([m[1].toLowerCase(), m[2].toLowerCase()]);
  return { tables: [...tables], columns };
}

(async () => {
  const [tableRows, columnRows] = await Promise.all([
    db.all("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"),
    db.all("SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'"),
  ]);
  const haveTable = new Set(tableRows.map((r) => r.table_name.toLowerCase()));
  const haveColumn = new Set(columnRows.map((r) => `${r.table_name.toLowerCase()}.${r.column_name.toLowerCase()}`));

  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();

  // 한 번 훑어 "나중에 이름이 바뀌거나 지워진 컬럼"을 모은다.
  const renamedOrDropped = new Set();
  files.forEach((f) => {
    const sql = fs.readFileSync(path.join(DIR, f), 'utf8');
    let m;
    RENAME_RE.lastIndex = 0;
    while ((m = RENAME_RE.exec(sql))) renamedOrDropped.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
    DROP_RE.lastIndex = 0;
    while ((m = DROP_RE.exec(sql))) renamedOrDropped.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  });
  const pending = [];
  let checked = 0;

  for (const file of files) {
    const sql = fs.readFileSync(path.join(DIR, file), 'utf8');
    const { tables, columns } = targetsOf(sql);
    // 대상을 못 뽑은 파일(뷰·함수·데이터 이관 등)은 판정하지 않는다 — 모르는 것을
    // "적용됨"으로 세면 이 도구를 믿을 수 없게 된다.
    if (!tables.length && !columns.length) continue;
    checked += 1;

    const missing = [];
    tables.forEach((t) => { if (!haveTable.has(t)) missing.push(`표 ${t}`); });
    columns.forEach(([t, c]) => {
      // 표 자체가 없으면 컬럼은 당연히 없다 — 같은 사실을 두 번 적지 않는다.
      if (!haveTable.has(t)) return;
      if (renamedOrDropped.has(`${t}.${c}`)) return; // 뒤 마이그레이션이 이름을 바꿨거나 지웠다
      if (!haveColumn.has(`${t}.${c}`)) missing.push(`${t}.${c}`);
    });

    if (missing.length) pending.push({ file, missing });
  }

  console.log(`마이그레이션 ${files.length}개 중 ${checked}개를 대조했습니다.\n`);
  if (!pending.length) {
    console.log('✔ 실행해야 할 마이그레이션이 없습니다.');
    process.exit(0);
  }
  console.log(`✘ 실행이 필요한 마이그레이션 ${pending.length}개:\n`);
  pending.forEach((p) => {
    console.log(`  ${p.file}`);
    console.log(`     빠진 것: ${p.missing.slice(0, 8).join(', ')}${p.missing.length > 8 ? ` 외 ${p.missing.length - 8}개` : ''}`);
  });
  console.log('\n실행 순서는 파일명(시각) 순서 그대로입니다.');
  process.exit(0);
})().catch((e) => { console.error('실패:', e.message); process.exit(1); });
