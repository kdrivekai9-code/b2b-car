// 콜마너 적요1(기사메모) 100Byte 예산 계산.
//
// 왜 화면에서 보여줘야 하나: 이 칸에 쓴 글이 그대로 기사에게 가는 줄 알지만, 실제로는
// 콜마너 적요1이 100Byte라 그 뒤가 **말없이 잘린다.** 실측으로 기사 메모의 24.4%가 예산을
// 넘겼다. 쓰는 사람은 다 갔다고 믿고, 기사는 안 온 줄도 모른다.
//
// 예산이 100이 아닌 이유: 맨 앞에 차량번호가 붙는다(lib/callmaner.js memoWithVehicle).
// 기사가 어느 차인지부터 알아야 해서 그 자리는 양보할 수 없다. 등기 인수증 링크가 붙는
// 건이면 그만큼 더 줄어든다.
//
// 계산 규칙은 lib/intakeMemoSplit.js briefBudgetBytes와 같아야 한다 — 그쪽은 요약을 만들 때
// 쓰고 여기는 화면에 보여줄 때 쓴다. 갈리면 "화면에는 들어간다는데 실제로는 잘리는" 상태가 된다.

// 정의서상 적요1 최대 길이.
const MEMO1_MAX_BYTES = 100;
// 차량번호와 본문 사이 구분자 " / ".
const SEPARATOR_BYTES = 3;
// 차량번호를 모를 때 잡아두는 자리(넉넉히). 실제 번호판은 보통 9~11바이트다.
const ASSUMED_PLATE_BYTES = 11;

function byteLength(s) {
  // 브라우저와 서버 양쪽에서 같은 값이 나와야 한다. TextEncoder는 둘 다 있다.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s || '')).length;
  return Buffer.byteLength(String(s || ''), 'utf8');
}

// 본문에 쓸 수 있는 바이트. 차량번호가 정해졌으면 그 길이로, 아니면 넉넉한 가정값으로 뺀다.
function budgetFor(plate) {
  const p = String(plate || '').trim();
  const plateBytes = p ? byteLength(p) : ASSUMED_PLATE_BYTES;
  return Math.max(20, MEMO1_MAX_BYTES - plateBytes - SEPARATOR_BYTES);
}

// 예산까지 들어가는 부분과 잘려나갈 부분으로 가른다.
//
// 글자 단위로 센다 — 바이트로 자르면 한글 한 글자가 반토막 나서 깨진 글자가 보인다.
// 한 글자를 통째로 넣을 수 없으면 거기서 끊는다.
function splitAtBytes(text, budget) {
  const s = String(text || '');
  const limit = Math.max(0, Number(budget) || 0);
  let used = 0;
  let cut = s.length;
  for (let i = 0; i < s.length; i += 1) {
    const b = byteLength(s[i]);
    if (used + b > limit) { cut = i; break; }
    used += b;
  }
  return { kept: s.slice(0, cut), dropped: s.slice(cut), usedBytes: used, totalBytes: byteLength(s) };
}

// 화면에 그대로 쓸 수 있는 요약.
function describe(text, plate) {
  const budget = budgetFor(plate);
  const split = splitAtBytes(text, budget);
  return {
    ...split,
    budget,
    maxBytes: MEMO1_MAX_BYTES,
    plateBytes: budgetFor(plate) === 20 ? null : MEMO1_MAX_BYTES - SEPARATOR_BYTES - budget,
    over: split.dropped.length > 0,
  };
}

module.exports = {
  MEMO1_MAX_BYTES, SEPARATOR_BYTES, ASSUMED_PLATE_BYTES,
  byteLength, budgetFor, splitAtBytes, describe,
};
