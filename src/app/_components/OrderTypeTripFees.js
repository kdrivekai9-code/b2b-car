// 프리미엄대리 · 일일기사 전용 대기요금 / 취소요금 — views/partials/order_type_trip_fees.ejs의 판.
//
// 지사·법인 요금 화면이 같이 쓴다. 두 벌로 두면 한쪽 화면에서 저장할 때만 값이 틀리는 버그가
// 생기고, 그건 화면을 열어보기 전에는 드러나지 않는다.
//
// 칸 이름은 서버가 준다(lib/tripFees.js ORDER_TYPE_FEE_GROUPS) — 화면에 필드명을 또 적으면
// 컬럼이 늘 때 한쪽만 바뀐다.
export default function OrderTypeTripFees({ groups, extra }) {
  const v = (key) => (extra[key] != null ? extra[key] : '');
  return (
    <div className="card">
      <div className="section-title">⏱ 오더구분별 대기 / 취소 요금</div>
      <p className="hint" style={{ margin: '0 0 10px' }}>
        위 <b>부가 요금</b>의 대기·취소요금은 <b>탁송</b>에만 적용됩니다.
        프리미엄대리·일일기사는 탁송과 요금 구조가 달라(프리미엄=편도 거리, 일일기사=이용 시간) 여기서 따로 정합니다.
        비워두면 <b>받지 않습니다</b>.
      </p>
      {(groups || []).map((g) => (
        <div key={g.orderType || g.label}>
          <div className="section-title small" style={{ margin: '12px 0 6px' }}>{g.label}</div>
          <div className="row">
            <div className="field">
              <label>대기 기준시간(분)</label>
              <input type="number" name={g.keys.threshold} min={0} placeholder="예: 30" defaultValue={v(g.keys.threshold)} />
            </div>
            <div className="field">
              <label>대기요금(원)</label>
              {/* 기준을 넘으면 정액 1회다(분당 아님) — 설정에 단위가 없으므로 지어내지 않는다. */}
              <input type="number" name={g.keys.wait} min={0} step={1000} placeholder="기준 초과 시 1회" defaultValue={v(g.keys.wait)} />
            </div>
          </div>
          <div className="row">
            {/* 탁송은 "배차" 기준이지만 프리미엄/일일기사는 기사가 고객에게 도착했는지가
                손실을 가른다(사용자 지시). 도착의 판단은 '운행시작' 상태다. */}
            <div className="field">
              <label>도착 전 취소요금(원)</label>
              <input type="number" name={g.keys.before} min={0} step={1000} defaultValue={v(g.keys.before)} />
            </div>
            <div className="field">
              <label>도착 후 취소요금(원)</label>
              <input type="number" name={g.keys.after} min={0} step={1000} defaultValue={v(g.keys.after)} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
