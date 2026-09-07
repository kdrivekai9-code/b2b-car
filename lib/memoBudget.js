// 콜마너 적요1(기사메모) 100Byte 예산 계산.
//
// 왜 화면에서 보여줘야 하나: 이 칸에 쓴 글이 그대로 기사에게 가는 줄 알지만, 실제로는
// 콜마너 적요1이 100Byte라 그 뒤가 **말없이 잘린다.** 실측으로 기사 메모의 24.4%가 예산을
// 넘겼다. 쓰는 사람은 다 갔다고 믿고, 기사는 안 온 줄도 모른다.
//
// 예산이 100이 아닌 이유: 맨 앞에 **차종·차량번호**가 붙는다. 기사가 무슨 차인지부터 알아야
// 해서 그 자리는 양보할 수 없다.
//
// 2026-09-07부터 그 표시는 저장할 때 붙고(lib/intakeMemoSplit.js withVehiclePrefix), 콜마너로는
// 저장값이 그대로 나간다 — 예전에는 보내는 순간에만 끼워서 관리자 화면에서 확인할 수 없었다.
// 차종이 함께 붙어 자리가 더 필요해졌다("토레스 150두8774"가 19Byte, 번호만이면 11Byte).
// 등기 인수증 링크는 이제 적요1에 싣지 않으므로(기사 챗봇 전달사항으로 옮겼다) 그만큼은 돌아왔다.
//
// 계산 규칙은 lib/intakeMemoSplit.js briefBudgetBytes와 같아야 한다 — 그쪽은 요약을 만들 때
// 쓰고 여기는 화면에 보여줄 때 쓴다. 갈리면 "화면에는 들어간다는데 실제로는 잘리는" 상태가 된다.
// scripts/check-memo-budget.js가 두 값이 같은지 본다.

// 정의서상 적요1 최대 길이.
const MEMO1_MAX_BYTES = 100;
// 차량 표시와 본문 사이 구분자 " / ".
const SEPARATOR_BYTES = 3;
// 차량 표시를 모를 때 잡아두는 자리(넉넉히). "토레스 150두8774"가 19Byte라 20으로 잡는다.
// 번호만 있던 시절의 11Byte로는 차종이 붙는 순간 예산을 넘긴다.
const ASSUMED_PLATE_BYTES = 20;

function byteLength(s) {
  // 브라우저와 서버 양쪽에서 같은 값이 나와야 한다. TextEncoder는 둘 다 있다.
  if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(s || '')).length;
  return Buffer.byteLength(String(s || ''), 'utf8');
}

// 본문에 쓸 수 있는 바이트. 차량 표시가 정해졌으면 그 길이로, 아니면 넉넉한 가정값으로 뺀다.
//
// 인자는 "맨 앞에 붙는 표시" 전체다 — 차종까지 포함한다. 차종을 따로 받지 않고 하나로 받는
// 이유는 intakeMemoSplit.briefBudgetBytes와 인자를 맞춰야 두 값이 갈리지 않기 때문이다.
function budgetFor(prefix) {
  const p = String(prefix || '').trim();
  const headBytes = p ? byteLength(p) : ASSUMED_PLATE_BYTES;
  return Math.max(20, MEMO1_MAX_BYTES - headBytes - SEPARATOR_BYTES);
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
function describe(text, prefix) {
  const budget = budgetFor(prefix);
  const split = splitAtBytes(text, budget);
  return {
    ...split,
    budget,
    maxBytes: MEMO1_MAX_BYTES,
    plateBytes: budgetFor(prefix) === 20 ? null : MEMO1_MAX_BYTES - SEPARATOR_BYTES - budget,
    over: split.dropped.length > 0,
  };
}

module.exports = {
  MEMO1_MAX_BYTES, SEPARATOR_BYTES, ASSUMED_PLATE_BYTES,
  byteLength, budgetFor, splitAtBytes, describe,
};
