// 상담원 도우미 — 상담원이 응대 중인 세션에서 봇이 답변 초안을 만들어 "채택 대기"로 쌓는다.
//
// 왜 필요한가: 상담원이 붙으면 봇이 완전히 꺼지는데, 상담톡 로그 분석상 상담원 발화의 86%가
// 정형(접수 확인 17.2%, 배차 통보 6.1%, 사진 61.6%)이다. 즉 봇이 답을 이미 아는 구간에서
// 사람이 손으로 치고 있었다. 자동 발송은 오응대 위험 때문에 못 켜지만, 사람이 승인하는
// 초안이라면 그 위험이 없다.
//
// 설계 원칙 — **확신이 없으면 침묵한다.** 틀린 제안이 반복되면 상담원이 카드를 아예 안 보게
// 되고, 그 순간 이 기능은 죽는다. 그래서 근거가 분명한 두 종류만 만든다.
//   intake : 접수 폼이 파싱된 경우(룰 파서, 실사용 재생 98.2%) — 접수 확인 문구 + 접수장 슬롯
//   faq    : 지식베이스 유사도가 임계값을 넘은 경우 — 그 답변 원문
// 그 외(잡담·현장 조율·클레임)는 제안하지 않는다.
const { parseKakaoIntake, buildMissingQuestion } = require('./kakaoIntakeParser');
const { searchKnowledgeBase } = require('./knowledgeSearch');
const { resolveReservation } = require('./kakaoIntakeService');

// 봇이 직접 응대할 때보다 임계값을 높게 잡는다 — 상담원이 이미 보고 있는 화면이라, 애매한
// 제안은 도움이 아니라 소음이다.
const FAQ_THRESHOLD = 0.72;

// 접수 폼이 파싱됐을 때의 확인 문구. lib/kakaoIntakeService.js의 자동 접수 확인 메시지와
// 같은 정보를 담되, 아직 등록 전이라 접수번호가 없고 "확인해주시면 접수하겠다"는 톤이다.
function buildIntakeReply(parsed) {
  const reservation = resolveReservation(parsed.when);
  const lines = [];
  const vehicles = parsed.vehicles
    .map((v) => [v.type, v.plate].filter(Boolean).join(' '))
    .filter(Boolean);

  lines.push(vehicles.length > 1 ? `${vehicles.length}건 접수하겠습니다.` : '접수하겠습니다.');
  vehicles.forEach((v) => lines.push(`· ${v}`));
  lines.push(`· ${parsed.origin.address} → ${parsed.destination.address || '(도착지 미기재)'}`);
  lines.push(`· ${reservation.date} ${reservation.time}${reservation.immediate ? ' 즉시' : ''}`);

  const opts = [];
  if (parsed.options.insurance) opts.push('책임보험 가입');
  if (parsed.options.refuel) {
    opts.push(parsed.options.refuel.fuel
      ? `${parsed.options.refuel.fuel} ${parsed.options.refuel.amount ? (parsed.options.refuel.amount / 10000) + '만원' : ''} 주유`.trim()
      : '주유 요청');
  }
  if (parsed.options.documents) opts.push(parsed.options.documents);
  if (opts.length) lines.push(`· 옵션: ${opts.join(', ')}`);

  return lines.join('\n');
}

// 접수 폼 파싱 결과를 우측 접수장(IntakeMiniForm)이 그대로 쓰는 필드명으로 변환한다.
// routes/chat.js의 /sessions/:id/intake-order 응답 구조와 키를 맞춰야 폼이 알아본다.
function toIntakeFields(parsed) {
  const reservation = resolveReservation(parsed.when);
  const first = parsed.vehicles[0] || {};
  return {
    reserved_date: reservation.date,
    reserved_time: reservation.time,
    origin_address: parsed.origin.address || '',
    origin_contact: parsed.origin.contact || '',
    destination_address: parsed.destination.address || '',
    destination_contact: parsed.destination.contact || '',
    vehicle_number: first.plate || '',
    vehicle_type: first.type || '',
    memo_customer: buildIntakeMemo(parsed),
    // 폼에는 한 대만 채우고, 나머지는 상담원이 알 수 있게 메모로 남긴다(오더 N건 분해는
    // 자동 접수 경로에서만 한다 — 상담원 화면에서는 사람이 판단할 문제다).
    extra_vehicles: parsed.vehicles.slice(1).map((v) => [v.type, v.plate].filter(Boolean).join(' ')),
  };
}

function buildIntakeMemo(parsed) {
  const parts = [];
  const o = parsed.options || {};
  if (o.insurance) parts.push('책임보험 가입');
  if (o.refuel) parts.push(o.refuel.raw || '주유 요청');
  else if (o.fuelGauge) parts.push(`연료 ${o.fuelGauge}칸`);
  if (o.documents) parts.push(o.documents);
  if (o.releaseDate) parts.push(`출고일 ${o.releaseDate}`);
  if (parsed.memo) parts.push(parsed.memo);
  return parts.join(' / ').slice(0, 1000);
}

// 고객 메시지 하나에 대한 제안을 만든다. 만들 게 없으면 null(= 제안 없음).
async function buildSuggestion(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const parsed = parseKakaoIntake(raw);
  if (parsed.matched) {
    if (parsed.complete) {
      return {
        kind: 'intake',
        text: buildIntakeReply(parsed),
        intake: toIntakeFields(parsed),
      };
    }
    // 필수 항목이 빠진 폼 — 되묻는 문구를 초안으로 준다. 접수장에는 지금까지 파싱된 값만 채운다.
    const question = buildMissingQuestion(parsed.missing);
    if (question) {
      return {
        kind: 'intake',
        text: question,
        intake: toIntakeFields(parsed),
        missing: parsed.missing,
      };
    }
  }

  const matches = await searchKnowledgeBase(raw, { limit: 1, threshold: FAQ_THRESHOLD }).catch((e) => {
    console.error('상담원 도우미 FAQ 검색 실패:', e.message);
    return [];
  });
  if (matches.length && matches[0].answer) {
    return { kind: 'faq', text: matches[0].answer, intake: null };
  }

  return null;
}

module.exports = { buildSuggestion, buildIntakeReply, toIntakeFields, FAQ_THRESHOLD };
