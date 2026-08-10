// 카카오 상담톡 접수 폼 파서 — "탁송 상담톡 챗봇 고도화 기획서" 5.3절(접수 슬롯 스키마).
//
// lib/aiIntakeParser.js(웹 AI 접수 화면)와 왜 따로 두는가: 그쪽은 "출: / 도:" 처럼 줄 앞머리에
// 표시어가 붙는 한 줄 단위 포맷을 읽는데, 카카오로 들어오는 실제 폼은 `[출발지]` 로 시작하는
// **블록** 포맷이라 줄 파서로는 한 줄도 잡히지 않는다(ORIGIN_PREFIX_RE가 '['에서 막힌다).
// 상담톡 로그 2년치(요청 1,206건) 분석 결과 고객 메시지의 47%가 이 블록 폼이고, 그중 97%는
// 아래 규칙만으로 필수 4종(출발지·도착지·차량번호·일시)이 전부 추출된다 — LLM을 태우지 않는
// 이유가 이것이다. 폼이 아닌 자유 문장은 matched:false로 돌려주고 호출부가 LLM 폴백으로 넘긴다.
const { kstNow, toDateStr } = require('./period');
// 필드 이름·질문 문구는 웹 접수 화면과 같은 정의를 쓴다(lib/intakeFields.js).
const { shortLabelsFor, exampleFor } = require('./intakeFields');

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
// 상호·거점 힌트. "사당역"처럼 지명 자체가 짧은 경우를 위해 역/공항/나들목도 넣는다 —
// 이게 없으면 3글자 지명이 점수를 못 받아 주소 후보에서 통째로 밀려난다.
const PLACE_HINT_RE = /(모터리움|서비스센터|사업소|대리점|오토옥션|아파트|공장|센터|지점|영업소|주차장|휴게소|터미널|[가-힣]{2,}역(?![가-힣])|[가-힣]{2,}공항(?![가-힣])|나들목|IC(?![A-Za-z]))/;

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
// 날짜·시각만 적힌 줄("내일 오후2시", "8/9 14:00", "즉시")은 주소가 될 수 없다.
const DATETIME_ONLY_RE = /^(즉시|오늘|내일|모레|오전|오후|새벽|아침|저녁|밤|[\d\s:~월일시분()요\/.\-]|[월화수목금토일])+$/;

