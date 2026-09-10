'use client';

import { useState } from 'react';

// 탁송 특화 할증 + 부대비용(실비) 설정 — views/partials/fare_surcharge_settings.ejs의 판.
//
// 지사·법인 요금 화면이 같은 부품을 쓴다. 한쪽에만 항목을 늘리면 그 화면으로 저장할 때
// 다른 쪽 설정이 조용히 지워진다.
//
// 클라이언트인 이유: 장소 할증·특수 구간의 행 추가/삭제. **마지막 행을 복제하지 않고 빈 행을
// 만든다** — 복제하면 앞 행의 값이 딸려와, 관리자가 지우는 걸 잊으면 의도치 않은 할증이 하나
// 더 저장된다(EJS도 같은 이유로 빈 행을 만든다).
let seq = 0;
const newKey = () => `new-${++seq}`;

function KeywordRows({ rows, setRows, nameKey, feeKey, placeholder, feeMax, feeStep, listId, warnZeroFee }) {
  return (
    <>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th style={{ width: '55%' }}>{listId ? '구간·교량명' : '포함 장소(낱말)'}</th>
              <th style={{ width: '30%' }}>{listId ? '기본 통행료(원)' : '할증 금액(원)'}</th>
              <th style={{ width: '15%' }}></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.__key}>
                <td>
                  <input type="text" name={nameKey} defaultValue={r.name || ''} placeholder={placeholder}
                    list={listId || undefined} />
                </td>
                <td>
                  <input type="number" name={feeKey} defaultValue={r.fee || 0} min={0} max={feeMax} step={feeStep} placeholder="0" />
                  {/* 이름만 등록하고 금액이 0이면 이름은 걸리는데 청구 줄이 안 만들어진다 —
                      화면에는 등록돼 있으니 설정한 사람은 청구되는 줄 안다. */}
                  {warnZeroFee && !Number(r.fee) && (
                    <div className="page-sub" style={{ color: '#b45309' }}>금액이 0이라 <b>청구되지 않습니다</b></div>
                  )}
                </td>
                <td>
                  <button type="button" className="btn small secondary"
                    onClick={() => setRows(rows.filter((x) => x.__key !== r.__key))}>삭제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" className="btn small secondary" style={{ marginTop: 8 }}
        onClick={() => setRows([...rows, { __key: newKey(), name: '', fee: 0 }])}>
        + {listId ? '구간' : '장소'} 추가
      </button>
    </>
  );
}

