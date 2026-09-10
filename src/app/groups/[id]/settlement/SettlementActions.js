'use client';

// 정산 화면의 클라이언트 동작 — views/groups/settlement.ejs의 <script>를 옮겼다.
//
// 셋뿐이다: 머리글 체크박스로 한 표를 한 번에 고르기, 인쇄·엑셀을 **지금 보고 있는 달**로
// 열기, 실적 있는 달을 고르면 바로 조회.
//
// 월을 ref가 아니라 DOM(#month)에서 읽는다. 인쇄 버튼은 페이지 머리에, 월 입력은 아래
// 카드에 있어서 한 컴포넌트로 묶을 수 없고, ref는 서버 컴포넌트를 건너 넘길 수 없다.
// EJS도 같은 방식이었다.
function readMonth(fallback) {
  const el = typeof document !== 'undefined' ? document.getElementById('month') : null;
  return (el && el.value) || fallback;
}

// 머리글 체크박스 — 그 표의 tbody에 있는 같은 이름의 체크박스를 모두 맞춘다.
export function SelectAllCheckbox({ target }) {
  return (
    <input type="checkbox" className="settle-all"
      onChange={(e) => {
        const table = e.target.closest('table');
        if (!table) return;
        table.querySelectorAll(`tbody input[name="${target}"]`).forEach((cb) => { cb.checked = e.target.checked; });
      }} />
  );
}

// "실적이 있는 달"을 고르면 바로 조회한다.
export function MonthPicker({ month, months }) {
  return (
    <select id="monthPick" defaultValue={month}
      onChange={(e) => {
        if (!e.target.value) return;
        const input = document.getElementById('month');
        if (input) input.value = e.target.value;
        e.target.form.submit();
      }}>
      <option value="">선택</option>
      {months.map((m) => <option key={m} value={m}>{m}</option>)}
    </select>
  );
}

// 엑셀·인쇄 — 누르는 순간의 월을 읽는다. 월 입력만 바꾸고 조회를 누르지 않은 상태에서
// 눌러도 화면에 보이는 달이 나가야 한다(안 그러면 이번 달이 인쇄돼 엉뚱한 서류가 나간다).
export function ExcelLink({ groupId, month }) {
  return (
    <a className="btn secondary" href={`/groups/${groupId}/settlement/excel?month=${encodeURIComponent(month)}`}
      onClick={(e) => {
        e.currentTarget.href = `/groups/${groupId}/settlement/excel?month=${encodeURIComponent(readMonth(month))}`;
      }}>⬇ 엑셀 다운로드</a>
  );
}

export function PrintButton({ groupId, month }) {
  return (
    <button type="button" className="btn"
      onClick={() => window.open(
        `/groups/${groupId}/settlement/print?month=${encodeURIComponent(readMonth(month))}`,
        'settlementPrint', 'width=900,height=1000,scrollbars=yes'
      )}>📄 정산내역서 출력</button>
  );
}

export function IndividualPrintButton({ groupId, month }) {
  return (
    <button type="button" className="btn secondary"
      onClick={() => {
        // 체크한 기타정산 줄만 뽑는다. 하나도 안 골랐으면 ids를 비워 보내 그 달의 개별정산
        // 전부를 뽑게 한다 — 매번 전부 체크하게 하면 쓰기 번거롭다.
        const ids = Array.from(document.querySelectorAll('input[name="extra_id"]:checked')).map((cb) => cb.value);
        const qs = 'month=' + encodeURIComponent(readMonth(month)) + (ids.length ? '&ids=' + encodeURIComponent(ids.join(',')) : '');
        window.open(`/groups/${groupId}/settlement/individual-print?${qs}`,
          'individualPrint', 'width=900,height=1000,scrollbars=yes');
      }}>📄 개별정산 건별 청구서</button>
  );
}
