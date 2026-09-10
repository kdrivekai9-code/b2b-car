// 차종 관리 — views/vehicle_models/index.ejs의 Next 판.
//
// 등록·판정값 저장·삭제·낱말 추가가 전부 순수 HTML form이라 서버 컴포넌트로 그린다.
// 클라이언트가 필요한 곳은 사전 검색 하나뿐이라 그 조각만 따로 뺐다(DictionarySearch).
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import AppShell from '../_components/AppShell';
import ConfirmForm from '../_components/ConfirmForm';
import DictionarySearch from './DictionarySearch';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function VehicleModelsPage({ searchParams }) {
  const sp = (await searchParams) || {};
  const hdrs = await headers();
  const host = hdrs.get('host');
  const proto = hdrs.get('x-forwarded-proto') || 'https';

  const qs = new URLSearchParams(sp).toString();
  const res = await fetch(`${proto}://${host}/vehicle-models/data.json${qs ? '?' + qs : ''}`, {
    headers: { cookie: hdrs.get('cookie') || '', 'X-Requested-With': 'fetch' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) redirect('/login');
  if (!res.ok) throw new Error('차종 정보를 불러오지 못했습니다 (' + res.status + ')');

  const {
    currentUser, rows, migrationMissing, q, preview, previewName, dup,
    dictionaries, addedKeywords, keywordKinds,
  } = await res.json();
  const kindLabel = (kind) => (keywordKinds.find((x) => x.key === kind) || {}).label || kind;

  return (
    <AppShell currentUser={currentUser} activePath="/vehicle-models">
      <div className="page-head-row">
        <div>
          <h1 className="page-title">차종 관리</h1>
          {/* 예전 안내문은 "여기 등록된 판정값으로 붙습니다"였는데, 그 말대로 읽으면 등록하지
              않은 차종에는 할증이 안 붙는 줄 안다(실사용 지적 2026-08-28). 실제로는 등록이
              없으면 아래 내장 사전으로 자동 판정해서 붙는다. */}
          <p className="page-sub">
            요금설정의 <b>수입차 · 대형/화물 · 전기차 할증</b>은 <b>등록하지 않은 차종에도 붙습니다</b> —
            등록이 없으면 아래 <b>자동 인식 사전</b>으로 그 자리에서 판정합니다.
            이 목록은 <b>사전이 틀렸을 때 바로잡는 곳</b>입니다. 등록해두면 그 값이 사전보다 우선합니다.
          </p>
        </div>
      </div>

      {sp.error ? <div className="alert error">{sp.error}</div> : null}

      {/* 이미 자동 인식되는 이름을 등록하려 한 경우. 막되, 사전을 바로잡으려는 것이면 진행할
          수 있어야 한다 — 이 화면의 본래 목적이 그것이다. */}
      {dup && (
        <div className="alert" style={{ background: '#fef3e2', color: '#b45309', borderColor: '#f5d9a8' }}>
          <b>{dup.name}</b> 은(는) <b>이미 자동 인식 사전에 등록</b>되어 있어 따로 등록하지 않아도 됩니다.
          <div style={{ marginTop: 6 }}>
            현재 자동 판정 → <b>{dup.summary}</b>
            {dup.reason ? <span className="page-sub">({dup.reason})</span> : null}
          </div>
          <div style={{ marginTop: 10 }}>
            <span className="page-sub">
              자동 판정이 <b>틀려서 바로잡으려는 것</b>이라면 등록하세요. 등록하면 그 값이 사전보다 우선합니다.
            </span>
          </div>
          <form method="POST" action="/vehicle-models" style={{ marginTop: 8, display: 'flex', gap: 8 }}>
            <input type="hidden" name="name" value={dup.name} />
            <input type="hidden" name="q" value={q} />
            <input type="hidden" name="force" value="1" />
            <button className="btn small" type="submit">그래도 등록 (판정을 고치겠습니다)</button>
            <a className="btn small secondary" href={'/vehicle-models' + (q ? '?q=' + encodeURIComponent(q) : '')}>취소</a>
          </form>
        </div>
      )}
      {migrationMissing && (
        <div className="alert error">차종 테이블이 아직 없습니다. 마이그레이션(20260828010000)을 실행해주세요.</div>
      )}

      <div className="card">
        <div className="section-title">➕ 차종 등록</div>
        <form method="POST" action="/vehicle-models" className="row" style={{ alignItems: 'flex-end' }}>
          <input type="hidden" name="q" value={q} />
          <div className="field" style={{ flex: 2 }}>
            <label>차종명</label>
            <input type="text" name="name" placeholder="예: 카니발 9인승 / BMW 520d / 봉고3 1톤" required />
            <p className="page-sub">브랜드가 들어가면 수입 여부를, &quot;전기차·EV&quot;가 들어가면 전기차를, &quot;톤·승합·카니발&quot; 등은 대형/화물을 자동으로 잡습니다.</p>
          </div>
          <div className="field"><button className="btn" type="submit">등록</button></div>
        </form>
        {preview && (
          <p className="page-sub">
            <b>{previewName}</b> 자동 판정 →{' '}
            car_type <b>{preview.carType}</b> ·{' '}
            fuel_type <b>{preview.fuelType || '-'}</b> ·{' '}
            수입 <b>{preview.isImported ? 'O' : '-'}</b> ·{' '}
            대형/화물 <b>{preview.isLarge ? 'O' : '-'}</b> ·{' '}
            전기 <b>{preview.isEv ? 'O' : '-'}</b>
            {preview.reasons.length ? ` (${preview.reasons.join(', ')})` : ''}
          </p>
        )}
      </div>

      <div className="card">
        <div className="section-title">📋 등록된 차종 ({rows.length}건)</div>
        <form method="GET" action="/vehicle-models" className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ flex: 2 }}>
            <label>차종명 검색</label>
            <input type="text" name="q" defaultValue={q} placeholder="차종명 일부" />
          </div>
          <div className="field"><button className="btn secondary" type="submit">검색</button></div>
        </form>

        <form method="POST" action="/vehicle-models/bulk" id="bulkForm">
          <input type="hidden" name="q" value={q} />
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>차종명</th>
                  <th style={{ width: 90 }}>car_type</th>
                  <th style={{ width: 80 }}>fuel_type</th>
                  <th style={{ width: 80 }}>수입차</th>
                  <th style={{ width: 95 }}>대형/화물</th>
                  <th style={{ width: 80 }}>전기차</th>
                  <th style={{ width: '20%' }}>자동 판정 근거</th>
                  <th style={{ width: 70 }}></th>
                </tr>
              </thead>
              <tbody>
                {!rows.length && (
                  <tr><td colSpan={8} className="page-sub">등록된 차종이 없습니다. 위에서 등록해주세요.</td></tr>
                )}
                {rows.map((r) => {
                  // 자동 판정과 확정값이 갈린 줄은 사람이 고친 것이다 — 사전을 손볼 단서라 표시해 둔다.
                  const edited = (!!r.is_imported !== !!r.auto_imported)
                    || (!!r.is_large !== !!r.auto_large) || (!!r.is_ev !== !!r.auto_ev);
                  return (
                    <tr key={r.id}>
                      <td>
                        <input type="hidden" name="model_id" value={r.id} />
                        {r.name}
                        {edited ? <span className="page-sub">· 수정됨</span> : null}
                      </td>
                      {/* car_type/fuel_type은 체크박스에서 파생되는 값이라 직접 고치지 않는다 —
                          따로 손대게 하면 목록은 '국산'인데 요금은 수입 할증이 붙는 상태가 생긴다. */}
                      <td><b>{r.car_type || '-'}</b></td>
                      <td>{r.fuel_type || '-'}</td>
                      <td><input type="checkbox" name="is_imported" value={r.id} defaultChecked={!!r.is_imported} /></td>
                      <td><input type="checkbox" name="is_large" value={r.id} defaultChecked={!!r.is_large} /></td>
                      <td><input type="checkbox" name="is_ev" value={r.id} defaultChecked={!!r.is_ev} /></td>
                      <td className="page-sub">{r.note || '-'}</td>
                      <td>
                        <button type="submit" className="btn small secondary"
                          formAction={`/vehicle-models/${r.id}/delete`} formMethod="POST">삭제</button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {rows.length > 0 && (
            <>
              <button className="btn" type="submit" style={{ marginTop: 12 }}>판정값 저장</button>
              <p className="page-sub">체크를 고치면 이후 접수부터 그 값이 적용됩니다. 이미 접수된 오더의 요금은 바뀌지 않습니다.</p>
            </>
          )}
        </form>
      </div>

      {/* 자동 인식 사전 — 코드(lib/vehicleClass.js)에 박아둔 목록이라 화면에서 고칠 수 없다.
          그래도 보여주는 이유: 무엇이 이미 인식되는지 모르면 관리자는 "등록된 몇 건만 할증이
          붙는다"고 오해하고, 이미 잡히는 차종을 중복 등록하거나 새는 차종을 못 찾는다. */}
      <div className="card">
        <div className="section-title">🔎 자동 인식 사전 — 등록 없이 판정되는 이름</div>
        <p className="page-sub">
          아래 낱말이 차종명에 들어 있으면 등록하지 않아도 자동으로 판정합니다.
          표기가 흔들려도(<code>benz E250</code>, <code>벤츠e클래스</code>) 잡습니다.
          <b>여기 없는 이름은 국산·일반으로 떨어져 할증이 붙지 않습니다</b> — 그런 차종을 발견하면 위에서 등록해주세요.
        </p>
        <DictionarySearch dictionaries={dictionaries} />
        <p className="page-sub" style={{ marginTop: 12 }}>
          위 목록은 코드에 들어 있어 화면에서 지울 수 없습니다. <b>빠진 이름은 아래에서 더하세요</b> —
          브랜드를 한 번 더하면 그 브랜드의 <b>모든 모델</b>이 잡힙니다(차종마다 등록하지 않아도 됩니다).
        </p>

        {/* 코드 사전과 따로 둔다. 지울 수 있는 것은 여기 있는 것뿐이라, 섞어 놓으면
            "왜 이건 삭제가 안 되지"가 된다. */}
        <div className="section-title" style={{ fontSize: 14, marginTop: 16 }}>
          ➕ 낱말 추가 ({addedKeywords.length}개 추가됨)
        </div>
        <form method="POST" action="/vehicle-models/keywords" className="row" style={{ alignItems: 'flex-end' }}>
          <div className="field">
            <label>분류</label>
            <select name="kind" required>
              {keywordKinds.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
            </select>
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>낱말</label>
            <input type="text" name="word" placeholder="예: 쿠프라 / EX30 / 이트론" required minLength={2} />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>비고</label>
            <input type="text" name="note" placeholder="예: 2026년 국내 출시" />
          </div>
          <div className="field"><button className="btn" type="submit">추가</button></div>
        </form>
        <p className="page-sub">
          차종명에 이 낱말이 <b>들어 있기만 하면</b> 판정됩니다. 그래서 한 글자는 받지 않습니다 —
          아무 이름에나 걸려 국산차를 수입으로 만듭니다. 추가는 1분 안에 접수에 반영됩니다.
        </p>

        {addedKeywords.length > 0 && (
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead><tr><th style={{ width: 160 }}>분류</th><th>낱말</th><th>비고</th><th style={{ width: 70 }}></th></tr></thead>
              <tbody>
                {addedKeywords.map((k) => (
                  <tr key={k.id}>
                    <td>{kindLabel(k.kind)}</td>
                    <td><b>{k.word}</b></td>
                    <td className="page-sub">{k.note || '-'}</td>
                    <td>
                      <ConfirmForm message={`판정 낱말 "${k.word}"을(를) 삭제하시겠습니까?`}
                        method="POST" action={`/vehicle-models/keywords/${k.id}/delete`}>
                        <button className="btn small secondary" type="submit">삭제</button>
                      </ConfirmForm>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
    </AppShell>
  );
}
