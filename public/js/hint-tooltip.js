// data-hint가 붙은 요소에 마우스를 올리면 바로 뜨는 설명 풍선.
//
// 왜 title 속성으로 안 두나: 브라우저 기본 툴팁은 1초쯤 기다려야 뜬다. 오더 리스트의 경고
// 표시(예약일 이상 '!', 콜마너 전송 실패 '?')는 "왜 붙었는지"를 바로 알아야 하는 값인데,
// 그 지연 때문에 사유가 없는 것으로 읽혔다(실사용 지적 2026-09-07).
//
// CSS ::after로 만들지 않은 이유는 잘리기 때문이다. 표는 .table-wrap(overflow-x:auto) 안에
// 있어서 셀 밖으로 나가는 풍선이 그 경계에서 잘린다 — 마지막 줄에서는 아래로 열리는 풍선이
// 통째로 안 보인다. 그래서 풍선 하나를 body에 두고 position:fixed로 좌표만 옮긴다.
//
// EJS 목록과 Next 목록이 같은 파일을 쓴다(views/partials/footer.ejs, AppShell.js) —
// 한쪽에만 넣으면 플래그에 따라 툴팁이 사라진다.
(function () {
  var GAP = 8;
  var bubble = null;
  var current = null;

  function ensureBubble() {
    if (bubble && bubble.parentNode) return bubble;
    bubble = document.createElement('div');
    bubble.className = 'hint-bubble';
    bubble.setAttribute('role', 'tooltip');
    bubble.hidden = true;
    document.body.appendChild(bubble);
    return bubble;
  }

  function show(el) {
    var text = el.getAttribute('data-hint');
    if (!text) return;
    var b = ensureBubble();
    b.textContent = text;
    b.hidden = false;
    current = el;

    // 좌표는 매번 다시 잰다 — 표가 가로로 스크롤되거나 창이 바뀌면 이전 값이 틀린다.
    var r = el.getBoundingClientRect();
    var bw = b.offsetWidth;
    var bh = b.offsetHeight;
    // 기본은 아래쪽. 아래에 자리가 없으면 위로 뒤집는다(마지막 줄에서 화면 밖으로 나가지 않게).
    var top = r.bottom + GAP;
    if (top + bh > window.innerHeight - 4) top = Math.max(4, r.top - bh - GAP);
    // 가로는 표시 왼쪽에 맞추되 화면을 넘지 않게 당긴다.
    var left = Math.min(Math.max(4, r.left), Math.max(4, window.innerWidth - bw - 4));
    b.style.top = top + 'px';
    b.style.left = left + 'px';
  }

  function hide() {
    current = null;
    if (bubble) bubble.hidden = true;
  }

  function markFrom(target) {
    if (!target || !target.closest) return null;
    return target.closest('[data-hint]');
  }

  // 위임으로 붙인다 — 목록은 실시간 갱신으로 행을 다시 그리므로(order-list) 요소마다 붙이면
  // 갱신 뒤에 툴팁이 죽는다.
  document.addEventListener('mouseover', function (e) {
    var el = markFrom(e.target);
    if (el) { if (el !== current) show(el); return; }
    if (current) hide();
  });
  document.addEventListener('focusin', function (e) {
    var el = markFrom(e.target);
    if (el) show(el); else hide();
  });
  document.addEventListener('focusout', hide);
  // 스크롤·크기변경 중에는 좌표가 틀어진다. 따라다니게 만들 값이 아니라 그냥 닫는다.
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') hide(); });
})();
