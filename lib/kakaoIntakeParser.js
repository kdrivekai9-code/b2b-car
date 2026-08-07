// 카카오 상담톡 접수 폼 파서 — "탁송 상담톡 챗봇 고도화 기획서" 5.3절(접수 슬롯 스키마).
//
// lib/aiIntakeParser.js(웹 AI 접수 화면)와 왜 따로 두는가: 그쪽은 "출: / 도:" 처럼 줄 앞머리에
// 표시어가 붙는 한 줄 단위 포맷을 읽는데, 카카오로 들어오는 실제 폼은 `[출발지]` 로 시작하는
// **블록** 포맷이라 줄 파서로는 한 줄도 잡히지 않는다(ORIGIN_PREFIX_RE가 '['에서 막힌다).
// 상담톡 로그 2년치(요청 1,206건) 분석 결과 고객 메시지의 47%가 이 블록 폼이고, 그중 97%는
// 아래 규칙만으로 필수 4종(출발지·도착지·차량번호·일시)이 전부 추출된다 — LLM을 태우지 않는
// 이유가 이것이다. 폼이 아닌 자유 문장은 matched:false로 돌려주고 호출부가 LLM 폴백으로 넘긴다.
const { kstNow, toDateStr } = require('./period');

const PHONE_RE = /01[0-9][-\s]?\d{3,4}[-\s]?\d{4}/;
const PHONE_RE_GLOBAL = /01[0-9][-\s]?\d{3,4}[-\s]?\d{4}/g;
const PLATE_RE = /\d{2,3}\s?[가-힣]\s?\d{4}/;
const PLATE_RE_GLOBAL = /\d{2,3}\s?[가-힣]\s?\d{4}/g;

// 블록 구분자 — 실사용 로그에 나온 표기 전부. `[출발지]`가 압도적이고 `＊출발지 :`는 초기 폼,
// `출발지 :`는 라벨형 폼에서 쓰인다.
const ORIGIN_MARK_RE = /(?:^|\n)\s*(?:\[\s*출발지\s*\]|＊\s*출발지\s*[:：]?|출발지\s*[:：])/;
const DEST_MARK_RE = /(?:^|\n)\s*(?:\[\s*도착지\s*\d*\s*\]|＊\s*도착지\s*[:：]?|도착지\s*[:：])/;

// 주소로 볼 만한 줄인지 — 행정구역/도로명 흔적이 있거나, 로그에서 반복되는 거점 상호명이 있는 줄.
// ⚠ 여기서 \b(단어 경계)를 쓰면 안 된다 — JS의 \b는 [A-Za-z0-9_] 기준이라 한글 뒤에서는 절대
// 성립하지 않는다("수원시 " 의 시와 공백 사이에는 경계가 없다). 실제로 \b를 쓴 첫 버전은
// 실사용 폼 재생에서 도착지 주소를 79%밖에 못 잡았다. 대신 "뒤에 한글이 더 붙지 않을 것"을
// 전방탐색으로 확인한다.
const ADDRESS_HINT_RE = /(특별시|광역시|[가-힣]{2,}시(?![가-힣])|[가-힣]{2,}군(?![가-힣])|[가-힣]{2,}구(?![가-힣])|[가-힣]+로\s?\d*번?길|[가-힣]+대?로(?![가-힣])|[가-힣]{2,}길(?![가-힣])|[가-힣]{2,}동(?![가-힣])|[가-힣]{2,}읍(?![가-힣])|[가-힣]{2,}면(?![가-힣])|\d+-\d+|\d+번지)/;
const PLACE_HINT_RE = /(모터리움|서비스센터|사업소|대리점|오토옥션|아파트|공장|센터|지점|영업소|주차장|휴게소|터미널)/;

// 라벨형 폼("주소 : …", "연락처 : …")의 라벨. 값만 남기고 떼어낸다.
const LABEL_RE = /^(주소|위치|일시|일자|날짜|시간|출발시간|탁송요청시간|연락처|전화|담당자|차량번호|차량정보|차종|서류|비고|요청사항|메모)\s*[:：]\s*/;

const FUEL_WORDS = ['휘발유', '경유', 'LPG', 'lpg', '가솔린', '디젤', '전기'];

