'use client';

import { useState } from 'react';
import TimeSelects from '../../_components/TimeSelects';

// 예외일 추가 — "휴무"를 끄면 오픈/마감 칸이 나온다(EJS의 inline onchange를 옮겼다).
export default function ExceptionForm({ branchId }) {
  const [closed, setClosed] = useState(true);
  return (
    <form method="POST" action={`/branches/${branchId}/operating-hours/exceptions`}>
      <div className="row">
        <div className="field"><label>날짜 *</label><input type="date" name="date" required /></div>
        <div className="field">
          <label className="checkline" style={{ marginTop: 24 }}>
            <input type="checkbox" name="is_closed" value="1" checked={closed}
              onChange={(e) => setClosed(e.target.checked)} /> 휴무
          </label>
        </div>
      </div>
      {/* 휴무면 시간이 의미가 없다 — 감춘다. 값 자체는 서버가 is_closed를 보고 무시한다. */}
      {!closed && (
        <div className="row">
          <div className="field"><label>오픈</label><TimeSelects namePrefix="open_time" value="" /></div>
          <div className="field"><label>마감</label><TimeSelects namePrefix="close_time" value="" /></div>
        </div>
      )}
      <div className="row">
        <div className="field full"><label>메모 (선택)</label><input type="text" name="note" placeholder="예) 창립기념일 임시휴무" /></div>
      </div>
      <button className="btn small" type="submit">예외일 추가</button>
    </form>
  );
}
