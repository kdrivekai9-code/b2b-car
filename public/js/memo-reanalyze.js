// 요청사항 다시 분석 — 버튼과 결과 팝업(EJS 오더 상세).
//
// Next 화면의 같은 기능은 src/app/orders/new/MemoReanalyzeButton.js다. 한쪽만 고치면
// 플래그를 되돌렸을 때 기능이 사라진다.
//
// 왜 팝업인가: 눌러서 결과를 보고 바로 채택까지 하는 한 흐름이다. 페이지를 새로 그리면
// 관리자가 어디를 봐야 하는지 다시 찾아야 한다.
(function () {
  var overlay = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }

  function close() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  function open(html, footer) {
    close();
    overlay = document.createElement('div');
    overlay.className = 'map-modal-overlay';
    overlay.innerHTML =
      '<div class="map-modal-box memo-reanalyze-box">'
      + '<div class="map-modal-header"><h3>요청사항에서 찾은 내용</h3>'
      + '<button type="button" class="btn small secondary" data-close>닫기</button></div>'
      + '<div class="map-modal-body memo-reanalyze-body">' + html + '</div>'
      + (footer || '')
      + '</div>';
    // 바깥을 눌러도 닫힌다 — 저장 중에는 막는다(중간에 닫으면 무엇이 저장됐는지 모른다).
    overlay.addEventListener('click', function (e) {
      if (e.target === overlay && !overlay.dataset.busy) close();
    });
    overlay.querySelector('[data-close]').addEventListener('click', close);
    document.body.appendChild(overlay);
    return overlay;
  }

  function render(orderId, data) {
    var cands = data.candidates || [];
    var billable = cands.filter(function (c) { return c.billable; });
    var included = cands.filter(function (c) { return !c.billable; });
    var html = '';

    if (data.postal) {
      html += '<p class="memo-reanalyze-postal">📮 <b>등기우편 요청</b>으로 확인되어 '
        + '인수증 업로드 링크를 만들었습니다.</p>';
    }
    if (!cands.length) {
      html += '<p>요청사항에서 부대비용으로 볼 만한 내용을 찾지 못했습니다.</p>';
    }
    billable.forEach(function (c) {
      var amount = c.amount > 0
        ? ' ' + Number(c.amount).toLocaleString('ko-KR') + '원'
        : ' (금액 미정 — 영수증으로 확정)';
      html += '<label class="memo-reanalyze-item">'
        + '<input type="checkbox" value="' + esc(c.code) + '" checked>'
        // 근거를 보여줘야 "왜 이게 잡혔나"를 판단할 수 있다. 원문 조각이다.
        + '<span><b>' + esc(c.label) + '</b>' + amount
        + '<em>요청사항: &ldquo;' + esc(c.evidence) + '&rdquo;</em></span></label>';
    });
    if (included.length) {
      // 청구는 안 하지만 기사에게는 알려야 한다 — 지시가 안 닿으면 차가 빈 채로 간다.
      html += '<div class="memo-reanalyze-included"><b>요금에 포함된 항목</b> — '
        + '청구하지 않지만 기사에게는 전달됩니다.<ul>'
        + included.map(function (c) {
          return '<li>' + esc(c.label) + ' — &ldquo;' + esc(c.evidence) + '&rdquo;</li>';
        }).join('') + '</ul></div>';
    }

    var footer = '<div class="memo-reanalyze-actions">'
      + '<button type="button" class="btn" data-accept>'
      + (billable.length ? '선택한 항목 추가' : '확인') + '</button>'
      + '<span class="hint">체크를 모두 해제하고 눌러도 됩니다 — 그러면 청구하지 않은 것으로 기록됩니다.</span>'
      + '</div>';

    var box = open(html, footer);
    box.querySelector('[data-accept]').addEventListener('click', function () {
      var body = new URLSearchParams();
      box.querySelectorAll('.memo-reanalyze-item input:checked').forEach(function (el) {
        body.append('accept_code', el.value);
      });
      box.dataset.busy = '1';
      this.disabled = true;
      fetch('/orders/' + orderId + '/memo-extra', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'fetch' },
        body: body.toString(),
      }).then(function (r) {
        if (!r.ok) throw new Error('저장하지 못했습니다.');
        // 부대비용 줄이 생겼으니 화면을 새로 읽는다 — 여기서만 갱신하면 아래 정산 카드가 옛 값이다.
        location.reload();
      }).catch(function (e) {
        delete box.dataset.busy;
        alert(e.message);
      });
    });
  }

  document.addEventListener('click', function (e) {
    var btn = e.target.closest && e.target.closest('.memo-reanalyze-btn');
    if (!btn) return;
    var orderId = btn.dataset.order;
    btn.disabled = true;
    open('<p>요청사항을 읽는 중입니다…</p>');
    fetch('/orders/' + orderId + '/reanalyze-memo', {
      method: 'POST', headers: { 'X-Requested-With': 'fetch' },
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    }).then(function (out) {
      if (!out.ok) throw new Error((out.j && out.j.error) || '분석하지 못했습니다.');
      render(orderId, out.j);
    }).catch(function (err) {
      open('<div class="error-msg">' + esc(err.message) + '</div>');
    }).then(function () { btn.disabled = false; });
  });
})();
