// 시·분 선택 두 칸 — views/branches/operating_hours.ejs의 timeSelects() 헬퍼를 옮겼다.
//
// <input type="time">을 쓰지 않는 이유는 EJS와 같다: 브라우저마다 12/24시간 표기가 갈려서
// "낮 12시"와 "자정"을 잘못 넣는 일이 있었다. 값은 24시간제로만 받는다.
const HOURS = Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0'));

export default function TimeSelects({ namePrefix, value }) {
  const [hh, mm] = String(value || '').split(':');
  return (
    <>
      <select name={`${namePrefix}_hour`} className="time-select" defaultValue={hh || ''}>
        <option value="">--</option>
        {HOURS.map((h) => <option key={h} value={h}>{h}시</option>)}
      </select>
      {' '}
      <select name={`${namePrefix}_minute`} className="time-select" defaultValue={mm || ''}>
        <option value="">--</option>
        {MINUTES.map((m) => <option key={m} value={m}>{m}분</option>)}
      </select>
    </>
  );
}