function stripLabel(line) {
  return line.replace(LABEL_RE, '').trim();
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  if (digits.length === 11) return digits.slice(0, 3) + '-' + digits.slice(3, 7) + '-' + digits.slice(7);
  if (digits.length === 10) return digits.slice(0, 3) + '-' + digits.slice(3, 6) + '-' + digits.slice(6);
  return String(raw || '').trim();
}

function normalizePlate(raw) {
  return String(raw || '').replace(/\s/g, '');
}

// 텍스트를 헤더 / 출발지 블록 / 도착지 블록으로 자른다. 도착지 표기가 없으면 dest는 빈 문자열이
// 되고, 그 경우 필수필드 미충족으로 되묻기 대상이 된다.
function splitBlocks(text) {
  const originMatch = text.match(ORIGIN_MARK_RE);
  if (!originMatch) return null;
  const originStart = originMatch.index + originMatch[0].length;
  const head = text.slice(0, originMatch.index);
  const rest = text.slice(originStart);

  const destMatch = rest.match(DEST_MARK_RE);
  if (!destMatch) return { head, origin: rest, dest: '' };
  return {
    head,
    origin: rest.slice(0, destMatch.index),
    dest: rest.slice(destMatch.index + destMatch[0].length),
  };
}

// "8/7(금)", "8월29일(목)", "2026-08-07" → YYYY-MM-DD.
// 연도가 폼에 안 적히므로(로그 전수에서 연도 표기 0건) 올해로 채우되, 그 결과가 60일 넘게
// 과거면 내년으로 넘긴다 — 12월 말에 "1/3" 같은 요청이 들어오는 경우를 위한 처리다.
function parseFormDate(text) {
  const now = kstNow();
  if (/오늘/.test(text)) return { date: toDateStr(now), rolled: false };
  if (/내일/.test(text)) return { date: toDateStr(new Date(now.getTime() + 86400000)), rolled: false };
  if (/모레/.test(text)) return { date: toDateStr(new Date(now.getTime() + 2 * 86400000)), rolled: false };

  const iso = text.match(/(\d{4})[-.](\d{1,2})[-.](\d{1,2})/);
  if (iso) return { date: `${iso[1]}-${String(iso[2]).padStart(2, '0')}-${String(iso[3]).padStart(2, '0')}`, rolled: false };

  let mm = null;
  let dd = null;
  const korean = text.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (korean) {
    mm = Number(korean[1]);
    dd = Number(korean[2]);
  } else {
    // "8/7(금)" / "8/7 (금)" / "8/7~" — 슬래시 뒤 요일 괄호나 물결이 흔하다.
    const slash = text.match(/(?:^|[^\d/])(\d{1,2})\s*\/\s*(\d{1,2})(?!\s*\/)(?!\d)/);
    if (slash) {
      mm = Number(slash[1]);
      dd = Number(slash[2]);
    } else {
      // "21일(수) 16시" — 월 없이 일자만 적는 폼도 실제로 들어온다. 이번 달로 보되 그 날이
      // 이미 지났으면 다음 달로 넘긴다(월 없이 과거 날짜를 지정할 이유가 없다).
      const dayOnly = text.match(/(?:^|[^\d])(\d{1,2})\s*일(?![가-힣])/);
      if (dayOnly) {
        dd = Number(dayOnly[1]);
        mm = now.getUTCMonth() + 1;
        if (dd < now.getUTCDate()) mm += 1;
        if (mm > 12) mm = 1;
      }
    }
  }
  if (!mm || !dd || mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;

  const year = now.getUTCFullYear();
  const candidate = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  // 과거로 계산되면 내년으로 넘긴다. 연말에 "1/3"이 들어오는 경우가 본래 목적이고, 그 외
  // (오타 등)에도 과거 날짜로 배차 오더를 만드는 것보다는 낫다. 다만 "3/21(금) 즉시~"처럼
  // **즉시**가 함께 적힌 폼은 날짜가 아니라 "지금"이 진짜 의도라, rolled 플래그를 함께 돌려주고
  // 호출부(resolveReservation)가 즉시 요청이면 오늘로 되돌린다.
  if (Date.parse(candidate + 'T00:00:00Z') < Date.parse(toDateStr(now) + 'T00:00:00Z')) {
    return { date: `${year + 1}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`, rolled: true };
  }
  return { date: candidate, rolled: false };
}

// "13:30 ~ 14:30"처럼 구간으로 적으면 앞 시각(도착 가능 시작 시각)을 쓴다 — 상담원도 그렇게 접수한다.
function parseFormTime(text) {
  const isPM = /오후|저녁|밤/.test(text);
  const isAM = /오전|새벽|아침/.test(text);

  const colon = text.match(/(\d{1,2})\s*:\s*(\d{2})/);
  if (colon) {
    let h = Number(colon[1]);
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${colon[2]}`;
  }
  const korean = text.match(/(\d{1,2})\s*시\s*(\d{1,2})?\s*분?/);
  if (korean) {
    let h = Number(korean[1]);
    if (isPM && h < 12) h += 12;
    if (isAM && h === 12) h = 0;
    const m = korean[2] ? String(korean[2]).padStart(2, '0') : '00';
    return `${String(h).padStart(2, '0')}:${m}`;
  }
  return null;
}

// 일시 줄 후보 — "즉시"이거나 날짜/시각 표기가 있는 줄. 주소 줄에도 숫자가 많아서(로59번길 4)
// 날짜로 오인하기 쉬우므로, 주소 힌트가 있는 줄은 후보에서 뺀다.
function pickWhen(lines) {
  for (const raw of lines) {
    const line = stripLabel(raw);
    if (!line) continue;
    if (ADDRESS_HINT_RE.test(line) && !/즉시/.test(line)) continue;
    const parsedDate = parseFormDate(line);
    if (/즉시/.test(line)) {
      return {
        immediate: true,
        date: parsedDate ? parsedDate.date : null,
        dateRolled: !!(parsedDate && parsedDate.rolled),
        time: parseFormTime(line),
        raw: line,
      };
    }
    const time = parseFormTime(line);
    if (parsedDate || time) {
      return {
        immediate: false,
        date: parsedDate ? parsedDate.date : null,
        dateRolled: !!(parsedDate && parsedDate.rolled),
        time,
        raw: line,
      };
    }
  }
  return null;
}

// 주소 줄 고르기 — 전화/차량번호를 지운 뒤 주소 힌트가 있는 줄 중 가장 정보량이 많은 줄.
// 로그에는 "서서울모터리움 8층 4번기둥 옆에 주차"처럼 주소 대신 거점명만 오는 경우도 있어
// 상호명 힌트(PLACE_HINT_RE)도 후보로 받는다.
function pickAddress(lines) {
  let best = null;
  let bestScore = 0;
  let fallback = null;
  for (const raw of lines) {
    let line = stripLabel(raw);
    if (!line) continue;
    line = line.replace(PHONE_RE_GLOBAL, '').replace(PLATE_RE_GLOBAL, '').replace(/\s{2,}/g, ' ').trim();
    line = line.replace(/^[,.\-/]+|[,.\-/]+$/g, '').trim();
    if (line.length < 4) continue;
    if (/^(즉시|일시|시간|연락처|담당자|서류|비고|요청사항|차량)/.test(line)) continue;
    // 일시/차량/옵션 줄이 주소 자리에 끼어드는 경우를 거른다 — 주소에는 요일 괄호나 "만원"이 없다.
    if (/\(\s*[월화수목금토일]\s*\)|만\s*원|현\s*\d\s*칸|출고일/.test(line)) continue;
    // 지시문("※ 회수서류 : … <서울 양천로 53길 30, …> 로 우편발송")은 그 안에 주소를 품고 있어
    // 길이 점수로는 진짜 주소를 이긴다. 실제로 이 줄이 도착지 주소로 뽑혀 지오코딩에 실패했다.
    // 지시문은 메모로만 남기고 주소 후보에서 뺀다.
    if (/^[※*]/.test(line) || /(회수|우편|발송|서명\s*받|기록부)/.test(line)) continue;

    let score = 0;
    if (ADDRESS_HINT_RE.test(line)) score += 10;
    if (PLACE_HINT_RE.test(line)) score += 6;
    if (/\d/.test(line)) score += 2;
    score += Math.min(line.length, 60) / 20;
    if (score > bestScore) {
      bestScore = score;
      best = line;
    }
    // 블록 안에 남는 줄이 하나뿐이면 그게 주소다 — 행정구역 표기가 없는 상호명만 적힌 폼
    // ("서서울모터리움 8층 4번기둥 옆")이 실제로 들어오기 때문에 점수 미달이어도 건진다.
    if (!fallback || line.length > fallback.length) fallback = line;
  }
  if (bestScore >= 6) return best;
  return fallback && fallback.length >= 6 ? fallback : null;
}

// 차량 — "렉스턴스포츠 814도5270" / "800서3157 / 렉스턴스포츠" 양쪽 어순이 다 쓰인다.
// 차종은 번호판 앞뒤 토큰에서 집어오되, 주소 줄에 섞인 번호판은 차량으로 보지 않는다.
function pickVehicles(text) {
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');
  for (const raw of lines) {
    const line = stripLabel(raw);
    if (!line) continue;
    if (ADDRESS_HINT_RE.test(line) && !/차량|차종/.test(line)) continue;
    const plates = line.match(PLATE_RE_GLOBAL);
    if (!plates) continue;
    for (const p of plates) {
      const plate = normalizePlate(p);
      if (seen.has(plate)) continue;
      seen.add(plate);

      const idx = line.indexOf(p);
      const before = line.slice(0, idx).replace(LABEL_RE, '').replace(/[\/,·]/g, ' ').trim();
      const after = line.slice(idx + p.length).replace(/[\/,·]/g, ' ').trim();
      const beforeToken = before.split(/\s+/).filter(Boolean).pop() || '';
      const afterToken = after.split(/\s+/).filter(Boolean).shift() || '';
      const pick = (t) => (/^[A-Za-z0-9가-힣]{2,12}$/.test(t) && !/^\d+$/.test(t) && !/(대|건|번)$/.test(t) ? t : null);
      out.push({ plate, type: pick(beforeToken) || pick(afterToken) || null });
    }
  }
  return out;
}

function pickContact(text) {
  const m = text.match(PHONE_RE);
  return m ? normalizePhone(m[0]) : null;
}

// 옵션 — 기획서 5.3의 "이 거래처의 옵션 스키마". 접수 폼의 16~29%에 반복해서 붙는 것들만 본다.
function pickOptions(fullText) {
  const options = { insurance: false, refuel: null, fuelGauge: null, documents: null, releaseDate: null };

  if (/(책임보험|보험\s*가입)/.test(fullText)) options.insurance = true;

  const refuelLine = fullText.split('\n').find((l) => /주유/.test(l));
  if (refuelLine) {
    const fuel = FUEL_WORDS.find((w) => refuelLine.includes(w)) || null;
    const amount = refuelLine.match(/(\d+(?:\.\d+)?)\s*만\s*원/) || refuelLine.match(/([\d,]{4,})\s*원/);
    options.refuel = {
      fuel,
      amount: amount ? (amount[0].includes('만') ? Number(amount[1]) * 10000 : Number(amount[1].replace(/,/g, ''))) : null,
      raw: refuelLine.trim(),
    };
  }

  const gauge = fullText.match(/현\s*(\d)\s*칸/);
  if (gauge) options.fuelGauge = Number(gauge[1]);

  const docLine = fullText.split('\n').find((l) => /(서류|등록증|인감|위임장|서명사실)/.test(l));
  if (docLine) options.documents = stripLabel(docLine).trim();

  const release = fullText.match(/출고일\s*[:：]?\s*([\d.\-/]{4,10})/);
  if (release) options.releaseDate = release[1];

  return options;
}

// 현장 지시(“도착 후 연락 주세요”, “지하 주차”, “경비실에 키 전달”)는 기사에게 그대로 넘겨야
// 하는 정보라 버리지 않고 메모로 모은다. 주소/연락처/차량/일시로 이미 쓰인 줄은 뺀다.
function buildMemo(blocks, used) {
  const lines = [];
  for (const chunk of [blocks.head, blocks.origin, blocks.dest]) {
    for (const raw of String(chunk || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (used.some((u) => u && (line.includes(u) || u.includes(line)))) continue;
      if (PHONE_RE.test(line) || PLATE_RE.test(line)) continue;
      if (/^\[?(출발지|도착지|탁송요청)\]?/.test(line)) continue;
      if (/신청합니다|요청합니다/.test(line)) continue;
      // "1대", "차량정보 (3대)" 같은 대수 표기는 차량 배열로 이미 구조화돼 있어 메모에 넣지 않는다.
      if (/^(차량정보\s*)?\(?\s*\d+\s*대\s*\)?$/.test(line)) continue;
      lines.push(line);
    }
  }
  const memo = lines.join(' / ').replace(/\s{2,}/g, ' ').trim();
  return memo || null;
}

function parseKakaoIntake(rawText) {
  const text = String(rawText || '').replace(/\r/g, '');
  const blocks = splitBlocks(text);
  if (!blocks) return { matched: false, reason: 'no_origin_block' };

  const originLines = blocks.origin.split('\n');
  const destLines = blocks.dest.split('\n');

  const originAddress = pickAddress(originLines);
  const destAddress = pickAddress(destLines);
  const originContact = pickContact(blocks.origin);
  const destContact = pickContact(blocks.dest);

  // 일시는 출발지 블록에 적히는 게 원칙이지만, 헤더에 "8/7(금) 즉시~"만 쓰거나 폼 맨 끝에
  // "＊탁송요청시간 : 13:30"으로 붙이는 변형이 있어 헤더 → 도착지 블록 순으로 더 훑는다.
  const when = pickWhen(originLines) || pickWhen(blocks.head.split('\n')) || pickWhen(destLines) || null;

  // 차량은 출발지 블록에 오는 게 정상이고(로그 기준 대부분), 없으면 전체에서 찾는다.
  let vehicles = pickVehicles(blocks.origin);
  if (!vehicles.length) vehicles = pickVehicles(text);

  const options = pickOptions(text);
  // 옵션으로 이미 구조화한 줄(주유·서류·출고일·연료잔량)은 메모에서 뺀다 — 빼지 않으면
  // lib/kakaoIntakeService.js가 옵션과 메모를 합칠 때 같은 문장이 두 번 들어간다.
  const gaugeLine = options.fuelGauge
    ? text.split('\n').find((l) => /현\s*\d\s*칸/.test(l))
    : null;
  const memo = buildMemo(blocks, [
    originAddress,
    destAddress,
    when && when.raw,
    options.refuel && options.refuel.raw,
    options.documents,
    options.releaseDate,
    gaugeLine && gaugeLine.trim(),
  ]);

  const missing = [];
  if (!originAddress) missing.push('origin_address');
  if (!destAddress) missing.push('destination_address');
  if (!vehicles.length) missing.push('vehicle_number');
  if (!when) missing.push('when');

  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    origin: { address: originAddress, contact: originContact },
    destination: { address: destAddress, contact: destContact },
    when: when || { immediate: false, date: null, dateRolled: false, time: null, raw: null },
    vehicles,
    options,
    memo,
    raw: text,
  };
}

// 되묻기 문구 — 부족한 슬롯만 정확히 짚어 물어본다. 고객이 폼을 통째로 다시 쓰게 만들면
// 사람 상담원보다 못한 경험이 되므로, 빠진 항목만 한 줄로 묻는다.
const MISSING_PROMPTS = {
  origin_address: '출발지 주소',
  destination_address: '도착지 주소',
  vehicle_number: '차량번호',
  when: '탁송 일시(즉시 또는 시간)',
};

// 항목 이름 뒤에 조사를 붙이면 받침 유무를 따져야 하고("차량번호를", "출발지 주소를"),
// 항목이 여러 개일 때 문장이 더 어색해진다. 조사 없이 항목만 나열하는 형태로 피한다.
function buildMissingQuestion(missing) {
  const labels = (missing || []).map((m) => MISSING_PROMPTS[m]).filter(Boolean);
  if (!labels.length) return null;
  return `접수하려면 아래 항목이 더 필요합니다.\n· ${labels.join('\n· ')}\n알려주시면 바로 접수하겠습니다.`;
}

module.exports = { parseKakaoIntake, buildMissingQuestion, normalizePhone, normalizePlate };
