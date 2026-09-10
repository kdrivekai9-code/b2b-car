// 정산내역 — views/groups/settlement.ejs의 Next 판.
//
// **금액이 나가는 화면이다.** 숫자 하나가 틀리면 청구서가 틀리므로, 계산은 전부 서버가 하고
// (loadSettlement) 여기서는 그리기만 한다. EJS와 같은 값·같은 자리를 유지하는 것이 이 파일의
// 전부다 — 표현을 "정리"하려 들면 그 순간 두 화면의 숫자가 갈릴 수 있다.
import AppShell from '../../../_components/AppShell';
import VehicleClassBadge from '../../../_components/VehicleClassBadge';
import GroupSettingsShell from '../../_components/GroupSettingsShell';
import loadGroupData from '../../_components/loadGroupData';
import { SelectAllCheckbox, MonthPicker, ExcelLink, PrintButton, IndividualPrintButton } from './SettlementActions';

export const dynamic = 'force-dynamic';
export const preferredRegion = 'icn1';
export const maxDuration = 30;

const won = (n) => (Number(n) || 0).toLocaleString('ko-KR') + '원';
const joinAddr = (a, d) => [a, d].filter(Boolean).join(' ') || '-';

export default async function GroupSettlementPage({ params, searchParams }) {
  const { id } = await params;
  const sp = (await searchParams) || {};
  const d = await loadGroupData(id, 'settlement', sp);
  const {
    currentUser, group, groups, month, months, items, extras, summary, extraSummary,
    surchargeMode, surchargeByLabel, grandTotal, settlementGroups,
    extraChargeTypes, meIsDealer, viewDealerId,
  } = d;

  return (
    <AppShell currentUser={currentUser} activePath="/groups">
      <GroupSettingsShell
        group={group} groups={groups} active="settlement"
        title="정산내역"
        sub={<>
          완료된 오더를 <b>완료일 기준</b>으로 묶었습니다. 금액은 업체별 계약 요금입니다(배차 요금 아님).
          {' '}할증 표시는 <b>{surchargeMode === 'itemized' ? '별도 줄(항목별)' : '운행요금 포함'}</b> 방식입니다.
        </>}
        actions={<>
          {/* 새 창으로 연다(사용자 지시) — 목록을 보던 화면을 잃지 않고 인쇄만 하고 닫을 수
              있어야 한다. 엑셀은 인쇄 앞에 둔다(사용자 지시). */}
          <ExcelLink groupId={group.id} month={month} />
          <PrintButton groupId={group.id} month={month} />
        </>}
      >
        {/* 개인 딜러 중 "별도 정산 청구"로 지정된 사람은 정산서를 따로 받는다. 딜러 본인이
            보는 화면에는 띄우지 않는다 — 자기 것 하나뿐이라 나눌 것이 없다. */}
        {!meIsDealer && (settlementGroups || []).length > 0 && (
          <div className="card">
            <div className="section-title">🧾 청구 주체별 구분 ({settlementGroups.length})</div>
            <p className="page-sub" style={{ marginTop: -4 }}>
              「별도 정산 청구」로 지정된 개인 딜러는 정산서를 따로 받습니다.
              나머지(본사 직원 · 별도청구를 하지 않는 딜러)는 <b>법인 본사</b>에 합쳐집니다.
            </p>
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <th style={{ width: '30%' }}>청구 주체</th>
                  <th style={{ width: 80, textAlign: 'right' }}>건수</th>
                  <th style={{ width: 140, textAlign: 'right' }}>운행요금</th>
                  <th style={{ width: 140, textAlign: 'right' }}>실비</th>
                  <th style={{ width: 150, textAlign: 'right' }}>청구 합계</th>
                  <th style={{ width: 110 }}></th>
                </tr></thead>
                <tbody>
                  {settlementGroups.map((g) => (
                    <tr key={g.key}>
                      <td><b>{g.label}</b><div className="page-sub">{g.sub}</div></td>
                      <td style={{ textAlign: 'right' }}>{g.summary.count}</td>
                      <td style={{ textAlign: 'right' }}>{won(g.summary.total)}</td>
                      <td style={{ textAlign: 'right' }}>{won(g.extraSummary.total)}</td>
                      <td style={{ textAlign: 'right' }}><b>{won(g.grandTotal)}</b></td>
                      <td>
                        {g.key !== 'hq' && (
                          <a className="btn small secondary"
                            href={`?month=${encodeURIComponent(month)}&dealer=${g.key.replace('dealer:', '')}`}>이 딜러만 보기</a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {viewDealerId ? (
              <p className="page-sub">
                지금 <b>딜러 1명</b>의 내역만 보고 있습니다.{' '}
                <a href={`?month=${encodeURIComponent(month)}`}>법인 전체 보기</a>
              </p>
            ) : null}
          </div>
        )}

        {/* 총액이 안 바뀌는 설정이라 화면만 보고는 적용됐는지 알기 어렵다 — 알려준다. */}
        {sp.saved ? <div className="alert">{sp.saved}</div> : null}

        {/* 이 설정이 바꾸는 것은 아래 정산서의 줄 구성뿐이다(총 청구액은 같다). 그래서 요금을
            설정하는 화면이 아니라 정산서를 보는 이 화면 위에 둔다. */}
        <div className="card" style={{ borderLeft: '4px solid #2e5c8a' }}>
          <div className="section-title">🧾 정산서 할증 표시</div>
          <p className="page-sub">
            수입차 · 대형 · 전기차 · 야간 · 오지 할증을 정산내역서에 어떻게 보여줄지 정합니다.
            <b>총 청구액은 어느 쪽이든 같습니다</b> — 줄 구성만 달라집니다.
          </p>
          <form method="POST" action={`/groups/${group.id}/settlement/surcharge-mode`}
            className="row" style={{ alignItems: 'center', gap: 20 }}>
            {/* 조회 중인 달을 함께 보낸다 — 안 보내면 저장 후 이번 달로 튕겨 보던 정산서를 잃는다. */}
            <input type="hidden" name="month" value={month} />
            <label className="checkline inline">
              <input type="radio" name="settlement_surcharge_mode" value="included" defaultChecked={surchargeMode !== 'itemized'} />
              {' '}운행요금에 포함
              <span className="page-sub">(예: 운행요금 105,000원 · 기본 97,000 + 수입차 5,000 + 야간 3,000)</span>
            </label>
            <label className="checkline inline">
              <input type="radio" name="settlement_surcharge_mode" value="itemized" defaultChecked={surchargeMode === 'itemized'} />
              {' '}별도 줄로 분리
              <span className="page-sub">(예: 운행요금 97,000원 + 할증 8,000원)</span>
            </label>
            <button className="btn secondary" type="submit">적용</button>
          </form>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            계약서에 &quot;탁송료&quot; 한 줄로 적혀 있으면 <b>포함</b>이 맞습니다. 줄을 나누면 거래처에서 문의가 올 수 있습니다.
          </p>
        </div>

        <div className="card">
          <form method="GET" action={`/groups/${group.id}/settlement`} className="filter-row"
            style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div className="field" style={{ margin: 0 }}>
              <label htmlFor="month">정산월</label>
              <input type="month" id="month" name="month" defaultValue={month} />
            </div>
            {months.length > 0 && (
              <div className="field" style={{ margin: 0 }}>
                <label htmlFor="monthPick">실적이 있는 달</label>
                <MonthPicker month={month} months={months} />
              </div>
            )}
            <button className="btn" type="submit">조회</button>
          </form>
        </div>

        {/* 체크한 줄만 한 번에 정산완료로 바꾼다. 폼은 표 바깥에 두고 체크박스가 form 속성으로
            가리킨다 — 표 안에 <form>을 넣으면 브라우저가 표 구조를 깨뜨린다. */}
        <form id="settleForm" method="POST" action={`/groups/${group.id}/settlement/settle`}>
          <input type="hidden" name="month" value={month} />
        </form>

        <div className="card">
          <div className="section-title">📄 {month} 운행요금 ({summary.count}건)</div>
          {!items.length ? (
            <p className="page-sub" style={{ margin: 0 }}>이 달에 완료된 오더가 없습니다.</p>
          ) : (
            <div className="table-wrap">
              <table className="table settlement-table">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}><SelectAllCheckbox target="order_id" /></th>
                    <th style={{ width: 46 }}>#</th>
                    <th style={{ width: 120 }}>예약일</th>
                    <th style={{ width: 170 }}>차종</th>
                    <th>출발지</th>
                    <th>도착지</th>
                    <th style={{ width: 130, textAlign: 'right' }}>요금</th>
                    <th style={{ width: 150 }}>정산</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r, i) => (
                    <tr key={r.id} className={r.settled ? 'settled-row' : ''}>
                      <td><input type="checkbox" name="order_id" value={r.id} form="settleForm" /></td>
                      <td>{i + 1}</td>
                      <td>
                        {r.reserved_date || '-'}
                        {r.reserved_time ? <span className="muted">{String(r.reserved_time).slice(0, 5)}</span> : null}
                      </td>
                      <td>{r.vehicle_type || '-'} <VehicleClassBadge row={r} /></td>
                      <td>{joinAddr(r.origin_address, r.origin_address_detail)}</td>
                      <td>{joinAddr(r.destination_address, r.destination_address_detail)}</td>
                      <td style={{ textAlign: 'right' }}>
                        {/* 운행요금 대분류 아래 서브 항목(구간요금·할증·대기·취소)을 나눠
                            보여준다(사용자 지시). 합쳐만 두면 어느 것이 얼마인지 되짚을 수 없다. */}
                        {won(surchargeMode === 'itemized' ? r.baseFare + r.waitFee + r.cancelFee : r.total)}
                        {/* 도선료는 기타 정산으로 옮겼다 — 여기서는 있다는 것만 알린다. */}
                        {r.ferry > 0 && <><br /><span className="muted">도선료 {won(r.ferry)}는 기타 정산</span></>}
                        {r.waitFee > 0 && <><br /><span className="muted">대기요금 {won(r.waitFee)}{r.wait_fee_note ? ' · ' + r.wait_fee_note : ''}</span></>}
                        {r.cancelFee > 0 && <><br /><span className="muted">취소요금 {won(r.cancelFee)}{r.cancel_fee_note ? ' · ' + r.cancel_fee_note : ''}</span></>}
                        {r.surchargeTotal > 0 && (
                          <><br /><span className="muted">
                            {surchargeMode === 'itemized'
                              ? `할증 ${won(r.surchargeTotal)} 별도`
                              : `기본 ${won(r.baseFare)} + ${r.surcharges.map((it) => `${it.label || it.code} ${(Number(it.amount) || 0).toLocaleString('ko-KR')}`).join(' + ')}`}
                          </span></>
                        )}
                      </td>
                      <td>
                        {r.settled ? (
                          <>
                            <span className="badge green">정산완료</span>
                            {/* 언제 누가 확정했는지 — 입금 대사에서 문제가 생기면 이걸로 되짚는다. */}
                            <br /><span className="muted">{String(r.settled_at).slice(0, 16)}{r.settled_by_name ? ' · ' + r.settled_by_name : ''}</span>
                          </>
                        ) : <span className="badge gray">미정산</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th colSpan={6} style={{ textAlign: 'right' }}>합계</th>
                    <th style={{ textAlign: 'right' }}>
                      {won(surchargeMode === 'itemized' ? summary.base + summary.wait + summary.cancel : summary.total)}
                    </th>
                    <th></th>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>

        {/* 별도 줄 방식에서만 나온다. 포함 방식에서는 위 운행요금에 이미 들어 있어
            여기 또 보이면 이중으로 읽힌다. */}
        {surchargeMode === 'itemized' && summary.surcharge > 0 && (
          <div className="card">
            <div className="section-title">➕ 할증 내역 (운행요금에서 분리)</div>
            <p className="page-sub">
              위 운행요금은 할증을 <b>뺀</b> 금액입니다. 아래 할증을 더한 값이 예전과 같은 총액입니다 —
              <b>청구 금액은 달라지지 않습니다.</b>
            </p>
            <div className="table-wrap">
              <table className="table surcharge-table">
                <thead><tr><th>항목</th><th style={{ width: 100, textAlign: 'right' }}>건수</th><th style={{ textAlign: 'right' }}>금액</th></tr></thead>
                <tbody>
                  {Object.keys(surchargeByLabel).map((label) => (
                    <tr key={label}>
                      <td>{label}</td>
                      <td style={{ textAlign: 'right' }}>{surchargeByLabel[label].count}건</td>
                      <td style={{ textAlign: 'right' }}>{won(surchargeByLabel[label].amount)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot><tr><th>합계</th><th></th><th style={{ textAlign: 'right' }}>{won(summary.surcharge)}</th></tr></tfoot>
              </table>
            </div>
          </div>
        )}

        <div className="card">
          <div className="section-title">🧾 기타 정산 내역 · 별도 청구 ({extraSummary.listedCount}건)</div>
          <p className="page-sub">
            <b>별도 청구</b>로 표시된 실비만 모았습니다. 해당 오더가 완료된 달로 묶이며, 일자는 실제 발생일입니다.
            <b>아래 합계와 총 청구액에는 월정산 항목만 들어갑니다</b> —
            개별정산은 건별 청구서로 따로 청구하므로, 함께 넣으면 두 번 청구하게 됩니다.
          </p>
          {!extras.length ? (
            <p className="page-sub" style={{ margin: 0 }}>이 달에 별도 청구할 기타 정산 내역이 없습니다.</p>
          ) : (
            <>
              <div className="table-wrap">
                <table className="table extra-charge-table">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}><SelectAllCheckbox target="extra_id" /></th>
                      <th style={{ width: 120 }}>일자</th>
                      <th style={{ width: 130 }}>차량번호</th>
                      <th>출발지</th>
                      <th style={{ width: 120 }}>항목</th>
                      <th style={{ width: 110 }}>정산방식</th>
                      <th style={{ width: 120, textAlign: 'right' }}>금액</th>
                      <th style={{ width: 150 }}>정산</th>
                    </tr>
                  </thead>
                  <tbody>
                    {extras.map((r, i) => (
                      <tr key={r.id != null ? `e${r.id}` : `d${i}`} className={r.settled ? 'settled-row' : ''}>
                        <td>
                          {/* 도선료 줄은 오더에서 파생된 것이라 따로 확정하지 않는다 — 그 오더를
                              정산완료하면 함께 완료된다. 체크박스를 주면 눌러도 아무 일이 안 일어난다. */}
                          {!r.derived && <input type="checkbox" name="extra_id" value={r.id} form="settleForm" />}
                        </td>
                        <td>{r.charged_on || '-'}</td>
                        <td>{r.vehicle_number || '-'}</td>
                        <td>
                          {joinAddr(r.origin_address, r.origin_address_detail)}
                          {/* 같은 차량·같은 날 실비가 여러 건이면 어느 오더 것인지 구분이 안 된다. */}
                          <span className="muted">{r.oid}</span>
                          {r.note && <><br /><span className="muted">{r.note}</span></>}
                        </td>
                        <td>기타정산({r.charge_type})</td>
                        <td>
                          {r.settleMode === 'individual' ? (
                            <>
                              {/* 이 줄은 아래 합계에 들어가지 않는다 — 건별 청구서로 따로 청구한다.
                                  합계에 넣으면 같은 금액을 두 번 청구하게 된다. */}
                              <span className="badge purple">개별정산</span>
                              <br /><span className="muted">건별 청구</span>
                            </>
                          ) : <span className="badge blue">월정산</span>}
                        </td>
                        <td style={{ textAlign: 'right' }}>{won(r.amount)}</td>
                        <td>
                          {r.settled ? (
                            <>
                              <span className="badge green">정산완료</span>
                              {r.settled_at && (
                                <><br /><span className="muted">{String(r.settled_at).slice(0, 16)}{r.settled_by_name ? ' · ' + r.settled_by_name : ''}</span></>
                              )}
                            </>
                          ) : <span className="badge gray">미정산</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th colSpan={6} style={{ textAlign: 'right' }}>합계 <span className="muted">(월정산만)</span></th>
                      <th style={{ textAlign: 'right' }}>{won(extraSummary.total)}</th>
                      <th></th>
                    </tr>
                  </tfoot>
                </table>
              </div>

              <div className="section-title" style={{ marginTop: 16 }}>항목별 합계표</div>
              <div className="table-wrap">
                <table className="table extra-charge-summary-table">
                  <thead><tr><th style={{ width: 140 }}>항목</th><th style={{ width: 100, textAlign: 'right' }}>건수</th><th style={{ textAlign: 'right' }}>금액</th></tr></thead>
                  <tbody>
                    {/* 건수가 0인 항목도 줄을 남긴다 — 빠진 항목이 있는지 표에서 바로 보이게 한다. */}
                    {extraChargeTypes.map((t) => (
                      <tr key={t}>
                        <td>{t}</td>
                        <td style={{ textAlign: 'right' }}>{(extraSummary.byType[t] || {}).count || 0}건</td>
                        <td style={{ textAlign: 'right' }}>{won((extraSummary.byType[t] || {}).amount || 0)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <th>합계</th>
                      <th style={{ textAlign: 'right' }}>{extraSummary.count}건</th>
                      <th style={{ textAlign: 'right' }}>{won(extraSummary.total)}</th>
                    </tr>
                  </tfoot>
                </table>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="section-title">💰 금액 통계</div>
          <div className="table-wrap">
            <table className="table stat-table">
              <tbody>
                <tr className="stat-group"><th>운행요금</th><td>{won(summary.total)}</td></tr>
                <tr className="stat-sub"><th>└ 구간요금</th><td>{won(summary.base)}</td></tr>
                <tr className="stat-sub"><th>└ 할증요금</th><td>{won(summary.surcharge)}</td></tr>
                <tr className="stat-sub"><th>└ 대기요금</th><td>{won(summary.wait)}</td></tr>
                <tr className="stat-sub"><th>└ 취소요금</th><td>{won(summary.cancel)}</td></tr>

                <tr className="stat-group"><th>기타 정산</th><td>{won(extraSummary.total)}</td></tr>
                {extraChargeTypes.map((t) => {
                  const v = extraSummary.byType[t] || { count: 0, amount: 0 };
                  return <tr className="stat-sub" key={t}><th>└ 기타정산({t})</th><td>{won(v.amount)}</td></tr>;
                })}

                <tr><th>완료 건수</th><td>{summary.count.toLocaleString('ko-KR')}건</td></tr>
                <tr><th>건당 평균 <span className="muted">(운행요금)</span></th><td>{won(summary.count ? Math.round(summary.total / summary.count) : 0)}</td></tr>
              </tbody>
              <tfoot>
                {/* 청구서에 찍힐 금액이라 다른 숫자보다 눈에 띄어야 한다. */}
                <tr className="stat-total"><th>총 청구액</th><td>{won(grandTotal)}</td></tr>
              </tfoot>
            </table>
          </div>

          {/* 월정산과 개별정산은 청구 시점이 달라 입금도 따로 들어온다 — 나눠 보여야 대사가 된다. */}
          <p className="page-sub" style={{ marginBottom: 0 }}>
            기타 정산 내 <b>월정산 {won(extraSummary.byMode.monthly.amount)}</b>({extraSummary.byMode.monthly.count}건)
            — 위 총 청구액에 포함됩니다.<br />
            <b>개별정산 {won(extraSummary.byMode.individual.amount)}</b>({extraSummary.byMode.individual.count}건)
            — <b>총 청구액에 포함되지 않습니다.</b> 건별 청구서로 따로 청구합니다.
          </p>
        </div>

        {/* 선택한 줄 처리 — 목록 아래에 둔다. 위에 두면 무엇을 고른 뒤 누르는지 순서가 어긋난다. */}
        <div className="card">
          <div className="section-title">✅ 선택 항목 정산 처리</div>
          <p className="page-sub">
            위 목록에서 체크한 줄을 한 번에 바꿉니다. 정산완료로 바꾸면 <b>처리 시각과 담당자 계정</b>이 기록됩니다.
            운행요금 <b>{summary.settledCount}/{summary.count}건</b> ·
            기타정산 <b>{extraSummary.settledCount}/{extraSummary.count}건</b> 완료.
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn" type="submit" form="settleForm" name="action" value="settle">선택 항목 정산완료</button>
            {/* 잘못 누른 것을 되돌릴 길이 없으면 아무도 안 쓴다. */}
            <button className="btn secondary" type="submit" form="settleForm" name="action" value="unsettle">선택 항목 미정산으로</button>
            <IndividualPrintButton groupId={group.id} month={month} />
          </div>
          <p className="page-sub" style={{ marginBottom: 0 }}>
            건별 청구서는 <b>기타 정산 중 개별정산 항목</b>만 뽑습니다({extraSummary.byMode.individual.count}건).
            체크한 것이 있으면 그것만, 없으면 이 달의 개별정산 전부를 한 문서에 건별로 담습니다.
          </p>
        </div>
      </GroupSettingsShell>
    </AppShell>
  );
}
