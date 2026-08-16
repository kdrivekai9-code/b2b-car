// 요금표 설정 화면: 거리 구간 행 동적 추가/삭제
//
// 지사 화면(views/branches/fare_rules.ejs)과 법인 화면(views/groups/fare_rules.ejs)이 함께 쓴다.
// "대표요금제" 칸은 지사에만 있다(법인 요금표에는 그 개념이 없다) — 표가 data-representative="1"
// 일 때만 그 칸을 만든다. 항상 만들면 법인 화면에서 열 수가 헤더보다 하나 많아진다.
(function () {
  var tbody = document.getElementById('fareTiersBody');
  var addBtn = document.getElementById('addTierBtn');
  var fareTable = document.getElementById('fareTiersTable');
  var hasRepresentative = !!(fareTable && fareTable.dataset.representative === '1');

  function renumberTiers() {
    tbody.querySelectorAll('tr').forEach(function (row, i) {
      row.querySelector('.tier-label').textContent = '구간요금' + (i + 1);
      var rep = row.querySelector('input[name="tier_representative"]');
      if (rep) rep.value = String(i);
    });
  }

  function wireRemove(row) {
    row.querySelector('.remove-tier-btn').addEventListener('click', function () {
      row.remove();
      renumberTiers();
    });
  }

  function showToast(message) {
    var t = document.createElement('div');
    t.className = 'toast';
    t.textContent = message;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('toast-hide'); }, 1800);
    setTimeout(function () { t.remove(); }, 2400);
  }

  function wireRepresentativeCheckbox(scope) {
    var table = document.getElementById('fareTiersTable');
    var branchId = table ? table.dataset.branchId : '';
    scope.querySelectorAll('input[name="tier_representative"]').forEach(function (cb) {
      if (cb.dataset.wiredRepresentative === '1') return;
      cb.dataset.wiredRepresentative = '1';
      cb.addEventListener('change', function () {
        var tierId = cb.dataset.tierId;
        if (!tierId) {
          showToast('새로 추가한 구간은 저장 후 대표요금제로 적용됩니다.');
          return;
        }
        fetch('/branches/' + encodeURIComponent(branchId) + '/fare-rules/' + encodeURIComponent(tierId) + '/representative', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
          body: JSON.stringify({ checked: !!cb.checked }),
        })
          .then(function (res) { return res.json().catch(function () { return {}; }); })
          .then(function (data) {
            if (data && data.error) throw new Error(data.error);
            showToast(cb.checked ? '대표요금제로 적용되었습니다.' : '대표요금제 적용이 해제되었습니다.');
          })
          .catch(function () {
            cb.checked = !cb.checked;
            showToast('대표요금제 적용 중 오류가 발생했습니다.');
          });
      });
    });
  }

  document.querySelectorAll('#fareTiersBody tr').forEach(wireRemove);
  wireRepresentativeCheckbox(document);

  if (addBtn) {
    addBtn.addEventListener('click', function () {
      var row = document.createElement('tr');
      row.innerHTML =
        '<td class="tier-label"></td>' +
        '<td><input type="number" name="base_distance_km" value="0" min="0" step="0.1"></td>' +
        '<td><input type="number" name="base_fare" value="0" min="0" step="1000"></td>' +
        '<td><input type="number" name="surcharge_unit_km" value="1" min="0.1" step="0.1"></td>' +
        '<td><input type="number" name="surcharge_fare" value="0" min="0" step="100"></td>' +
        '<td><input type="number" name="max_distance_km" min="0" step="0.1"></td>' +
        '<td><input type="number" name="max_fare" min="0" step="1000"></td>' +
        '<td><input type="number" name="round_unit" value="1000" min="1" step="1"></td>' +
        '<td><select name="round_method"><option value="up">올림</option><option value="round" selected>반올림</option><option value="down">내림</option></select></td>' +
        (hasRepresentative ? '<td style="text-align:center;"><input type="checkbox" name="tier_representative" value=""></td>' : '') +
        '<td><button type="button" class="btn small secondary remove-tier-btn">삭제</button></td>';
      tbody.appendChild(row);
      wireRemove(row);
      wireRepresentativeCheckbox(row);
      renumberTiers();
    });
  }

  var toast = document.getElementById('fareSavedToast') || document.getElementById('fareCopiedToast');
  if (toast) {
    if (window.history.replaceState) {
      var url = new URL(window.location.href);
      url.searchParams.delete('saved');
      url.searchParams.delete('copied');
      url.searchParams.delete('from');
      window.history.replaceState({}, '', url.pathname + url.search);
    }
    setTimeout(function () { toast.classList.add('toast-hide'); }, 2000);
    setTimeout(function () { toast.remove(); }, 2500);
  }
})();
