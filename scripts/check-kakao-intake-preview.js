// 실사용 접수 폼을 넣었을 때 고객에게 나갈 확인 메시지를 그대로 찍어본다.
// DB에 쓰지 않고 콜마너도 호출하지 않는 순수 미리보기다 — 자동 등록을 켜기 전에
// "봇이 뭐라고 답하는지"를 사람이 먼저 읽어보라고 만든 스크립트.
//
//   node scripts/check-kakao-intake-preview.js <msgs.json> [건수=6]
const fs = require('fs');
const { parseKakaoIntake, buildMissingQuestion } = require('../lib/kakaoIntakeParser');
const { resolveReservation, buildConfirmationMessage, buildOrderMemo } = require('../lib/kakaoIntakeService');

const inputPath = process.argv[2];
const want = Number(process.argv[3]) || 6;
if (!inputPath) {
  console.error('사용법: node scripts/check-kakao-intake-preview.js <msgs.json> [건수]');
  process.exit(1);
}

const messages = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const forms = messages.filter((m) => m.role === '고객' && /(\[\s*출발지\s*\]|＊\s*출발지)/.test(m.text));
const step = Math.max(1, Math.floor(forms.length / want));

let shown = 0;
for (let i = 0; i < forms.length && shown < want; i += step) {
  const text = forms[i].text;
  const parsed = parseKakaoIntake(text);
  if (!parsed.matched) continue;
  shown += 1;

  console.log('━'.repeat(72));
  console.log('■ 고객이 보낸 원문');
  console.log(text.split('\n').filter(Boolean).map((l) => '   ' + l).join('\n'));
  console.log('\n■ 봇이 보낼 답');
  if (!parsed.complete) {
    console.log('   ' + buildMissingQuestion(parsed.missing) + `   ← 되묻기 (부족: ${parsed.missing.join(', ')})`);
    continue;
  }
  const reservation = resolveReservation(parsed.when);
  // 오더가 실제로 만들어졌다고 가정한 미리보기 — oid는 표시용 더미다.
  const created = parsed.vehicles.map((v, idx) => ({
    oid: 'OID' + (1000 + idx + 1),
    vehicle: { vehicleNumber: v.plate, vehicleType: v.type },
  }));
  console.log(buildConfirmationMessage(parsed, created, reservation).split('\n').map((l) => '   ' + l).join('\n'));
  console.log('\n■ 오더에 저장될 고객 메모');
  console.log('   ' + (buildOrderMemo(parsed) || '(없음)'));
}
console.log('━'.repeat(72));
