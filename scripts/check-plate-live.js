// 실제 사진으로 번호판 대조를 시험한다. **DB에 아무것도 쓰지 않는다.**
//
// 왜 별도 도구인가: 이 기능의 판정은 사진 품질에 통째로 달려 있는데, 그건 코드로 알 수 없고
// 실제 사진을 넣어봐야 안다. 오더 상태를 운행시작으로 만들지 않고도 확인할 수 있어야
// 사진이 준비된 날 바로 돌려볼 수 있다.
//
// 사용법:
//   node scripts/check-plate-live.js 237            오더 id — 지사 설정의 전면 사진 순번을 쓴다
//   node scripts/check-plate-live.js 237 3          순번을 직접 지정
//   node scripts/check-plate-live.js https://...    사진 URL만 (대조는 건너뜀)
require('dotenv').config();

const db = require('../db');
const plateOcr = require('../lib/plateOcr');
const callmanerPhotos = require('../lib/callmanerPhotos');

function line(label, value) {
  console.log(`  ${String(label).padEnd(16)} ${value}`);
}

async function main() {
  const arg = String(process.argv[2] || '').trim();
  if (!arg) {
    console.log('사용법: node scripts/check-plate-live.js <오더id | 사진URL> [사진순번]');
    process.exit(1);
  }

  let url = null;
  let registered = null;
  let seq = null;

  if (/^https?:\/\//i.test(arg)) {
    url = arg;
  } else {
    const order = await db.get('SELECT * FROM orders WHERE id = ? OR oid = ?', [Number(arg) || 0, arg]);
    if (!order) { console.log('오더를 찾을 수 없습니다:', arg); process.exit(1); }
    const branch = await db.get('SELECT * FROM branches WHERE id = ?', [order.branch_id]).catch(() => null);
    seq = Number(process.argv[3]) || callmanerPhotos.platePhotoIndex(branch || {});
    const photos = await callmanerPhotos.loadPhotos(order.id, 'start');
    const target = (photos || []).find((p) => Number(p.seq) === seq);

    console.log(`\n[오더] ${order.oid}`);
    line('접수 차량번호', order.vehicle_number || '(없음)');
    line('차종', order.vehicle_type || '-');
    line('운행시작 사진', `${(photos || []).length}장 (전면으로 볼 순번: ${seq})`);
    if (!target) {
      console.log(`\n${seq}번 사진이 없습니다. 순번을 직접 지정해 보세요: node scripts/check-plate-live.js ${arg} 1`);
      process.exit(1);
    }
    url = target.url;
    registered = order.vehicle_number;
  }

  console.log('\n[사진]');
  line('URL', url);

  // 크기를 먼저 본다 — 모델을 부르기 전에 걸리는지가 이 검사의 핵심 관심사다.
  const res = await fetch(url).catch((e) => ({ ok: false, statusText: e.message }));
  if (!res.ok) {
    line('내려받기', `실패 (${res.status || ''} ${res.statusText || ''})`);
    process.exit(1);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  const size = plateOcr.imageSize(buffer);
  line('크기', size ? `${size.width}x${size.height}` : '(판독 불가)');
  line('용량', `${Math.round(buffer.length / 1024)} KB`);
  if (size) {
    const longEdge = Math.max(size.width, size.height);
    const ok = longEdge >= plateOcr.MIN_LONG_EDGE_PX;
    line('해상도 검사', ok
      ? `통과 (긴 변 ${longEdge}px ≥ ${plateOcr.MIN_LONG_EDGE_PX})`
      : `걸림 (긴 변 ${longEdge}px < ${plateOcr.MIN_LONG_EDGE_PX}) — 모델을 부르지 않습니다`);
  }

  console.log('\n[인식]');
  const started = Date.now();
  const r = await plateOcr.readPlate(url);
  line('소요', `${Date.now() - started} ms`);
  line('인식 결과', r.plate || '(못 읽음)');
  if (r.confidence != null) line('확신도', r.confidence);
  if (r.imageIssue) line('사진 문제', r.imageIssue);
  if (r.reason) line('사유', r.reason);
  if (r.note) line('비고', r.note);

  if (registered) {
    console.log('\n[대조]');
    const same = plateOcr.comparePlates(registered, r.plate);
    const status = same === null ? 'unreadable' : (same ? 'match' : 'mismatch');
    line('접수', registered);
    line('사진', r.plate || '(못 읽음)');
    line('판정', status);
    if (status === 'mismatch') {
      // 실제 동작에서는 여기서 한 번 더 읽어 같은 값이 나와야 상이로 확정한다.
      console.log('\n  상이 후보 — 두 번째 읽기로 확인합니다(실제 동작과 동일)');
      const confirmed = await plateOcr.readPlateConfirmed(url, registered);
      line('재확인', confirmed.plate || `(확정 실패: ${confirmed.reason || '읽지 못함'})`);
      line('최종', confirmed.plate ? '상이로 확정 → 관리자 푸시 발송 대상' : '판정 보류 → 알림 없음');
    } else if (status === 'unreadable') {
      console.log('\n  못 읽었을 뿐 상이가 아닙니다 — 알림은 나가지 않습니다.');
    }
  }

  console.log('\n(이 스크립트는 DB에 아무것도 쓰지 않습니다.)');
  process.exit(0);
}

main().catch((e) => { console.error('실패:', e.message); process.exit(1); });