function pickAddress(lines, usedLines) {
  const used = usedLines || new Set();
  let best = null;
  let bestScore = 0;
  let fallback = null;
  for (const raw of lines) {
    let line = stripLabel(raw);
    if (!line) continue;
    // 이미 일시로 쓴 줄은 주소 후보가 아니다(stripLabel 전후 양쪽으로 비교한다).
    if (used.has(line) || used.has(String(raw).trim())) continue;
    if (DATETIME_ONLY_RE.test(line)) continue;
    // 전화번호/차량번호를 지우고 나면 그게 담겨 있던 괄호가 빈 채로("...2089 ()") 남거나,
    // 괄호 안 다른 내용과 이어 붙던 구분자만("경비실, ") 남는다 — 실제 접수 데이터에
    // "()"가 그대로 주소에 박혀 등록됐다(도로명주소+연락처를 한 괄호에 같이 적는 폼이 실제로
    // 흔하다). 그 잔여물만 걷어내고, 전화번호 없이 원래 있던 괄호 내용("(1층 주차장)" 등)은
    // 그대로 둔다.
    line = line.replace(PHONE_RE_GLOBAL, '').replace(PLATE_RE_GLOBAL, '')
      .replace(/\(\s*,\s*/g, '(')
      .replace(/,\s*\)/g, ')')
      .replace(/\(\s+/g, '(')
      .replace(/\(\s*\)/g, '')
      .replace(/\s{2,}/g, ' ').trim();
    line = line.replace(/^[,.\-/]+|[,.\-/]+$/g, '').trim();
    // 2자까지 허용한다 — "사당역"(3자)처럼 짧은 지명이 실제로 온다. 예전 기준(4자)에서는
    // 그런 폼의 주소가 통째로 버려지고 엉뚱한 줄이 대신 뽑혔다.
    if (line.length < 2) continue;
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
  // 폴백 최소 길이는 3자 — 일시·전화 줄은 위에서 이미 걸러졌으므로 짧아도 지명일 가능성이 높다.
  return fallback && fallback.length >= 3 ? fallback : null;
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

  // 일시를 먼저 잡는다 — 그 줄을 주소 후보에서 빼야 하기 때문이다. 예전에는 순서가 반대라
  // "내일 오후2시"가 출발지 주소로 뽑히고 정작 "사당역"은 버려졌다(3글자라 길이 필터에 걸림).
  // 일시는 출발지 블록에 적히는 게 원칙이지만, 헤더에 "8/7(금) 즉시~"만 쓰거나 폼 맨 끝에
  // "＊탁송요청시간 : 13:30"으로 붙이는 변형이 있어 헤더 → 도착지 블록 순으로 더 훑는다.
  const when = pickWhen(originLines) || pickWhen(blocks.head.split('\n')) || pickWhen(destLines) || null;
  const usedLines = new Set([when && when.raw].filter(Boolean));

  const originAddress = pickAddress(originLines, usedLines);
  const destAddress = pickAddress(destLines, usedLines);
  const originContact = pickContact(blocks.origin);
  const destContact = pickContact(blocks.dest);

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
//
// 항목 이름은 웹 접수 화면과 같은 정의(lib/intakeFields.js)에서 가져온다 — 예전에는 여기에
// 별도 목록이 있어서, 문구를 고칠 때 브라우저 쪽 REQUIRED_FIELDS와 갈라지기 쉬웠다.
// 파서가 쓰는 'when'만 필드 id(reserved_date)와 이름이 달라 여기서 이어준다.
const MISSING_TO_FIELD_ID = { when: 'reserved_date' };

function missingLabel(key, fields) {
  const labels = shortLabelsFor([MISSING_TO_FIELD_ID[key] || key], fields);
  return labels[0] || null;
}

// 항목 이름 뒤에 조사를 붙이면 받침 유무를 따져야 하고("차량번호를", "출발지 주소를"),
// 항목이 여러 개일 때 문장이 더 어색해진다. 조사 없이 항목만 나열하는 형태로 피한다.
//
// parsed를 함께 넘기면 **지금까지 알아들은 내용**을 위에 붙인다. 이게 없으면 고객은 자기가
// 말한 출발지·도착지가 제대로 전달됐는지 알 수 없어, 차량번호만 답하면 되는데도 처음부터
// 다시 쓰게 된다. 잘못 알아들었을 때 그 자리에서 바로잡을 수 있는 효과가 더 크다.
// addressPreview를 함께 넘기면 주소검색 결과까지 보여준다(lib/intakeAddressPreview.js).
function buildMissingQuestion(missing, parsed, addressPreview, fields) {
  const labels = (missing || []).map((key) => missingLabel(key, fields)).filter(Boolean);
  if (!labels.length) return null;

  // 항목 이름만으로는 어떤 형태로 답해야 할지 모르는 것들이 있다 — "차종 / 차량번호"를 한 줄에
  // 적어야 한다는 건 예시를 봐야 안다. 예시가 있는 항목만 뒤에 붙인다.
  const examples = (missing || [])
    .map((key) => exampleFor(MISSING_TO_FIELD_ID[key] || key, fields))
    .filter(Boolean);
  const exampleLine = examples.length ? `\n(예: ${examples.join(' / ')})` : '';

  const ask = `접수하려면 아래 항목이 더 필요합니다.\n· ${labels.join('\n· ')}\n알려주시면 바로 접수하겠습니다.${exampleLine}`;
  const known = describeKnownFields(parsed, addressPreview);
  return known ? `${known}\n\n${ask}` : ask;
}

// 되묻기 앞에 붙일 "확인된 내용" 요약. 아직 아무것도 못 잡았으면 null이라 문구가 그대로 나간다.
// 주소는 고객이 말한 표현 그대로 두되, 주소검색 결과가 다르면 괄호로 덧붙여 어디로 이해했는지
// 확인시킨다 — 엉뚱한 곳으로 기사가 가고 나서 드러나는 것보다 여기서 잡는 편이 훨씬 싸다.
function describeKnownFields(parsed, addressPreview) {
  if (!parsed) return null;
  const lines = [];
  const preview = addressPreview || {};
  const show = (value, side) => {
    const p = preview[side];
    if (!p || !p.found) return p && !p.found ? `${value} (주소 확인 필요)` : value;
    return p.resolved ? `${value} (${p.resolved})` : value;
  };
  if (parsed.origin && parsed.origin.address) lines.push(`· 출발 ${show(parsed.origin.address, 'origin')}`);
  if (parsed.destination && parsed.destination.address) lines.push(`· 도착 ${show(parsed.destination.address, 'destination')}`);
  if (parsed.vehicles && parsed.vehicles.length) {
    lines.push('· 차량 ' + parsed.vehicles.map((v) => [v.type, v.plate].filter(Boolean).join(' ')).join(', '));
  }
  if (parsed.when) {
    const when = parsed.when.immediate
      ? '즉시'
      : [parsed.when.date, parsed.when.time].filter(Boolean).join(' ') || parsed.when.raw;
    if (when) lines.push(`· 일시 ${when}`);
  }
  if (!lines.length) return null;
  return `아래 내용으로 확인했습니다.\n${lines.join('\n')}`;
}

// ---- 자유 문장 접수(LLM 추출 결과) → 폼 파서와 같은 모양 ----
// 원래 routes/kakaoConsult.js 안에만 있었는데, 상담원 도우미(lib/agentAssist.js)도 같은 변환이
// 필요해져 여기로 옮겼다. 두 경로가 다른 변환을 쓰면 같은 문장이 경로에 따라 다른 오더가 된다.
// Gemini가 뽑은 필드를 블록 폼 파서(parseKakaoIntake)와 같은 모양으로 맞춘다 — 그래야
// completeIntake가 두 경로를 구분하지 않고 처리한다.
//
// 날짜/시간은 여기서 계산하지 않는다. hybridChat이 이미 "오늘=YYYY-MM-DD" 기준을 프롬프트로
// 받아 계산한 값(reservationDate/reservationTime)을 주므로 그대로 옮기고, 둘 다 없을 때만
// resolveReservation의 즉시 처리에 맡긴다(when.immediate).
function buildParsedFromClassified(classified, text) {
  // 정규화는 폼 파서 것을 그대로 쓴다 — 같은 원문이 경로에 따라 다른 값으로 등록되면 안 된다.
  const plates = [classified.originVehicleNumber, classified.waypointVehicleNumber]
    .map((v) => normalizePlate(v)).filter(Boolean);
  const vehicleType = String(classified.vehicleType || '').trim() || null;
  // 차량 1대 = 오더 1건(파서와 동일). 차종은 첫 대에만 붙인다 — 두 번째 차량의 차종은 별도 필드가 없다.
  const vehicles = plates.map((plate, i) => ({ plate, type: i === 0 ? vehicleType : null }));

  const date = String(classified.reservationDate || '').trim() || null;
  const time = String(classified.reservationTime || '').trim() || null;
  // 날짜/시간이 둘 다 없다고 곧바로 "즉시"로 단정하지 않는다. 폼 파서(pickWhen)는 원문에
  // "즉시"가 실제로 적혀 있을 때만 즉시로 본다(missing.push('when')도 같이 있다) — 그런데
  // 이 자유 문장 경로는 예전에 둘 다 없으면 무조건 즉시로 단정해서, "탁송접수하고 싶어"처럼
  // 일시를 아예 말하지 않은 메시지도 "일시: 즉시"로 확정돼버렸다(실사용 지적 — 물어본 적
  // 없는데 즉시 접수로 확정 표시됨). 명시적 "즉시"가 원문에 있을 때만 즉시로 보고, 그마저
  // 없으면 폼 파서와 똑같이 missing에 넣어 되묻는다.
  const explicitImmediate = /즉시/.test(text);
  const when = (date || time)
    ? { immediate: false, date, time, dateRolled: false, raw: [date, time].filter(Boolean).join(' ') }
    : (explicitImmediate ? { immediate: true, date: null, time: null, dateRolled: false, raw: null } : null);

  const join = (a, b) => [a, b].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;
  const originAddress = join(classified.originAddress, classified.originAddressDetail);
  const destAddress = join(classified.destinationAddress, classified.destinationAddressDetail);

  const missing = [];
  if (!originAddress) missing.push('origin_address');
  if (!destAddress) missing.push('destination_address');
  if (!vehicles.length) missing.push('vehicle_number');
  if (!when) missing.push('when');

  // 경유지와 왕복 복귀 정보. 접수를 두 건으로 나눌지 정하는 데 쓴다(lib/orderSplit.js) —
  // 날짜가 갈릴 때만 나뉘므로, 날짜를 말하지 않은 평범한 경유 운행은 그대로 한 건이다.
  const waypointAddress = join(classified.waypointAddress, null);
  const waypoints = waypointAddress ? [{
    address: waypointAddress,
    contact: normalizePhone(classified.waypointContact) || null,
    vehicleNumber: normalizePlate(classified.waypointVehicleNumber) || null,
    reservedDate: String(classified.waypointReservationDate || '').trim() || null,
    reservedTime: String(classified.waypointReservationTime || '').trim() || null,
  }] : [];

  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    // normalizePhone은 빈 값에 ''를 돌려주지만 폼 파서는 null을 넣는다 — 저장값을 맞춘다.
    origin: { address: originAddress, contact: normalizePhone(classified.originContact) || null },
    destination: { address: destAddress, contact: normalizePhone(classified.destinationContact) || null },
    // 폼 파서(parseKakaoIntake)와 같은 폴백 — when이 missing이라도 호출부가 parsed.when.xxx를
    // 조건 없이 읽는 곳(describeKnownFields 등)이 undefined에 걸리지 않게 한다.
    when: when || { immediate: false, date: null, dateRolled: false, time: null, raw: null },
    vehicles,
    waypoints,
    roundTrip: classified.tripType === 'round_trip',
    returnWhen: {
      date: String(classified.returnReservationDate || '').trim() || null,
      time: String(classified.returnReservationTime || '').trim() || null,
    },
    options: {},
    memo: String(classified.memo || '').trim() || null,
    raw: text,
  };
}

module.exports = { parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion, normalizePhone, normalizePlate };
