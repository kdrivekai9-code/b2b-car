// 도선료 관리 화면: 차종 행 동적 추가/삭제 (지사 요금표 fare-rules.js와 동일한 패턴)
(function () {
  var tbody = document.getElementById('ferryFareBody');
  var addBtn = document.getElementById('addFerryFareBtn');

  function renumberRows() {
    tbody.querySelectorAll('tr').forEach(function (row, i) {
      var activeCb = row.querySelector('input[name="is_active"]');
      if (activeCb) activeCb.value = String(i);
    });
  }

  function wireRemove(row) {
    row.querySelector('.remove-row-btn').addEventListener('click', function () {
      row.remove();
      renumberRows();
    });
  }

  document.querySelectorAll('#ferryFareBody tr').forEach(wireRemove);

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      var row = document.createElement('tr');
      row.innerHTML =
        '<td><input type="text" name="route_code" value="WANDO_JEJU" required></td>' +
        '<td><input type="text" name="ship_name" value=""></td>' +
        '<td><textarea name="vehicle_label" rows="2" required></textarea></td>' +
        '<td><input type="number" name="weekday_fare" value="0" min="0" step="100"></td>' +
        '<td><input type="number" name="holiday_fare" value="0" min="0" step="100"></td>' +
        '<td><input type="number" name="sort_order" value="1" min="1" step="1"></td>' +
        '<td style="text-align:center;"><input type="checkbox" name="is_active" value="" checked></td>' +
        '<td><input type="text" name="source_title" value=""></td>' +
        '<td><input type="text" name="source_url" value=""></td>' +
        '<td><button type="button" class="btn small secondary remove-row-btn">삭제</button></td>';
      tbody.appendChild(row);
      wireRemove(row);
      renumberRows();
    });
  }

  var toast = document.getElementById('ferryFareSavedToast');
  if (toast) {
    if (window.history.replaceState) {
      var url = new URL(window.location.href);
      url.searchParams.delete('saved');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    setTimeout(function () { toast.classList.add('toast-hide'); }, 2000);
    setTimeout(function () { toast.remove(); }, 2500);
  }
})();
