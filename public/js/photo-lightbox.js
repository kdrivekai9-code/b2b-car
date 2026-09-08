// 사진 확대 보기.
//
// 왜 새 탭이 아닌가: 오더상세의 탁송사진은 13쌍까지 온다. 새 탭으로 열면 한 장 볼 때마다
// 탭이 하나씩 생기고, 운행전·운행후를 번갈아 비교하려면 탭을 왕복해야 한다 — 흠집이 언제
// 생겼는지 보는 것이 이 화면의 목적인데 그 비교가 가장 불편했다.
//
// 여기서는 같은 자리에 큰 사진을 띄우고 ←/→로 넘긴다. 목록 순서가 운행전 전체 → 운행후
// 전체가 아니라 **같은 항목의 운행전·운행후가 이웃**이라, 화살표 한 번으로 그 짝을 비교한다.
//
// 링크(a[href])는 그대로 남긴다 — 스크립트가 죽거나 가운데클릭·새탭으로 열고 싶은 사람에게는
// 예전 동작이 그대로 남아야 한다. 확대는 기본 동작을 가로채는 것뿐이다.
//
// EJS 화면과 Next 화면이 같은 파일을 쓴다(views/partials/footer.ejs, src/app/AppShell.js) —
// 한쪽에만 넣으면 플래그에 따라 확대가 사라진다(hint-tooltip.js와 같은 이유).
(function () {
  var box = null;
  var imgEl = null;
  var capEl = null;
  var group = [];
  var at = 0;

  function build() {
    if (box && box.parentNode) return box;
    box = document.createElement('div');
    box.className = 'lightbox';
    box.hidden = true;
    box.innerHTML = '<button type="button" class="lb-close" aria-label="닫기">✕</button>'
      + '<button type="button" class="lb-prev" aria-label="이전 사진">‹</button>'
      + '<img class="lb-img" alt="">'
      + '<button type="button" class="lb-next" aria-label="다음 사진">›</button>'
      + '<div class="lb-cap"></div>';
    document.body.appendChild(box);
    imgEl = box.querySelector('.lb-img');
    capEl = box.querySelector('.lb-cap');

    box.querySelector('.lb-close').addEventListener('click', close);
    box.querySelector('.lb-prev').addEventListener('click', function (e) { e.stopPropagation(); step(-1); });
    box.querySelector('.lb-next').addEventListener('click', function (e) { e.stopPropagation(); step(1); });
    // 사진 밖(어두운 바닥)을 누르면 닫는다. 사진 자체를 누를 때는 닫지 않는다 —
    // 확대해 보는 중에 손이 스치면 사라져 다시 찾아 들어가야 한다.
    box.addEventListener('click', function (e) { if (e.target === box) close(); });
    return box;
  }

  function show() {
    var item = group[at];
    if (!item) return;
    build();
    imgEl.src = item.url;
    imgEl.alt = item.caption || '';
    capEl.textContent = (group.length > 1 ? (at + 1) + '/' + group.length + '  ' : '') + (item.caption || '');
    box.hidden = false;
    // 화살표는 넘길 것이 있을 때만.
    box.querySelector('.lb-prev').hidden = group.length < 2;
    box.querySelector('.lb-next').hidden = group.length < 2;
    document.body.classList.add('lb-open');
  }

  function close() {
    if (!box) return;
    box.hidden = true;
    imgEl.src = '';
    document.body.classList.remove('lb-open');
  }

  function step(delta) {
    if (!group.length) return;
    at = (at + delta + group.length) % group.length;
    show();
  }

  // 같은 data-lightbox 값을 가진 것들이 한 묶음이다. 묶음은 **문서 순서**로 모은다 —
  // 화면에 놓인 순서가 곧 사람이 넘기고 싶은 순서다.
  document.addEventListener('click', function (e) {
    var link = e.target && e.target.closest ? e.target.closest('[data-lightbox]') : null;
    if (!link) return;
    var url = link.getAttribute('data-photo') || link.getAttribute('href');
    if (!url) return;
    // 새 탭으로 열려는 의도는 건드리지 않는다.
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();

    var name = link.getAttribute('data-lightbox');
    var nodes = Array.prototype.slice.call(document.querySelectorAll('[data-lightbox="' + name + '"]'));
    group = nodes.map(function (n) {
      return { url: n.getAttribute('data-photo') || n.getAttribute('href'), caption: n.getAttribute('data-caption') || '' };
    }).filter(function (x) { return !!x.url; });
    at = Math.max(0, group.map(function (x) { return x.url; }).indexOf(url));
    show();
  });

  document.addEventListener('keydown', function (e) {
    if (!box || box.hidden) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
  });
})();
