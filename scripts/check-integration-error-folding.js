// 같은 연동 오류가 반복되면 한 줄로 접히고 횟수만 오르는지 본다.
//
// 왜 필요한가(사용자 지시 2026-09-21): 바깥(콜마너)이 고장 나 매분 같은 오류 3건이 그대로
// 쌓였다 — 19분에 57건. 이 상태가 몇 시간 이어지면 연동 오류 화면이 같은 줄로 가득 차고,
// 그 사이에 난 **진짜 다른 오류가 그 밑에 묻힌다.** 9월 초에도 같은 일이 있었다
// (AUTO_SEND_NOTICE is not defined가 10분에 10건).
//
// 접는 것만으로는 반쪽이다. 화면이 횟수를 보여주지 않으면 57번 난 장애가 "한 번"으로 읽혀
// 규모를 놓친다 — 그래서 화면 두 벌(EJS·Next)까지 함께 본다.
//
// 파일만 읽는다 — DB도 외부도 안 부르므로 CI에서 돌 수 있다.
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

let failed = 0;
function check(name, ok, detail) {
  if (ok) { console.log(`  OK   ${name}`); return; }
  failed += 1;
  console.log(`  FAIL ${name}${detail ? `\n       ${detail}` : ''}`);
}

const log = read('lib/integrationLog.js');
const route = read('routes/integrationErrors.js');
const ejs = read('views/integration_errors/index.ejs');
const next = read('src/app/integration-errors/page.js');

console.log('[같은 오류를 접는다]');
check('접기 함수가 있다', /async function foldIntoRecent\(/.test(log));
check('횟수를 올린다', /SET repeat_count = repeat_count \+ 1/.test(log));
// created_at은 **처음** 난 시각으로 남아야 한다 — 둘이 있어야 "언제부터 언제까지"를 읽는다.
check('마지막 시각만 갱신한다', /last_seen_at = to_char/.test(log) && !/SET[^;]*created_at =/.test(log));
check('접었으면 새 줄을 넣지 않는다', /if \(folded\) return;/.test(log));

console.log('\n[무엇을 같은 오류로 보나]');
// "무엇이 잘못됐는가"가 같은 것만 접는다. 대상이 다르면 다른 사건이다.
for (const col of ['source = \\?', 'operation = \\?', 'message = \\?']) {
  check(`${col.replace(' = \\?', '')}가 기준이다`, new RegExp(col).test(log));
}
check('대상(ref)도 기준이다',
  /ref_type IS NOT DISTINCT FROM \?/.test(log) && /ref_id IS NOT DISTINCT FROM \?/.test(log),
  'NULL끼리도 같게 봐야 한다 — =로 비교하면 대상 없는 오류가 영영 안 접힌다');
// error_code는 일부러 뺀다: 같은 실패의 코드가 비었다 채워졌다 하면 한 사건이 두 줄로 갈라진다.
check('error_code는 기준이 아니다', !/error_code = \?/.test(log));

console.log('\n[무한히 접지는 않는다]');
// 창이 없으면 "어제 한 번, 오늘 또"가 한 줄이 되어 언제 다시 시작됐는지 알 수 없다.
check('창이 정해져 있다', /const FOLD_WINDOW_MINUTES = \d+;/.test(log));
const win = Number((log.match(/const FOLD_WINDOW_MINUTES = (\d+);/) || [])[1]);
check('창이 하루를 넘지 않는다', win > 0 && win <= 1440, `${win}분`);
check('조회가 그 창을 쓴다', /interval '\$\{FOLD_WINDOW_MINUTES\} minutes'/.test(log));

console.log('\n[마이그레이션 전에도 기록이 빠지지 않는다]');
// 마이그레이션은 사람이 직접 돌린다(수동 정책). 컬럼이 없으면 42703이 나는데, 그때
// 기록 자체가 사라지면 접기를 넣은 대가로 오류를 잃는 셈이 된다.
check('42703이면 접지 않고 넘어간다', /e\.code === '42703'/.test(log));
check('그 뒤에도 새 줄을 넣는다',
  /if \(folded\) return;[\s\S]{0,200}?await db\.run\(/.test(log));
check('로그 남기다 본 작업을 막지 않는다', /catch \(e\) \{[\s\S]{0,200}?연동오류 로그 저장 실패/.test(log));

console.log('\n[화면이 횟수를 보여준다]');
// 접기만 하고 횟수를 안 보여주면 57번 난 장애가 "한 번"으로 읽힌다.
check('목록 질의가 횟수를 가져온다', /repeat_count,\s*\n?\s*coalesce\(last_seen_at, created_at\)/.test(route));
// 요약은 줄 수가 아니라 발생 횟수를 세야 한다.
check('요약이 발생 횟수를 센다', /sum\(repeat_count\) AS cnt/.test(route));
// 계속 나고 있는 오류가 위로 와야 한다.
check('마지막 시각으로 정렬한다', /ORDER BY coalesce\(last_seen_at, created_at\) DESC/.test(route));

//
// **표의 머리와 셀을 각각 본다.** 낱말만 찾으면 이 파일이나 주석에 적힌 "횟수"에 걸려,
// 정작 표에서 칸을 지워도 그대로 통과한다(되돌림 시험에서 샜다).
for (const [label, src, headRe, cellRe] of [
  ['EJS', ejs, /<th [^>]*>횟수<\/th>/, /<%= r\.repeat_count %>/],
  ['Next', next, /<th style=\{\{ width: 60 \}\}>횟수<\/th>/, /\{r\.repeat_count\}/],
]) {
  check(`${label}: 표에 횟수 칸이 있다`, headRe.test(src));
  check(`${label}: 그 칸에 횟수를 그린다`, cellRe.test(src));
  check(`${label}: 반복일 때만 강조한다`, /repeat_count \|\| 1\) > 1/.test(src));
  check(`${label}: 마지막 시각을 함께 보여준다`, /last_seen_at/.test(src));
}

console.log(failed ? `\n${failed}건 실패` : '\n모두 통과');
process.exit(failed ? 1 : 0);
