// 지점 구간요금 — views/groups/office_fares.ejs의 Next 판.
//
// 계약이 "강남지점 ↔ 서울 강남구 = 20,000원"처럼 표로 맺어지는 경우가 많다. 이 표가 있으면
// **거리 구간표보다 먼저** 본다(lib/branchPolicy.js calculateFare) — 그 사실을 화면에서
// 밝히지 않으면 관리자는 탁송 요금 화면의 구간표를 고쳐놓고 "왜 안 바뀌지"를 겪는다.
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';
import OfficeForm from './OfficeForm';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const SIDO = [
  '서울특별시', '부산광역시', '대구광역시', '인천광역시', '광주광역시', '대전광역시', '울산광역시', '세종특별자치시',
  '경기도', '강원특별자치도', '충청북도', '충청남도', '전북특별자치도', '전라남도', '경상북도', '경상남도', '제주특별자치도',
];
const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';

export default async function GroupOfficeFaresPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const { currentUser, group, groups, offices, zonesByOffice } = await loadGroupData(id, 'office-fares');

  let uploadResult = null;
  if (sp.uploaded) {
    // 업로드 결과는 주소창으로 돌아온다(리다이렉트) — 깨진 값이 화면을 죽이지 않게 감싼다.
    try { uploadResult = JSON.parse(decodeURIComponent(sp.uploaded)); } catch { uploadResult = null; }
  }

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      {/* 이 화면은 탭이 아니라 탁송 요금 안에서 들어온다(사용자 지시) — 탭 줄에서는
          '탁송 요금'이 켜진 채로 보여야 어디에 있는지 헷갈리지 않는다. */}
      <GroupSettingsShell
        group={group} groups={groups} active="fare"
        title="지점 구간요금"
        sub={<>
          지점과 지역 사이의 <b>고정 요금표</b>입니다. 출발지 또는 도착지가 등록한 지점이면
          반대편 지역의 요금을 그대로 청구합니다.
          <b> 이 표가 있으면 「탁송 요금」의 거리 구간별 요금 규칙보다 먼저 적용됩니다.</b>
          {' '}적용 여부(우선 적용 체크)는 <a href={`/groups/${group.id}/fare-rules`}>탁송 요금</a> 화면에서 켜고 끕니다.
        </>}
        actions={<a className="btn secondary" href={`/groups/${group.id}/fare-rules`}>← 탁송 요금으로 돌아가기</a>}
      >
        {sp.error ? <div className="alert error">{sp.error}</div> : null}
        {sp.saved ? <div className="alert">{sp.saved}</div> : null}
        {uploadResult && (
          <div className="alert">
            업로드 완료 — <b>{uploadResult.saved}줄 저장</b>,
            {' '}{uploadResult.skipped}줄 건너뜀, 거리 자동계산 {uploadResult.distanceFilled}줄.
            {/* 시도 교정을 조용히 하면 "내가 적은 것과 다르게 저장됐다"가 된다 — 건수를 밝힌다. */}
            {uploadResult.regionCorrected ? (
              <div style={{ marginTop: 6 }} className="page-sub">
                시도 표기를 {uploadResult.regionCorrected}줄 교정했습니다 —
                행정구역이 바뀐 지역(예: 광주광역시 → 전남)은 접수된 오더에 붙는 표기로 맞춰야 매칭됩니다.
              </div>
            ) : null}
            {/* 건너뛴 줄을 숨기면 "다 올라간 줄" 알고 넘어간다 — 청구 누락으로 이어진다. */}
            {(uploadResult.errors || []).length > 0 && (
              <div style={{ marginTop: 8 }}>
                <b>건너뛴 줄</b>
                <ul style={{ margin: '4px 0 0 18px' }}>
                  {uploadResult.errors.map((m, i) => <li className="page-sub" key={i}>{m}</li>)}
                </ul>
              </div>
            )}
          </div>
        )}

        <div className="card">
          <div className="section-title">🏢 지점 등록</div>
          <p className="page-sub">
            주소는 <b>반드시 검색해서 확정</b>해주세요. 좌표로 &quot;이 오더의 출발/도착이 그 지점인가&quot;를 판정합니다
            — 주소 글자만으로는 &quot;서울 강남구&quot;와 &quot;서울특별시 강남구&quot;가 다른 곳이 됩니다.
          </p>
          <OfficeForm groupId={group.id} />
        </div>

        <div className="card">
          <div className="section-title">💰 요금 등록</div>
          {!offices.length ? (
            <p className="page-sub" style={{ margin: 0 }}>먼저 지점을 등록해주세요.</p>
          ) : (
            <>
              <p className="page-sub">
                거리는 <b>지역 청사 기준</b>으로 자동 계산합니다 — 시는 시청, 군은 군청, 구는 구청.
                지역은 넓어서 기준을 정해두지 않으면 등록할 때마다 거리가 달라집니다. (소수점 한 자리)
              </p>
              <form method="POST" action={`/groups/${group.id}/office-fares/zones`} className="row" style={{ alignItems: 'flex-end' }}>
                <div className="field" style={{ flex: 1 }}>
                  <label>지점</label>
                  <select name="office_id" required>
                    {offices.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>시도</label>
                  <select name="sido" required defaultValue="">
                    <option value="">선택</option>
                    {SIDO.map((sd) => <option key={sd} value={sd}>{sd}</option>)}
                  </select>
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>시 · 군 · 구</label>
                  <input type="text" name="sigugun" placeholder="예: 강남구 / 수원시 / 양평군" required />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label>요금(원)</label>
                  <input type="number" name="fare" min={0} step={1000} required />
                </div>
                <div className="field"><button className="btn" type="submit">등록</button></div>
              </form>
            </>
          )}
        </div>

        <div className="card">
          <div className="section-title">📄 엑셀 업로드</div>
          <p className="page-sub">
            첫 줄에 열 이름이 있어야 합니다 — <b>지점 · 시도 · 시군구 · 요금</b> (km는 선택).
            열 순서는 상관없습니다. 같은 지점·지역이 이미 있으면 <b>덮어씁니다</b>.
            km를 비워두면 청사 기준으로 자동 계산합니다(줄이 많으면 시간이 걸립니다).
          </p>
          <form method="POST" action={`/groups/${group.id}/office-fares/upload`} encType="multipart/form-data"
            className="row" style={{ alignItems: 'flex-end' }}>
            <div className="field" style={{ flex: 2 }}>
              <label>파일 (.xlsx 또는 .csv)</label>
              <input type="file" name="file" accept=".xlsx,.csv" required />
            </div>
            <div className="field"><button className="btn" type="submit">업로드</button></div>
            <div className="field"><a className="btn secondary" href={`/groups/${group.id}/office-fares/sample`}>샘플 양식 받기</a></div>
          </form>
          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="table">
              <thead><tr><th>지점</th><th>시도</th><th>시군구</th><th>요금</th><th>km</th></tr></thead>
              <tbody>
                <tr><td>강남지점</td><td>서울특별시</td><td>강남구</td><td>20000</td><td className="page-sub">(비움)</td></tr>
                <tr><td>강남지점</td><td>경기도</td><td>수원시</td><td>30000</td><td className="page-sub">(비움)</td></tr>
                <tr><td>강남지점</td><td>경기도</td><td>성남시분당구</td><td>25000</td><td>18.1</td></tr>
              </tbody>
            </table>
          </div>
        </div>

        {offices.map((o) => {
          const zones = zonesByOffice[o.id] || [];
          return (
            <div className="card" key={o.id}>
              <div className="section-title">📋 {o.name} ({zones.length}개 지역)</div>
              <div className="page-sub">
                {o.address}{o.address_detail ? ' ' + o.address_detail : ''}
                {o.sido ? <> · <span className="badge gray">{o.sido} {o.sigugun}</span></> : null}
                <ConfirmForm message={`${o.name} 지점과 요금표 ${zones.length}줄을 모두 삭제합니다. 계속할까요?`}
                  method="POST" action={`/groups/${group.id}/office-fares/offices/${o.id}/delete`}
                  style={{ display: 'inline', marginLeft: 8 }}>
                  <button className="btn small secondary" type="submit">지점 삭제</button>
                </ConfirmForm>
              </div>
              {!zones.length ? (
                <p className="page-sub" style={{ margin: 0 }}>등록된 지역 요금이 없습니다. 이 지점은 거리 구간표로 계산됩니다.</p>
              ) : (
                <div className="table-wrap">
                  <table className="table">
                    <thead>
                      <tr>
                        <th style={{ width: 140 }}>시도</th><th>시 · 군 · 구</th>
                        <th style={{ width: 120, textAlign: 'right' }}>요금</th>
                        <th style={{ width: 100, textAlign: 'right' }}>km</th>
                        <th style={{ width: 70 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {zones.map((z) => (
                        <tr key={z.id}>
                          <td>{z.sido}</td>
                          <td>{z.sigugun}</td>
                          <td style={{ textAlign: 'right' }}>{won(z.fare)}</td>
                          {/* 거리는 안내용이다. 계산에 실패한 줄도 요금은 살아 있으므로
                              '-'로 구분해 보여준다. */}
                          <td style={{ textAlign: 'right' }}>{z.distance_km == null ? '-' : Number(z.distance_km).toFixed(1)}</td>
                          <td>
                            <ConfirmForm message={`${z.sido} ${z.sigugun} 요금을 삭제하시겠습니까?`}
                              method="POST" action={`/groups/${group.id}/office-fares/zones/${z.id}/delete`}>
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
          );
        })}
      </GroupSettingsShell>
    </AppShell>
  );
}
