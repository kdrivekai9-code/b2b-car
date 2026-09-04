'use client';

// 접수 단계 부대비용 — 도착지 아래, 경유지와 같은 "+ 추가" 방식.
//
// 왜 접수 때 받나: "주유 가득 채워서 갖다주세요", "손세차로" 는 접수할 때 정하는 일이다.
// 지금까지는 적을 칸이 없어 요청메모에 글로 들어갔고, 메모는 정산에 안 잡혀 청구가 샜다.
//
// 항목마다 확장 선택지가 다르다(주유/충전은 가득·금액, 세차는 자동·손세차). 선택지 정의는
// 서버(lib/extraCharges.js INTAKE_EXTRA_ITEMS)에서 통째로 받아 쓴다 — 화면에 또 적어두면
// 항목이 늘었을 때 한쪽만 바뀐다.

const MODE_HINT = {
  included: '기본요금에 포함 — 따로 청구하지 않습니다.',
  monthly: '월 정산서에 모아 청구합니다.',
  individual: '건별 청구서로 따로 청구합니다.',
};

export default function ExtraCostSection({
  config, defaults, rows, onChange,
  ferryAmount, onFerryAmount, ferryEditable,
  // 고객(client) 화면인가. 정산구분 칸을 그리지 않는다 — 청구 방식은 계약이고 요금설정이
  // 정한다. 서버도 고객이 보낸 정산구분을 무시한다(lib/extraCharges.js parseIntakeRows).
  forClient,
  // 요청사항에서 읽어낸 것(고객에게만, 읽기전용). 아직 확정이 아니다.
  memoExtras,
}) {
  const items = (config && config.items) || [];
  const modes = (config && config.modes) || [];
  if (!items.length) return null;

  const itemOf = (chargeType) => items.find((it) => it.chargeType === chargeType) || null;
  // 정산구분 기본값은 요금설정에서 온다(사용자 지시). 화면에서 바꿀 수 있지만, 아무것도
  // 안 건드리면 설정한 대로 청구된다.
  const defaultMode = (chargeType) => (defaults && defaults[chargeType])
    || (itemOf(chargeType) && itemOf(chargeType).defaultMode) || 'monthly';

  // 한 오더에 하나뿐인 항목(도선료)은 이미 들어가 있으면 다시 못 고르게 한다 — 금액 출처가
  // 컬럼 하나라 두 줄을 만들면 두 번 청구된다.
  const takenSingles = new Set(
    rows.filter((r) => { const it = itemOf(r.chargeType); return it && it.single; }).map((r) => r.chargeType)
  );

  const patch = (key, next) => onChange(rows.map((r) => (r.key === key ? { ...r, ...next } : r)));
  const remove = (key) => onChange(rows.filter((r) => r.key !== key));

  const add = () => {
    const first = items.find((it) => !it.single || !takenSingles.has(it.chargeType));
    if (!first) return;
    onChange(rows.concat({
      key: `xc-${Date.now()}-${rows.length}`,
      id: null,
      chargeType: first.chargeType,
      // 선택지가 있는 항목은 첫 번째를 기본으로 골라둔다 — 비워두면 "무엇을 하기로 한 건지"가
      // 없는 줄이 저장된다.
      optionCode: first.options.length ? first.options[0].value : '',
      amount: '',
      settleMode: defaultMode(first.chargeType),
    }));
  };

  // 항목을 바꾸면 확장 선택지도 그 항목의 것으로 갈아끼운다. 그대로 두면 세차비에 '가득'이
  // 남아 서버가 버리고, 사용자는 왜 빠졌는지 모른다.
  const changeType = (key, chargeType) => {
    const it = itemOf(chargeType);
    patch(key, {
      chargeType,
      optionCode: it && it.options.length ? it.options[0].value : '',
      settleMode: defaultMode(chargeType),
    });
  };

  return (
    <div className="extra-cost-block">
      <div className="section-title small" style={{ margin: '14px 0 6px' }}>부대비용</div>
      {!rows.length && (
        <p className="hint" style={{ margin: '0 0 8px' }}>
          {forClient
            ? '주유·충전·세차·주차를 접수할 때 미리 요청해 두실 수 있습니다. 금액은 주유 금액지정일 때만 넣습니다 — 나머지는 기사님 영수증으로 확정됩니다.'
            : '주유·충전·세차·주차·도선료를 접수할 때 미리 정해둘 수 있습니다. 금액은 주유 금액지정일 때만 넣습니다 — 나머지는 기사 영수증으로 확정됩니다. 정산구분은 요금설정 값이 기본으로 들어가며 여기서 바꿀 수 있습니다.'}
        </p>
      )}

      {rows.map((r) => {
        const it = itemOf(r.chargeType);
        if (!it) return null;
        // 금액칸을 언제 보여주나(사용자 확정 2026-09-02): 접수 때 금액을 정할 수 있는 항목만
        // 열고, 그중 주유비는 '금액지정'을 골랐을 때만 연다.
        //   · 주유비 + 금액지정 → 열림. "3만원어치 주유"는 고객이 정한 확정금액이다.
        //   · 주유비 + 가득     → 닫힘. 접수 때는 금액을 모른다.
        //   · 충전·세차·주차    → 닫힘. 금액이 확정되지 않는 실비다.
        //   · 도선료·대기·취소  → 열림(금액이 본질인 항목).
        // 칸이 열려 있으면 누군가 어림값을 넣고, 그 어림값이 영수증 없이 그대로 청구된다.
        // 서버도 같은 규칙으로 눌러둔다(lib/extraCharges.js parseIntakeRows).
        const showAmount = !!it.fixedAmount && (!it.amountOption || r.optionCode === it.amountOption);
        const isFerry = !!it.ferry;
        return (
          <div className="extra-cost-row" key={r.key}>
            <select aria-label="부대비용 항목" value={r.chargeType}
              onChange={(e) => changeType(r.key, e.target.value)}>
              {items.map((o) => (
                <option key={o.chargeType} value={o.chargeType}
                  disabled={o.single && o.chargeType !== r.chargeType && takenSingles.has(o.chargeType)}>
                  {o.label}
                </option>
              ))}
            </select>

            {!!it.options.length && (
              <select aria-label={`${it.label} 세부`} value={r.optionCode}
                onChange={(e) => patch(r.key, { optionCode: e.target.value })}>
                {it.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            )}

            {isFerry ? (
              // 도선료 금액은 경로탐색이 자동으로 채운다. 틀리거나 빠진 경우를 위해 고칠 수
              // 있게 하되(사용자 지시), 고객(client)에게는 읽기전용이다 — 청구 금액이다.
              <input type="number" min="0" step="100" aria-label="도선료 금액"
                value={ferryAmount === 0 || ferryAmount ? ferryAmount : ''}
                readOnly={!ferryEditable}
                title={ferryEditable ? '경로탐색이 채운 값입니다. 고치면 다시 계산해도 유지됩니다.' : '경로탐색이 자동 계산한 금액입니다.'}
                onChange={(e) => onFerryAmount(e.target.value)} />
            ) : showAmount ? (
              <input type="number" min="0" step="100"
                placeholder={it.noSettleMode ? '금액 직접 입력' : '금액(선택)'}
                aria-label={`${it.label} 금액`}
                value={r.amount} onChange={(e) => patch(r.key, { amount: e.target.value })} />
            ) : (
              <span className="hint extra-cost-amount-note">금액은 영수증 확인 후 입력</span>
            )}

            {/* 대기요금·취소요금은 실비가 아니라 운행요금이라 월/개별로 나눌 것이 없다 —
                고를 것 없는 칸을 그리면 무엇을 고르라는 건지 모른다. 대신 자동 계산 안내를 둔다. */}
            {forClient ? null : it.noSettleMode ? (
              <span className="hint extra-cost-hint" title={it.hint || ''}>{it.hint}</span>
            ) : (
              <select aria-label={`${it.label} 정산구분`} value={r.settleMode}
                title={MODE_HINT[r.settleMode] || ''}
                onChange={(e) => patch(r.key, { settleMode: e.target.value })}>
                {modes.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            )}

            <button type="button" className="btn small secondary" onClick={() => remove(r.key)}>삭제</button>
          </div>
        );
      })}

      <button type="button" className="btn small secondary add-waypoint-btn" onClick={add}
        disabled={rows.length >= 20}>+ 부대비용 추가</button>

      {/* 요청사항에서 읽어낸 것 — 위 목록과 **섞지 않는다.** 위는 고객이 직접 고른 것이고
          이쪽은 우리가 글에서 추측한 것이라, 섞으면 등록된 것으로 읽히고 관리자가 기각했을 때
          봤던 것이 사라진다. 없던 걸 보여줬다가 치우는 것이 처음부터 안 보여주는 것보다 나쁘다.

          그래도 보여주는 이유: 아무 반응이 없으면 고객은 우리가 알아들었는지 몰라 전화한다 —
          이 채널이 없애려는 바로 그 통화다. 근거 원문을 함께 두면 틀렸을 때 고객이 그 자리에서
          잡는다(3만원을 30만원으로 읽었는지는 관리자보다 고객이 더 잘 안다). */}
      {!!(memoExtras && memoExtras.length) && (
        <div className="memo-extra-echo">
          <div className="memo-extra-echo-head">
            요청사항에서 확인한 내용 <span className="memo-extra-echo-tag">확인 중</span>
          </div>
          <ul>
            {memoExtras.map((c, i) => (
              <li key={`${c.label}-${i}`}>
                <b>{c.label}</b>
                {c.amount > 0 ? ` ${Number(c.amount).toLocaleString('ko-KR')}원` : ''}
                {c.evidence ? <span className="memo-extra-echo-src"> — “{c.evidence}”</span> : null}
              </li>
            ))}
          </ul>
          <p className="hint" style={{ margin: '6px 0 0' }}>
            담당자 확인 후 확정됩니다. 다르게 이해된 부분이 있으면 알려주세요.
          </p>
        </div>
      )}
    </div>
  );
}
