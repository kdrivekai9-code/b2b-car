'use client';

import { useState } from 'react';

// 자동 인식 사전 검색 — EJS의 #dictFilter 스크립트를 그대로 옮겼다.
//
// 이 화면에서 클라이언트 코드가 필요한 곳은 여기뿐이라(나머지는 순수 form) 이 조각만
// 클라이언트 컴포넌트로 둔다. 화면 전체를 'use client'로 만들면 서버에서 받은 데이터를
// 통째로 브라우저로 실어 보내게 된다 — 사전 낱말이 수백 개다.
export default function DictionarySearch({ dictionaries }) {
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  return (
    <>
      <div className="field" style={{ maxWidth: 320 }}>
        <label htmlFor="dictFilter">사전 검색</label>
        <input type="text" id="dictFilter" placeholder="예: 벤츠, tesla, 톤"
          value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {dictionaries.map((d) => {
        const hits = needle ? d.words.filter((w) => w.toLowerCase().includes(needle)) : d.words;
        // 검색 중에는 걸린 묶음만 펼쳐 보여준다 — 빈 묶음이 남아 있으면 "없음"인지
        // "안 펼침"인지 헷갈린다.
        if (needle && hits.length === 0) return null;
        return (
          <details className="dict-group" key={d.key} style={{ marginTop: 10 }} open={!!needle}>
            <summary><b>{d.label}</b> <span className="page-sub">({d.words.length}개)</span></summary>
            <div className="dict-words" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 }}>
              {hits.map((w) => (
                <span className="badge gray dict-word" style={{ fontWeight: 'normal' }} key={w}>{w}</span>
              ))}
            </div>
          </details>
        );
      })}
    </>
  );
}