export default function FareSurchargeSettings({
  extra, placeRules, tollRules, extraCostItems, extraCostModes,
  specialTollPresets, surchargeMin, surchargeMax, largeCarModels, largeCarFees,
}) {
  const [places, setPlaces] = useState(
    (placeRules || []).map((p, i) => ({ __key: `p${i}`, name: p.keyword, fee: p.fee }))
  );
  const [tolls, setTolls] = useState(
    (tollRules || []).map((t, i) => ({ __key: `t${i}`, name: t.name, fee: t.fee }))
  );

  const feeHint = `0이면 안 받음 · 받으려면 ${surchargeMin.toLocaleString('ko-KR')}~${surchargeMax.toLocaleString('ko-KR')}원`;
  const feeProps = { min: 0, max: surchargeMax, step: 1000, placeholder: '0' };
  const feeByModel = {};
  (largeCarFees || []).forEach((r) => { feeByModel[String(r.vehicle_model_id)] = r.fee; });
  const presetCount = (specialTollPresets || []).reduce((a, g) => a + g.names.length, 0);

  return (
    <>
      <div className="card">
        <div className="section-title">🚗 탁송 특화 할증</div>
        <p className="page-sub" style={{ marginTop: -4 }}>
          거리 구간요금에 <b>더해지는</b> 정액입니다. 각 항목 <b>0</b>이면 그 할증을 받지 않습니다.
          금액은 {surchargeMin.toLocaleString('ko-KR')}~{surchargeMax.toLocaleString('ko-KR')}원 사이로 입력하세요.
        </p>

        <div className="section-title" style={{ fontSize: 14, marginTop: 14 }}>차량 제원 — 차종 등록 정보로 자동 판정</div>
        <div className="row">
          <div className="field">
            <label>수입차 할증(원)</label>
            <input type="number" name="imported_car_fee" defaultValue={extra.imported_car_fee || 0} {...feeProps} />
            <p className="page-sub">차종의 브랜드가 <b>수입</b>으로 등록된 경우. {feeHint}</p>
          </div>
          <div className="field">
            <label>대형/화물 할증 — 기본 금액(원)</label>
            <input type="number" name="large_car_fee" defaultValue={extra.large_car_fee || 0} {...feeProps} />
            <p className="page-sub">RV(카니발·스타리아)·대형 세단·1톤 화물 등. 아래 차종별 금액이 없을 때 쓰입니다. {feeHint}</p>
          </div>
          <div className="field">
            <label>전기차 할증(원)</label>
            <input type="number" name="ev_fee" defaultValue={extra.ev_fee || 0} {...feeProps} />
            <p className="page-sub">차종이 <b>전기차</b>로 등록된 경우. {feeHint}</p>
          </div>
        </div>
        <p className="page-sub">
          세 항목은 <a href="/vehicle-models">차종 관리</a>에 등록된 판정값(수입/대형·화물/전기)으로 자동 적용됩니다.
          자동 판정이 틀린 차종은 그 화면에서 고치면 이후 접수부터 반영됩니다.
        </p>

        {/* 저장된 행만 그리면 처음 여는 화면에서 표가 통째로 비어 보인다. 관리자가 보고 싶은
            것은 "등록된 대형 차종 목록"이므로 차종을 한 줄씩 모두 깔고 금액만 채우게 한다. */}
        <div className="section-title" style={{ fontSize: 14, marginTop: 18 }}>대형/화물 — 차종별 금액</div>
        <p className="page-sub" style={{ marginTop: -4 }}>
          차종마다 부담이 달라(RV 카니발 vs 1톤 화물 탑차) 금액을 따로 정할 수 있습니다.
          <b>비워두면</b> 위 기본 금액을 쓰고, <b>0</b>을 넣으면 그 차종만 대형 할증을 받지 않습니다.
        </p>
        {!(largeCarModels || []).length ? (
          <>
            {/* 대형이 아닌 차종은 일부러 목록에서 뺀다 — 금액을 걸어도 판정이 false라 영영
                적용되지 않는데, 화면에 있으면 설정했다고 착각한다. */}
            <p className="page-sub" style={{ marginBottom: 8 }}>
              <b>대형/화물</b>로 등록된 차종이 아직 없습니다.
              차종을 등록하고 <b>대형/화물</b>에 체크하면 여기에 나옵니다.
            </p>
            <a className="btn secondary" href="/vehicle-models" target="_blank" rel="noopener noreferrer">🚘 차종 관리 열기</a>
          </>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th style={{ width: '60%' }}>차종</th><th style={{ width: '40%' }}>할증 금액(원)</th></tr></thead>
                <tbody>
                  {largeCarModels.map((m) => {
                    const saved = feeByModel[String(m.id)];
                    return (
                      <tr key={m.id}>
                        <td>
                          <input type="hidden" name="large_model_id" value={m.id} />
                          {m.name}
                        </td>
                        <td>
                          {/* 값이 없으면 빈 칸이어야 한다 — 0을 넣어두면 "안 받음"으로 저장돼 뜻이 뒤집힌다. */}
                          <input type="number" name="large_model_fee" defaultValue={saved === undefined ? '' : saved}
                            min={0} max={surchargeMax} step={1000} placeholder="기본 금액 사용" />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="page-sub" style={{ marginBottom: 8 }}>
              <b>대형/화물</b>로 등록한 차종이 모두 나옵니다 (현재 {largeCarModels.length}건).
            </p>
            <a className="btn secondary" href="/vehicle-models" target="_blank" rel="noopener noreferrer">🚘 차종 관리 열기</a>
          </>
        )}

        <div className="section-title" style={{ fontSize: 14, marginTop: 18 }}>환경 / 지역</div>
        <div className="row">
          <div className="field">
            <label>야간/조조 할증(원)</label>
            <input type="number" name="night_fee" defaultValue={extra.night_fee || 0} {...feeProps} />
            <p className="page-sub">예약·출발 시각이 아래 시간대에 들면 붙습니다. {feeHint}</p>
          </div>
          <div className="field">
            <label>야간 시간대</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="time" name="night_start_hm" defaultValue={extra.night_start_hm || '22:00'} />
              <span>~</span>
              <input type="time" name="night_end_hm" defaultValue={extra.night_end_hm || '01:00'} />
            </div>
            <p className="page-sub">자정을 넘겨도 됩니다(예: 22:00~01:00).</p>
          </div>
          <div className="field">
            <label>조조 시간대</label>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="time" name="early_start_hm" defaultValue={extra.early_start_hm || '06:00'} />
              <span>~</span>
              <input type="time" name="early_end_hm" defaultValue={extra.early_end_hm || '09:00'} />
            </div>
            <p className="page-sub">두 시간대 중 하나에만 들어도 한 번 붙습니다.</p>
          </div>
        </div>

        <div className="row">
          <div className="field">
            <label>오지 지역 할증(원)</label>
            <input type="number" name="remote_area_fee" defaultValue={extra.remote_area_fee || 0} {...feeProps} />
            <p className="page-sub">출발지나 도착지가 오지일 때. 양쪽 다여도 한 번만 붙습니다. {feeHint}</p>
          </div>
          <div className="field">
            <label>오지 판정 범위</label>
            <select name="remote_area_scope" defaultValue={extra.remote_area_scope || 'ri'}>
              <option value="ri">리 만</option>
              <option value="ri_eup_myeon">리 · 읍 · 면</option>
            </select>
            <p className="page-sub">행정지명이 이 글자로 끝나면 오지로 봅니다. 도로명(로/길)과 행정동(동)은 해당하지 않습니다.</p>
          </div>
        </div>

        <div className="section-title" style={{ fontSize: 14, marginTop: 18 }}>목적지 장소 할증</div>
        <p className="page-sub" style={{ marginTop: -4 }}>
          <b>목적지 주소</b>에 아래 낱말이 들어가면 그 금액을 더합니다(예: <b>유원지</b>).
          여러 개가 걸리면 <b>가장 비싼 것 하나만</b> 붙습니다.
        </p>
        <KeywordRows rows={places} setRows={setPlaces} nameKey="place_keyword" feeKey="place_fee"
          placeholder="예: 유원지" feeMax={surchargeMax} feeStep={1000} />
      </div>

      <div className="card">
        <div className="section-title">🧾 부대비용 및 실비 정산</div>
        <p className="page-sub" style={{ marginTop: -4 }}>
          <b>포함</b>이면 기본 탁송료에 들어 있어 <b>따로 청구할 수 없습니다</b>.
          제외는 청구 시점으로 갈립니다 — <b>월정산</b>은 월 정산서에 모아 청구하고,
          <b>개별정산</b>은 건별로 따로 청구합니다. 정산내역에서 두 가지를 나눠 보여줍니다.
        </p>
        <div className="row">
          {(extraCostItems || []).map((item) => (
            <div className="field" key={item.modeKey}>
              <label>{item.label}</label>
              {/* 값을 새 컬럼(*_mode)에 저장한다. 옛 컬럼(*_included)은 그대로 두고 읽기
                  폴백으로만 쓴다 — 값을 옮기는 마이그레이션은 되돌리기 어렵다. */}
              <select name={item.modeKey} defaultValue={item.mode}>
                {(extraCostModes || []).map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
              <p className="page-sub">정산 항목명: <b>기타정산({item.chargeType})</b></p>
            </div>
          ))}
        </div>

        <div className="section-title" style={{ fontSize: 14, marginTop: 18 }}>특수 구간(민자 교량 등)</div>
        <p className="page-sub" style={{ marginTop: -4 }}>
          등록한 이름이 경로에 나오면 <b>특수 구간 통행료를 &ldquo;제외&rdquo;로 둔 경우에 한해</b>
          {' '}실비 항목이 자동으로 잡힙니다. 금액은 기본값이며 실제 영수증 금액으로 고칠 수 있습니다.
        </p>
        {/* 판정이 부분일치라 표기가 조금만 달라도 안 걸린다 — 실측: 카카오는 "영종대교휴게소"
            처럼 뒤에 말을 붙여 주므로 등록명이 "영종대교"여야 걸리고 "영종 대교"처럼 띄면
            안 걸린다. 목록에서 고르면 그 오차가 사라진다. 금액은 프리셋에 넣지 않는다 —
            확인하지 못한 값을 기본값으로 심으면 그대로 청구된다. */}
        <datalist id="specialTollPresets">
          {(specialTollPresets || []).flatMap((g) => g.names.map((n) => (
            <option value={n} key={`${g.group}-${n}`}>{g.group}</option>
          )))}
        </datalist>
        <p className="page-sub">
          이름 칸을 누르면 <b>자주 쓰는 구간 목록</b>이 뜹니다({presetCount}곳).
          판정은 <b>이름이 들어 있는지</b>로 하므로 목록에서 고르면 표기 차이로 빗나가지 않습니다.
          <b>금액은 계약·영수증 기준으로 직접 넣어주세요</b> — 통행료는 차종·시간대에 따라 달라 미리 채워두지 않았습니다.
        </p>
        <KeywordRows rows={tolls} setRows={setTolls} nameKey="toll_name" feeKey="toll_fee"
          placeholder="예: 인천대교" feeStep={100} listId="specialTollPresets" warnZeroFee />
      </div>
    </>
  );
}
