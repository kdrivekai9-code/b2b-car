// 좌측 사이드바 너비 조정(드래그) + 접기/펼치기, 이 브라우저에만 저장(localStorage)
(function () {
  var sidebar = document.getElementById('appSidebar');
  if (!sidebar) return;
  if (sidebar.dataset.layoutMode === 'top-nav') return;

  var WIDTH_KEY = 'sidebar.width.v1';
  var COLLAPSED_KEY = 'sidebar.collapsed.v1';
  var MIN_WIDTH = 160;
  var MAX_WIDTH = 360;
  var COLLAPSED_WIDTH = 64;
  var desktopMedia = window.matchMedia('(min-width: 901px)');

  function applyState() {
    if (!desktopMedia.matches) {
      sidebar.classList.remove('collapsed');
      sidebar.style.removeProperty('width');
      return;
    }
    var collapsed = localStorage.getItem(COLLAPSED_KEY) === '1';
    var width = parseInt(localStorage.getItem(WIDTH_KEY), 10);
    if (collapsed) {
      sidebar.classList.add('collapsed');
      sidebar.style.width = COLLAPSED_WIDTH + 'px';
    } else {
      sidebar.classList.remove('collapsed');
      sidebar.style.width = (width && width >= MIN_WIDTH && width <= MAX_WIDTH ? width : 220) + 'px';
    }
  }
  applyState();
  desktopMedia.addEventListener('change', applyState);

  var toggleBtn = document.getElementById('sidebarToggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', function () {
      var collapsed = sidebar.classList.contains('collapsed');
      localStorage.setItem(COLLAPSED_KEY, collapsed ? '0' : '1');
      applyState();
    });
  }

  var handle = document.getElementById('sidebarResizeHandle');
  if (handle) {
    handle.addEventListener('mousedown', function (e) {
      if (!desktopMedia.matches || sidebar.classList.contains('collapsed')) return;
      e.preventDefault();
      var startX = e.clientX;
      var startWidth = sidebar.offsetWidth;
      function onMove(ev) {
        var newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + (ev.clientX - startX)));
        sidebar.style.width = newWidth + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        localStorage.setItem(WIDTH_KEY, sidebar.offsetWidth);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }
})();
