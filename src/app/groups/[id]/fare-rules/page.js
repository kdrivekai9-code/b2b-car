// 탁송 요금(법인) — views/groups/fare_rules.ejs의 Next 판.
//
// 이 화면의 본체는 **"지금 무엇으로 요금이 나오는가"**다. 지점 구간요금이 거리 구간표보다
// 먼저 적용되고, 거리 구간표는 법인 → 지사로 떨어진다. 그 순서를 화면 맨 위에서 밝히지
// 않으면 관리자는 구간표만 고쳐놓고 "왜 안 바뀌지"를 겪는다(사용자 지적 2026-08-29).
import AppShell from '../../../_components/AppShell';
import ConfirmForm from '../../../_components/ConfirmForm';
import FareSurchargeSettings from '../../../_components/FareSurchargeSettings';
import OrderTypeTripFees from '../../../_components/OrderTypeTripFees';
import DistanceTierTable from '../../../branches/_components/DistanceTierTable';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

export default async function GroupFareRulesPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const data = await loadGroupData(id, 'fare-rules');
  const {
    currentUser, group, groups, tiers, extra, branchTiers, branchExtra,
    officeCount, officeZoneCount, orderTypeFeeGroups,
  } = data;

  const officeOn = group.office_fare_enabled !== false;
  const officeActive = officeOn && officeCount > 0;
  // 거리 구간표는 법인 표 → 지사 표 순으로 떨어진다(lib/branchPolicy.js loadFareTable).
  const distanceSource = tiers.length ? 'group' : (branchTiers.length ? 'branch' : 'none');
  const branchUsable = branchExtra.fare_table_enabled && branchTiers.length;
  // 둘 다 없으면 자동 계산이 아예 안 된다 — 이건 경고로 띄워야 한다.
  const noneUsable = !officeActive && distanceSource === 'none';

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="fare" formId="fareForm"
        title="탁송 요금"
        sub="거리 기반 자동요금 계산 규칙입니다. 계산식: 기본요금 + (거리 − 기준거리) × (할증요금 ÷ 할증단위)"
      >
        {sp.error ? <div className="alert error">{sp.error}</div> : null}

        {/* 두 표는 배타적이지 않다 — 지점 구간요금은 걸릴 때만 적용되고, 안 걸리는 구간은
            거리 구간표로 떨어진다. 그래서 하나를 고르는 식이 아니라 순위로 보여준다. */}
        <div className="card" style={{ borderLeft: '4px solid #15803d' }}>
          <div className="section-title">📌 현재 적용되는 요금표</div>
          <p className="page-sub" style={{ marginTop: -4 }}>
            위에서부터 순서대로 확인합니다. <b>앞 순위에서 걸리면 뒤는 보지 않습니다.</b>
          </p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 70 }}>순위</th><th style={{ width: 190 }}>요금표</th><th style={{ width: 120 }}>상태</th><th>내용</th></tr></thead>
              <tbody>
                <tr>
                  <td><b>1</b></td>
                  <td>지점 구간요금</td>
                  <td>
                    {officeActive ? <span className="badge green">적용 중</span>
                      : officeOn && !officeCount ? <span className="badge gray">등록 없음</span>
                        : !officeOn && officeCount ? <span className="badge amber">적용 꺼짐</span>
                          : <span className="badge gray">사용 안 함</span>}
                  </td>
                  <td>
                    {officeActive ? (
                      <>지점 <b>{officeCount}곳</b> · 요금 <b>{officeZoneCount.toLocaleString('ko-KR')}줄</b> — 출발지나 도착지가 등록 지점이면 이 금액으로 청구합니다.</>
                    ) : officeOn && !officeCount ? (
                      <>켜져 있지만 <b>등록된 지점이 없어</b> 적용되지 않습니다.</>
                    ) : !officeOn && officeCount ? (
                      <>지점 {officeCount}곳이 등록돼 있으나 <b>적용을 꺼두었습니다.</b></>
                    ) : '등록된 지점이 없고 적용도 꺼져 있습니다.'}
                  </td>
                </tr>
                <tr>
                  <td><b>2</b></td>
                  <td>거리 구간요금</td>
                  <td>
                    {distanceSource === 'group' ? <span className="badge green">법인 전용</span>
                      : distanceSource === 'branch' ? <span className="badge blue">지사 표</span>
                        : <span className="badge red">없음</span>}
                  </td>
                  <td>
                    {distanceSource === 'group' ? (
                      <>
                        이 법인 전용 요금표 (구간 <b>{tiers.length}개</b>)
                        {/* 표가 있어도 "이 요금표 사용"이 꺼져 있으면 지사 표로 떨어진다. */}
                        {!extra.fare_table_enabled && (
                          <> <span className="badge amber">이 요금표 사용 꺼짐</span> — 실제로는 지사 표로 계산합니다.</>
                        )}
                      </>
                    ) : distanceSource === 'branch' ? (
                      <>
                        이 법인에 등록된 표가 없어 <b>소속 지사({group.branch_name || '-'})</b> 표로 계산합니다.
                        (지사 구간 {branchTiers.length}개{branchExtra.fare_table_enabled ? '' : ' · 지사 요금표 사용 꺼짐'})
                      </>
                    ) : '법인·지사 어디에도 거리 구간표가 없습니다.'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {noneUsable ? (
            <div className="alert error" style={{ margin: '10px 0 0' }}>
              <b>자동 요금 계산이 되지 않는 상태입니다.</b>
              지점 구간요금도 거리 구간표도 쓸 수 없어, 접수할 때 금액을 손으로 입력해야 합니다.
            </div>
          ) : officeActive && distanceSource === 'none' ? (
            <div className="alert" style={{ margin: '10px 0 0', background: '#fef3e2', color: '#b45309', borderColor: '#f5d9a8' }}>
              지점 구간요금에 <b>걸리지 않는 구간</b>은 계산할 표가 없습니다 — 그 경우 금액을 손으로 입력해야 합니다.
            </div>
          ) : null}

          {distanceSource === 'branch' && branchUsable && (
            <ConfirmForm message="소속 지사 요금표를 이 법인으로 복사할까요?"
              method="POST" action={`/groups/${group.id}/fare-rules/copy`} style={{ marginTop: 10 }}>
              <button className="btn secondary" type="submit">소속 지사 요금표 가져오기</button>
            </ConfirmForm>
          )}
        </div>

        {/* 거리 구간표보다 먼저 적용되므로 화면 위에 둔다(사용자 지시). 아래에 있으면
            구간표만 고쳐놓고 "왜 요금이 안 바뀌지"를 겪는다. */}
        <div className="card" style={{ borderLeft: '4px solid #2e5c8a' }}>
          <div className="section-title">🏢 지점 구간요금 <span className="page-sub">(거리 구간표보다 먼저 적용)</span></div>
          <p className="page-sub">
            지점과 지역 사이의 <b>고정 요금표</b>입니다. 출발지 또는 도착지가 등록한 지점이면
            반대편 지역의 요금을 그대로 청구하고, <b>아래 거리 구간표는 건너뜁니다.</b>
          </p>
          <div className="row" style={{ alignItems: 'center', gap: 16 }}>
            <div className="field" style={{ margin: 0 }}>
              {/* 숨은 '0'과 함께 보낸다 — 체크박스는 켜졌을 때만 올라와서, 이게 없으면
                  끄는 것이 저장되지 않는다. */}
              <input type="hidden" name="office_fare_enabled" value="0" form="fareForm" />
              <label className="checkline inline">
                <input type="checkbox" name="office_fare_enabled" value="1" form="fareForm"
                  defaultChecked={group.office_fare_enabled !== false} />
                {' '}<b>지점 구간요금 우선 적용</b>
              </label>
            </div>
            <div className="field" style={{ margin: 0 }}>
              <a className="btn secondary" href={`/groups/${group.id}/office-fares`}>지점 구간요금 등록 · 관리</a>
            </div>
          </div>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            {officeCount ? (
              <>
                현재 <b>지점 {officeCount}곳 · 요금 {officeZoneCount.toLocaleString('ko-KR')}줄</b>이 등록돼 있습니다.
                {group.office_fare_enabled === false && (
                  <> <span className="badge amber">적용 꺼짐</span> 지금은 이 표를 쓰지 않고 아래 거리 구간표로 계산합니다.</>
                )}
              </>
            ) : (
              <>등록된 지점이 없습니다. 체크되어 있어도 <b>적용되지 않고</b> 아래 거리 구간표로 계산합니다.</>
            )}
          </p>
        </div>

        <form id="fareForm" method="POST" action={`/groups/${group.id}/fare-rules`}>
          <div className="card">
            <div className="section-title">📏 거리 구간별 요금 규칙</div>
            <p className="page-sub" style={{ marginTop: 0 }}>
              위 <b>지점 구간요금</b>에 해당하지 않는 오더에 이 표가 쓰입니다.
            </p>
            <DistanceTierTable tiers={tiers} />
          </div>

          <div className="card">
            <div className="section-title">➕ 부가 요금 / 노출 설정 <span className="hint">(대기·취소요금은 탁송 전용)</span></div>
            <div className="row">
              <div className="field"><label>왕복 비율(%, 편도 대비)</label>
                <input type="number" name="round_trip_ratio" defaultValue={extra.round_trip_ratio || 180} min={0} /></div>
              <div className="field"><label>대기 기준시간(분) · 탁송</label>
                <input type="number" name="wait_threshold_min" defaultValue={extra.wait_threshold_min || 15} min={0} /></div>
              <div className="field"><label>대기요금(원) · 탁송</label>
                <input type="number" name="wait_fee" defaultValue={extra.wait_fee || 0} min={0} /></div>
            </div>
            <div className="row">
              {/* 취소요금은 1,000원 단위로 받는다(사용자 확정) — 지사 화면도 같다. */}
              <div className="field"><label>배차 전 취소요금(원) · 탁송</label>
                <input type="number" name="cancel_before_fee" defaultValue={extra.cancel_before_fee || 0} min={0} step={1000} /></div>
              <div className="field"><label>배차 후 취소요금(원) · 탁송</label>
                <input type="number" name="cancel_after_fee" defaultValue={extra.cancel_after_fee || 0} min={0} step={1000} /></div>
            </div>
            <div className="row">
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_table_enabled" value="1" defaultChecked={!!extra.fare_table_enabled} />
                {' '}이 요금표 사용 (끄면 소속 지사 요금표를 씁니다)</label></div>
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_visible_to_client" value="1" defaultChecked={extra.fare_visible_to_client !== 0} />
                {' '}고객사(딜러)에게 요금 노출</label></div>
              <div className="field"><label className="checkline">
                <input type="checkbox" name="fare_editable_by_client" value="1" defaultChecked={!!extra.fare_editable_by_client} />
                {' '}고객사(딜러)의 금액 수정 허용</label></div>
            </div>
          </div>

          <OrderTypeTripFees groups={orderTypeFeeGroups} extra={extra} />
          <FareSurchargeSettings {...data} />
        </form>

        {sp.saved === '1' && <div className="toast">저장되었습니다.</div>}
        {sp.copied === '1' && <div className="toast">소속 지사 요금표를 가져왔습니다.</div>}
      </GroupSettingsShell>
    </AppShell>
  );
}
