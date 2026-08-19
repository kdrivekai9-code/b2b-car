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
const { shortLabelsFor, exampleFor, getDailyDriverFields } = require('./intakeFields');
const { PLATE_CORE } = require('./vehicleInfo');

// 구분자는 하이픈 앞뒤로 공백이 붙는 경우가 실사용에 흔하다("010 - 2222 - 4264") — 예전엔
// 구분자를 한 글자만 허용해서(`[-\s]?`) 이 형식이 통째로 안 잡히고 memo로 흘러갔다(실측:
// [출발지]/[도착지] 블록에 각각 연락처가 있었는데도 둘 다 추출 실패). 공백을 여러 개, 하이픈은
// 있어도 없어도 되게 넓힌다.
// "즉시" 계열 표현 — 사용자 확정 규칙(2026-08-13): 즉시 외에 최대한빨리/현재/지금바로도
// 같은 뜻으로 본다. pickWhen(폼)·buildParsedFromClassified(자유문장) 양쪽이 같은 판단을
// 쓴다 — 채널 안에서도 폼이냐 자유문장이냐에 따라 "즉시"를 다르게 인식하면 안 된다.
const IMMEDIATE_WORDING_RE = /즉시|최대한\s*빨리|지금\s*바로|현재/;

const PHONE_RE = /01[0-9]\s*-?\s*\d{3,4}\s*-?\s*\d{4}/;
const PHONE_RE_GLOBAL = /01[0-9]\s*-?\s*\d{3,4}\s*-?\s*\d{4}/g;
// 번호판 — 지역명이 앞에 붙는 구형/영업용 번호판("경기35바5081")도 통째로 잡는다. 규칙과
// 그렇게 만든 이유(지역명 접두어를 아무 두 글자로 열면 안 되는 것)는 lib/vehicleInfo.js에
// 적어뒀다 — 차량번호를 다루는 곳이 접수 말고도 생겨서 그쪽으로 올렸다.
const PLATE_RE = new RegExp(PLATE_CORE);
const PLATE_RE_GLOBAL = new RegExp(PLATE_CORE, 'g');

// 블록 구분자 — 실사용 로그에 나온 표기 전부. `[출발지]`가 압도적이고 `＊출발지 :`는 초기 폼,
// `출발지 :`는 라벨형 폼에서 쓰인다.
//
// 여는 대괄호는 없어도 받는다(`\[?`) — 실사용 로그 재생에서 폼 인식 실패 15건 중 9건이
// `출발지]`처럼 여는 괄호만 빠진 오타였다. 고객이 `[`를 지우고 타이핑하는 습관이 굳어 있어
// (2024-10부터 2026-03까지 계속 재발) 오타로 보고 흘리기엔 빈도가 너무 높다.
//
// `■`·`*`도 블록 머리로 쓰인다(2024-05 초기 폼). 이 폼은 `■ 키수령지`/`■ 키반납지`처럼
// 출발지·도착지 말고 제3의 장소가 따로 있다 — 키를 받는 곳과 차가 있는 곳이 도보 10분 거리로
// 떨어져 있다. 아래 remapKeyPickup이 그걸 경로로 풀어낸다(사용자 확정 규칙).
const BLOCK_KINDS = '출발지|도착지|키수령지|키반납지';
const BLOCK_MARK_RE = new RegExp(
  `(?:^|\\n)\\s*(?:\\[?\\s*(${BLOCK_KINDS})\\s*\\d*\\s*\\]`
  + `|[＊*■]\\s*(${BLOCK_KINDS})\\s*[:：]?`
  + `|(${BLOCK_KINDS})\\s*[:：])`,
  'g'
);

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
// 글자 사이 공백을 허용한다(`주  소:`, `일  시:`, `차 량 번 호:`) — 칸을 맞추려고 라벨 안에
// 공백을 넣는 폼이 실사용에 있고(2026-03 매입탁송 폼), 그걸 못 떼면 라벨이 주소 값에 그대로
// 남아("주 소: 강원도 홍천군…") 지오코딩이 실패한다.
const LABEL_WORDS = ['주소', '위치', '일시', '일자', '날짜', '시간', '출발시간', '탁송요청시간',
  '연락처', '전화', '담당자', '차량번호', '차량정보', '차종', '서류', '비고', '요청사항', '메모'];
const LABEL_RE = new RegExp(
  '^(?:' + LABEL_WORDS.map((w) => w.split('').join(String.raw`\s*`)).join('|') + String.raw`)\s*[:：]\s*`
);

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

// 텍스트를 헤더 / 블록들로 자른다. 도착지 표기가 없으면 dest는 빈 문자열이 되고, 그 경우
// 필수필드 미충족으로 되묻기 대상이 된다.
//
// 블록 머리를 **전부 찾아 위치순으로** 자른다 — 예전에는 출발지를 찾고 그 뒤에서만 도착지를
// 찾았기 때문에, 도착지를 먼저 쓴 폼(실사용 로그 2024-05-23)에서 도착지 주소를 통째로 놓쳤다.
// 순서에 의존하지 않으면 그 폼도 그대로 처리된다.
function splitBlocks(text) {
  const marks = [];
  BLOCK_MARK_RE.lastIndex = 0;
  let m;
  while ((m = BLOCK_MARK_RE.exec(text))) {
    marks.push({ kind: m[1] || m[2] || m[3], start: m.index, end: m.index + m[0].length });
  }
  if (!marks.length) return null;

  // 각 블록의 본문은 다음 블록 머리 직전까지.
  // 같은 종류가 여러 번 나오면 **내용이 있는 첫 블록**을 쓴다 — `[도착지]` 바로 아래
  // `도착지]`가 한 번 더 붙는 폼이 실제로 있어(2025-10~11 매입탁송, 2025-01 등 5건),
  // 무조건 첫 블록을 쓰면 빈 블록을 골라 도착지 주소를 통째로 잃는다.
  const bodies = {};
  marks.forEach((mk, i) => {
    const body = text.slice(mk.end, i + 1 < marks.length ? marks[i + 1].start : text.length);
    const cur = bodies[mk.kind];
    if (cur === undefined || (!String(cur).trim() && String(body).trim())) bodies[mk.kind] = body;
  });

  // 출발지 블록이 없으면 이 폼으로 보지 않는다(기존과 동일 — 호출부가 LLM 폴백으로 넘긴다).
  if (bodies['출발지'] === undefined) return null;
  return {
    head: text.slice(0, marks[0].start),
    origin: bodies['출발지'],
    dest: bodies['도착지'] === undefined ? '' : bodies['도착지'],
    keyPickup: bodies['키수령지'] === undefined ? null : bodies['키수령지'],
    keyReturn: bodies['키반납지'] === undefined ? null : bodies['키반납지'],
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
    if (ADDRESS_HINT_RE.test(line) && !IMMEDIATE_WORDING_RE.test(line)) continue;
    const parsedDate = parseFormDate(line);
    if (IMMEDIATE_WORDING_RE.test(line)) {
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
const DATETIME_ONLY_RE = /^(즉시|최대한빨리|지금바로|현재|오늘|내일|모레|오전|오후|새벽|아침|저녁|밤|[\d\s:~월일시분()요\/.\-]|[월화수목금토일])+$/;

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
    // "이 줄은 차량 줄이다"는 판단은 **라벨을 떼기 전 원문**으로 해야 한다 — stripLabel이
    // "차량번호 :" 라벨을 이미 지워버려서, 정작 차량 줄임이 가장 분명한 라벨형 폼에서 이
    // 안전장치가 절대 작동하지 않았다. 그 결과 차종명이 우연히 주소 패턴과 겹치면
    // (예: "니로" → ADDRESS_HINT_RE의 `[가-힣]+대?로`) 번호판이 통째로 버려졌다
    // — 실사용 로그 재생에서 확인된 실패다("차량번호: 125다9044 니로").
    if (ADDRESS_HINT_RE.test(line) && !/차량|차종/.test(raw)) continue;
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

// 번호판을 적으려 한 흔적은 있는데 형식이 어긋난 경우 — "안 적었다"와 구분해서 되묻어야 한다.
// 실사용 로그에서 확인된 두 가지다(둘 다 나중에 상담원 사진 캡션으로 진짜 번호가 드러났다):
//   · "219누863"  → 실제 219누8363 (숫자 한 자리 누락)
//   · "8083692"   → 실제 808너3692 (한글 누락)
// 이때 "차량번호를 알려주세요"라고 물으면 고객은 이미 적었다고 생각해 혼란스럽다. 반면 차종만
// 적은 경우("차량번호 : 코란도")는 번호를 아예 안 준 것이라 원래 문구가 맞다 — 그래서 숫자가
// 섞인 흔적이 있을 때만 형식 안내로 바꾼다.
//   · 한글은 있는데 뒤 숫자가 4자리 미만
//   · 한글 없이 숫자만 6~8자리(한글을 빼먹은 형태)
const PLATE_NEAR_MISS_RE = /\d{2,3}\s?[가-힣]\s?\d{1,3}(?!\d)|(?:^|\D)\d{6,8}(?!\d)/;

function hasMalformedPlate(text) {
  return String(text || '').split('\n').some((raw) => {
    // 차량 줄로 명시된 줄만 본다 — 주소·메모에 섞인 숫자를 번호판 오타로 오인하지 않도록.
    if (!/차량|차종/.test(raw)) return false;
    const line = raw.replace(PHONE_RE_GLOBAL, '');
    if (PLATE_RE.test(line)) return false; // 제대로 된 번호판이 이미 있으면 대상 아님
    return PLATE_NEAR_MISS_RE.test(line);
  });
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
  for (const chunk of [blocks.head, blocks.origin, blocks.dest, blocks.keyPickup, blocks.keyReturn]) {
    for (const raw of String(chunk || '').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (used.some((u) => u && (line.includes(u) || u.includes(line)))) continue;
      if (PHONE_RE.test(line) || PLATE_RE.test(line)) continue;
      // 블록 머리 줄은 메모가 아니다. 대괄호형(`[출발지]`)만 걸러내던 것을 불릿형(`■ 차량정보`,
      // `＊`)과 괄호 안 공백(`[ 탁송요청 1 ]`)까지 넓힌다 — 초기 폼을 인식하게 되면서 이 줄들이
      // 그대로 메모로 새어 들어갔다.
      if (/^[[\s＊*■]*(출발지|도착지|키수령지|키반납지|탁송요청|탁송일정|차량정보)\s*\d*\s*[\]:：]?\s*$/.test(line)) continue;
      if (/신청합니다|요청합니다/.test(line)) continue;
      // "1대", "차량정보 (3대)" 같은 대수 표기는 차량 배열로 이미 구조화돼 있어 메모에 넣지 않는다.
      if (/^(차량정보\s*)?\(?\s*\d+\s*대\s*\)?$/.test(line)) continue;
      lines.push(line);
    }
  }
  const memo = lines.join(' / ').replace(/\s{2,}/g, ' ').trim();
  return memo || null;
}

// 키수령지가 따로 있는 폼의 경로 해석(사용자 확정 규칙).
//
// 실사용 폼(2024-05-10)은 장소가 셋이다 — 키를 받는 곳, 차가 서 있는 곳, 차를 갖다 놓을 곳.
// 기사 동선은 "키수령지 → (도보) 출발지 → 도착지"이므로 기사가 처음 가는 곳이 키수령지다.
//   · 키수령지 → 출발지 슬롯 (기사가 먼저 도착할 곳, 연락처도 여기 담당자)
//   · 원래 출발지 → 경유지 (차가 실제로 서 있는 곳)
//   · 도착지 → 그대로
// 키수령지의 상세주소(건물·층·담당자)는 주소 칸에 넣으면 지오코딩을 방해하므로 요청사항으로
// 옮긴다 — "키수령지 : …" 형태로 기사에게 그대로 전달된다.
//
// 키반납지는 경로를 바꾸지 않는다 — 차는 도착지에서 끝나고, 키만 걸어가서 반납하는 지시이므로
// 요청사항에만 남긴다. 이걸 빠뜨리면 지시가 조용히 사라지므로 반드시 함께 처리한다.
// "KG타워 3층 KG모빌리티 (서울 중구 통일로 92), 마케팅팀 김성진 대리"처럼 도로명주소를 괄호
// 안에 적고 바깥에는 건물명·층·담당자를 적는 폼이 있다(2024-05 초기 폼). 줄 전체를 주소로 쓰면
// 지오코딩이 실패하므로 괄호 안을 주소로, 바깥을 상세주소로 돌린다.
//
// ⚠ 바깥에 이미 도로명주소가 있으면 절대 건드리지 않는다 — "서울특별시 강서구 양천로53길 30,
// 8층 KGM (가양동, 서서울모터리움)"처럼 괄호가 법정동·상호를 담는 형태가 훨씬 흔하고(이쪽이
// 압도적 다수다), 그걸 바꾸면 멀쩡한 주소를 법정동만 남겨 망가뜨린다.
//
function firstNonEmptyLine(body) {
  return String(body || '').split('\n').map((l) => l.trim()).find(Boolean) || null;
}

// 괄호 안은 "도로명 + 번호"나 지번 꼴일 때만 주소로 인정한다(ADDRESS_HINT_RE보다 엄격하게) —
// 법정동명만 스쳐도 주소로 보면 "평택역 택시승강장(원평동 방면)"처럼 방향을 적어둔 괄호를
// 주소로 삼아, 정작 픽업 지점인 "평택역 택시승강장"을 상세주소로 밀어낸다(로그 재생에서 확인).
const PAREN_ROAD_ADDRESS_RE = /[가-힣]+(?:로|길)\s*\d+|\d+-\d+|\d+번지/;

function splitPlaceAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return { address: null, addressDetail: null };
  const m = value.match(/\(([^)]*)\)/);
  if (m && PAREN_ROAD_ADDRESS_RE.test(m[1])) {
    const outside = (value.slice(0, m.index) + ' ' + value.slice(m.index + m[0].length))
      .replace(/\s*[,/]\s*/g, ' ')
      .replace(/\)+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!ADDRESS_HINT_RE.test(outside)) {
      return { address: m[1].trim(), addressDetail: outside || null };
    }
  }
  return splitRoadAddress(value);
}

function keyPlaceNote(label, body) {
  // 블록의 **첫 줄만** 쓴다 — 키반납지처럼 마지막 블록이면 본문이 뒤의 요청사항·차량정보까지
  // 전부 삼키기 때문에(로그 재생에서 차량 목록이 메모로 새어 들어갔다), 장소가 적힌 첫 줄만
  // 떼어낸다. 나머지 줄은 buildMemo가 평소처럼 요청사항으로 처리한다.
  const joined = firstNonEmptyLine(body);
  if (!joined) return null;
  // 주소 칸으로 간 도로명주소(괄호 안)와 전화번호를 걷어내고 남은 설명만 남긴다.
  const rest = joined
    .replace(/\(([^)]*)\)/g, (whole, inner) => (ADDRESS_HINT_RE.test(inner) ? '' : whole))
    .replace(PHONE_RE_GLOBAL, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s*,\s*/g, ', ')
    .replace(/[\s,]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return rest ? `${label} : ${rest}` : null;
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

  let originAddress = pickAddress(originLines, usedLines);
  const destAddress = pickAddress(destLines, usedLines);
  let originContact = pickContact(blocks.origin);
  const destContact = pickContact(blocks.dest);

  // 키수령지가 있으면 경로를 다시 배치한다(위 keyPlaceNote 주석 참고).
  const waypoints = [];
  const keyNotes = [];
  if (blocks.keyPickup) {
    const keyAddress = pickAddress(blocks.keyPickup.split('\n'), usedLines);
    const keyContact = pickContact(blocks.keyPickup);
    if (keyAddress) {
      // 원래 출발지(차가 서 있는 곳)를 경유지로 내리고, 키수령지를 출발지로 올린다.
      if (originAddress) {
        waypoints.push({
          ...splitPlaceAddress(originAddress),
          contact: originContact,
          vehicleNumber: null,
        });
      }
      originAddress = keyAddress;
      originContact = keyContact || originContact;
      keyNotes.push(keyPlaceNote('키수령지', blocks.keyPickup));
    }
  }
  if (blocks.keyReturn) keyNotes.push(keyPlaceNote('키반납지', blocks.keyReturn));

  // 차량은 출발지 블록에 오는 게 정상이고(로그 기준 대부분), 없으면 전체에서 찾는다.
  let vehicles = pickVehicles(blocks.origin);
  if (!vehicles.length) vehicles = pickVehicles(text);

  const options = pickOptions(text);
  // 옵션으로 이미 구조화한 줄(주유·서류·출고일·연료잔량)은 메모에서 뺀다 — 빼지 않으면
  // lib/kakaoIntakeService.js가 옵션과 메모를 합칠 때 같은 문장이 두 번 들어간다.
  const gaugeLine = options.fuelGauge
    ? text.split('\n').find((l) => /현\s*\d\s*칸/.test(l))
    : null;
  const baseMemo = buildMemo(blocks, [
    originAddress,
    destAddress,
    // 키수령지·키반납지의 장소 줄은 keyNotes로 이미 옮겼으니 메모에서 뺀다(중복 방지).
    firstNonEmptyLine(blocks.keyPickup),
    firstNonEmptyLine(blocks.keyReturn),
    // 경유지로 내려간 원래 출발지 주소도 메모에서 뺀다 — 안 빼면 경유지와 메모에 같은 주소가 겹친다.
    ...waypoints.map((w) => w.address),
    ...waypoints.map((w) => w.addressDetail),
    when && when.raw,
    options.refuel && options.refuel.raw,
    options.documents,
    options.releaseDate,
    gaugeLine && gaugeLine.trim(),
  ]);
  // 키수령지·키반납지 안내는 기사에게 반드시 전달돼야 하므로 메모 맨 앞에 붙인다.
  const memo = [...keyNotes.filter(Boolean), baseMemo].filter(Boolean).join(' / ') || null;

  const missing = [];
  if (!originAddress) missing.push('origin_address');
  if (!destAddress) missing.push('destination_address');
  if (!vehicles.length) missing.push('vehicle_number');
  if (!when) missing.push('when');

  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    // 번호판을 적었는데 형식이 어긋난 경우 — 되묻기 문구를 "안 적었다"가 아니라 "형식 확인"으로
    // 바꾸기 위한 플래그(buildMissingQuestion에서 쓴다).
    malformedPlate: !vehicles.length && hasMalformedPlate(text),
    // 정형 폼은 "주소 : …" 한 줄을 통째로 읽으므로 여기서 도로명/상세주소를 나눈다
    // (splitRoadAddress — 자유 문장 경로는 모델이 이미 나눠 준다).
    origin: { ...splitPlaceAddress(originAddress), contact: originContact },
    destination: { ...splitPlaceAddress(destAddress), contact: destContact },
    // 키수령지 폼에서 원래 출발지(차가 서 있는 곳)가 경유지로 내려온다. 접수 서비스가
    // order_waypoints까지 저장한다(lib/kakaoIntakeService.js geocodeBoth → createOrder).
    waypoints,
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

  // 번호판을 적었는데 형식이 어긋난 경우는 "더 필요합니다"가 아니라 "확인해주세요"로 물어야 한다 —
  // 고객은 이미 적었다고 생각하므로 항목이 없다고 하면 대화가 겉돈다(실사용 로그: "219누863"→
  // 실제 219누8363, "8083692"→실제 808너3692. 둘 다 자릿수·한글 누락이었다).
  if (parsed && parsed.malformedPlate) {
    const others = labels.filter((l) => !/차량번호/.test(l));
    const plateAsk = '적어주신 차량번호의 형식을 확인해주세요. 번호판에 적힌 대로 다시 알려주시면 바로 접수하겠습니다.\n(예: 12가3456 / 경기35바5081)';
    const ask2 = others.length
      ? `${plateAsk}\n\n아래 항목도 함께 알려주세요.\n· ${others.join('\n· ')}`
      : plateAsk;
    const known2 = describeKnownFields(parsed, addressPreview);
    return known2 ? `${known2}\n\n${ask2}` : ask2;
  }

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
  // 저장은 주소/상세주소 두 칸으로 나뉘지만 되읽어줄 때는 고객이 말한 대로 합쳐서 보여준다.
  if (parsed.origin && parsed.origin.address) lines.push(`· 출발 ${show(fullAddress(parsed.origin), 'origin')}`);
  const waypoint = (parsed.waypoints || [])[0];
  if (waypoint && waypoint.address) lines.push(`· 경유 ${show(fullAddress(waypoint), 'waypoint')}`);
  if (parsed.destination && parsed.destination.address) lines.push(`· 도착 ${show(fullAddress(parsed.destination), 'destination')}`);
  if (parsed.vehicles && parsed.vehicles.length) {
    lines.push('· 차량 ' + parsed.vehicles.map((v) => [v.type, v.plate].filter(Boolean).join(' ')).join(', '));
  }
  if (parsed.when) {
    const when = parsed.when.immediate
      ? '즉시'
      : [parsed.when.date, parsed.when.time].filter(Boolean).join(' ') || parsed.when.raw;
    if (when) lines.push(`· 일시 ${when}`);
  }
  // 아래 항목들은 한 번에 다 묻던 시절에는 되읽어줄 필요가 크지 않았지만, 하나씩 묻게 되면서
  // 반드시 필요해졌다 — 방금 답한 값이 확인란에 안 나오면 고객은 자기 답이 먹혔는지 알 수 없다.
  // 실사용 사고: "왕복 01033331444"라고 답했는데 확인란은 출발지·일시만 그대로 보여줘서,
  // 답이 무시된 것처럼 보였다. 탁송에는 없는 값(이용 형태 등)은 undefined라 그냥 넘어간다.
  if (parsed.tripType) lines.push(`· 이용 형태 ${parsed.tripType === 'round_trip' ? '왕복' : '편도'}`);
  if (parsed.origin && parsed.origin.contact) lines.push(`· 출발지 연락처 ${parsed.origin.contact}`);
  if (parsed.destination && parsed.destination.contact) lines.push(`· 도착지 연락처 ${parsed.destination.contact}`);
  if (parsed.finalDestinationAddress) lines.push(`· 최종 목적지 ${parsed.finalDestinationAddress}`);
  if (parsed.destinationWait && parsed.destinationWait.minutes !== null && parsed.destinationWait.minutes !== undefined) {
    lines.push(`· 도착지 대기 ${parsed.destinationWait.minutes ? `${parsed.destinationWait.minutes}분` : '없음'}`);
  }
  if (!lines.length) return null;
  return `아래 내용으로 확인했습니다.\n${lines.join('\n')}`;
}

// 빠진 항목을 **하나씩** 묻는다(프리미엄 대리·일일기사).
//
// 왜 한 번에 다 묻지 않나: 이 카테고리는 빠지는 항목이 많고(이용 형태·연락처·차량·도착지·
// 최종 목적지·경유지·대기시간·전달사항), 게다가 앞 항목의 답에 따라 뒤 항목이 늘어난다
// ("왕복"을 고르면 최종 목적지가 새로 생긴다). 목록으로 뭉쳐 물으면 고객은 답할 때마다 목록이
// 줄었다 늘었다 하는 것을 보게 되고, 무엇을 답했고 무엇이 남았는지 알 수 없다(실사용 로그에서
// 실제로 그렇게 겉돌았다).
//
// 질문 문구는 새로 짜지 않고 필드 정의(lib/intakeFields.js)의 question을 쓴다 — 웹 브라우저
// 흐름이 이미 같은 문구로 하나씩 묻고 있어서, 새로 쓰면 채널마다 말이 달라진다.
function buildNextMissingQuestion(missing, parsed, addressPreview, fields) {
  const nextId = (missing || [])[0];
  if (!nextId) return null;
  const field = (fields || []).find((f) => f.id === nextId);
  if (!field) return buildMissingQuestion(missing, parsed, addressPreview, fields);

  // 번호판을 적었는데 형식이 어긋난 경우는 "알려주세요"가 아니라 "확인해주세요"로 물어야 한다 —
  // 고객은 이미 적었다고 생각하므로 없다고 하면 대화가 겉돈다(buildMissingQuestion과 같은 이유).
  const ask = (nextId === 'vehicle_number' && parsed && parsed.malformedPlate)
    ? '적어주신 차량번호의 형식을 확인해주세요. 번호판에 적힌 대로 다시 알려주시면 바로 접수하겠습니다.\n(예: 12가3456 / 경기35바5081)'
    : [field.question, field.example ? `(예: ${field.example})` : null].filter(Boolean).join('\n');

  // 남은 개수를 밝힌다 — 하나씩 물으면 고객은 언제 끝나는지 알 수 없어 중간에 그만두기 쉽다.
  const rest = (missing || []).length - 1;
  const tail = rest > 0 ? `\n(남은 항목 ${rest}개)` : '';

  const known = describeKnownFields(parsed, addressPreview);
  return known ? `${known}\n\n${ask}${tail}` : `${ask}${tail}`;
}

// LLM이 프롬프트 지시("값을 알 수 없는 필드는 키를 아예 빼라")를 어기고 원문에 없는 값을
// 지어내는 경우가 실측으로 확인됐다 — 주소 두 개만 언급된 메시지("사당역탐앤탐스" 다음 줄에
// "인천공항1터미널주차장")에서 시간·차종을 지어내고, 도착지를 경유지로 잘못 분류했다
// (재현 시 정상 추출 0~2/10 — 되묻기로 원문이 이어붙는 실사용 경로에서 압도적으로 자주 발생).
// 값을 그대로 신뢰하지 않고 원문에 최소한의 근거가 있는지 확인해, 근거 없는 값은 버린다 —
// 비워두고 되묻는 편이 지어낸 값(엉뚱한 시각으로 접수, 도착지 미확정)으로 진행하는 것보다 훨씬 안전하다.
const TIME_HINT_RE = /(\d{1,2}\s*시|\d{1,2}\s*:\s*\d{2}|오전|오후|즉시|지금|당장|오늘|내일|모레|[월화수목금토일]요일|\d{1,2}\s*월\s*\d{1,2}\s*일|\d{1,2}\/\d{1,2})/;
const DATE_FMT_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_FMT_RE = /^\d{1,2}:\d{2}$/;

// 원문에 시간을 가리키는 표현이 전혀 없으면 reservationDate/Time을 버린다. 형식이 스키마와
// 다르면(모델이 통째로 오작동한 경우, 예: reservationTime에 주소 문자열이 들어옴) 그것도 버린다.
function groundedReservation(classified, text) {
  if (!TIME_HINT_RE.test(text)) return { date: null, time: null };
  const date = String(classified.reservationDate || '').trim();
  const time = String(classified.reservationTime || '').trim();
  return {
    date: DATE_FMT_RE.test(date) ? date : null,
    time: TIME_FMT_RE.test(time) ? time : null,
  };
}

// "주소가 정확히 두 개면 나중 주소가 도착지"라고 프롬프트에 명시했는데도, 모델이 두 번째
// 주소를 waypointAddress에 넣고 destinationAddress를 비우는 경우가 있다(경유 표현이 전혀
// 없는데도). 도착지가 비어 있고 원문에 "경유"라는 말이 없으면, 그 값을 도착지로 승격한다 —
// 실제로 경유지를 말한 경우("A 경유해서 B까지")는 "경유" 표현이 있어 승격 대상에서 제외된다.
const WAYPOINT_MARKER_RE = /경유/;

function promoteMislabeledWaypoint(destAddress, waypointAddress, text) {
  if (!destAddress && waypointAddress && !WAYPOINT_MARKER_RE.test(text)) {
    return { destAddress: waypointAddress, waypointAddress: null };
  }
  return { destAddress, waypointAddress };
}

// 도로명주소에서 상세주소를 떼어낸다 — "부산 해운대구 선수촌로 187 KGM 해운대서비스센터"를
// 주소("…선수촌로 187")와 상세주소("KGM 해운대서비스센터")로 나눈다.
//
// 자유 문장 경로는 모델이 두 필드로 나눠 주지만(lib/hybridChat.js), 정형 폼 경로는 "주소 : …"
// 한 줄을 그대로 읽기 때문에 여기서 나눠야 한다. 이 채널 트래픽의 절반이 정형 폼이라 실제로
// 거의 모든 접수가 합쳐진 채로 저장됐다(실사용 지적).
//
// 규칙은 "도로명 + 건물번호까지가 주소, 그 뒤는 상세주소" 하나뿐이다. 도로명/건물번호가
// 아예 없는 표현(지번 주소 "…운서동 2868", 상호명만 "사당역탐앤탐스")은 그대로 둔다 —
// 그 자체가 검색해야 할 주소이기 때문이다.
//
// 마지막 "…로/길 숫자"를 기준으로 자른다(탐욕적 매칭). 앞에서부터 자르면 "중문관광로 72번길
// 35"가 "중문관광로 72" + "번길 35"로 잘못 갈린다.
const ROAD_ADDRESS_RE = /^(.*(?:로|길)\s*\d+(?:-\d+)?)\s+(\S.*)$/;

function splitRoadAddress(raw) {
  const value = String(raw || '').trim();
  if (!value) return { address: null, addressDetail: null };
  const m = ROAD_ADDRESS_RE.exec(value);
  if (!m) return { address: value, addressDetail: null };
  return { address: m[1].trim(), addressDetail: m[2].trim() || null };
}

// 주소 + 상세주소를 한 줄로. 저장은 두 칸으로 나누지만(orders.origin_address / _detail), 고객에게
// 되읽어주거나 상담원 카드 폼처럼 주소 칸이 하나뿐인 곳에서는 합쳐서 보여줘야 입력한 내용이
// 통째로 보인다. 합치는 규칙을 한 곳에 둬서 표시하는 쪽마다 달라지지 않게 한다.
function fullAddress(place) {
  if (!place) return null;
  return [place.address, place.addressDetail].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;
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

  // 원문에 시간 표현이 없거나 형식이 깨졌으면(모델 오작동) 버린다 — groundedReservation 참고.
  const { date, time } = groundedReservation(classified, text);
  // 날짜/시간이 둘 다 없다고 곧바로 "즉시"로 단정하지 않는다. 폼 파서(pickWhen)는 원문에
  // "즉시"가 실제로 적혀 있을 때만 즉시로 본다(missing.push('when')도 같이 있다) — 그런데
  // 이 자유 문장 경로는 예전에 둘 다 없으면 무조건 즉시로 단정해서, "탁송접수하고 싶어"처럼
  // 일시를 아예 말하지 않은 메시지도 "일시: 즉시"로 확정돼버렸다(실사용 지적 — 물어본 적
  // 없는데 즉시 접수로 확정 표시됨). 명시적 "즉시"가 원문에 있을 때만 즉시로 보고, 그마저
  // 없으면 폼 파서와 똑같이 missing에 넣어 되묻는다.
  const explicitImmediate = IMMEDIATE_WORDING_RE.test(text);
  const when = (date || time)
    ? { immediate: false, date, time, dateRolled: false, raw: [date, time].filter(Boolean).join(' ') }
    : (explicitImmediate ? { immediate: true, date: null, time: null, dateRolled: false, raw: null } : null);

  // 주소와 상세주소는 합치지 않고 따로 둔다. 예전에는 여기서 한 문자열로 이어붙였는데, 그러면
  // orders.origin_address_detail 컬럼이 항상 비고 콜마너 payload의 지점 memo도 상세위치 대신
  // 전체 주소로 채워진다(lib/callmaner.js — memo는 50바이트라 잘린다). 실사용 지적: "부산
  // 해운대구 선수촌로 187 KGM 해운대서비스센터"가 통째로 주소 한 칸에 들어갔다.
  // 지오코딩·주소후보 검색도 도로명까지만 넘기는 편이 정확하다.
  const trim = (v) => String(v || '').trim() || null;
  // 모델이 두 칸으로 나눠줬으면 그대로 쓰고, 한 칸에 몰아넣었으면 도로명 기준으로 나눈다 —
  // 정형 폼 경로와 같은 규칙(splitRoadAddress)이라 어느 경로로 들어와도 같은 결과가 저장된다.
  const resolvePlace = (base, detail) => (trim(detail)
    ? { address: trim(base), addressDetail: trim(detail) }
    : splitRoadAddress(base));

  const origin = resolvePlace(classified.originAddress, classified.originAddressDetail);
  const originAddress = origin.address;
  const originAddressDetail = origin.addressDetail;

  // 도착지가 비었는데 경유지가 채워졌고 원문에 "경유" 언급이 없으면, 모델의 라벨 오분류로 보고
  // 도착지로 승격한다(promoteMislabeledWaypoint 참고) — 실사용에서 "A" "B" 두 주소만 준 접수가
  // 도착지 없이 경유지로 잡혀 "도착지 주소가 필요합니다"를 영원히 반복하던 문제를 막는다.
  const destPlace = resolvePlace(classified.destinationAddress, classified.destinationAddressDetail);
  const waypointPlace = resolvePlace(classified.waypointAddress, classified.waypointAddressDetail);
  const promoted = promoteMislabeledWaypoint(destPlace.address, waypointPlace.address, text);
  const destAddress = promoted.destAddress;
  // 승격됐으면 상세주소도 같이 따라간다 — 주소만 옮기고 상세를 경유지에 남기면 서로 다른 곳의
  // 정보가 섞인다.
  const wasPromoted = !destPlace.address && !!promoted.destAddress;
  const destAddressDetail = wasPromoted ? waypointPlace.addressDetail : destPlace.addressDetail;
  const waypointAddressDetail = wasPromoted ? null : waypointPlace.addressDetail;

  const missing = [];
  if (!originAddress) missing.push('origin_address');
  if (!destAddress) missing.push('destination_address');
  if (!vehicles.length) missing.push('vehicle_number');
  if (!when) missing.push('when');

  // 경유지와 왕복 복귀 정보. 접수를 두 건으로 나눌지 정하는 데 쓴다(lib/orderSplit.js) —
  // 날짜가 갈릴 때만 나뉘므로, 날짜를 말하지 않은 평범한 경유 운행은 그대로 한 건이다.
  const waypointAddress = promoted.waypointAddress;
  const waypoints = waypointAddress ? [{
    address: waypointAddress,
    addressDetail: waypointAddressDetail,
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
    origin: { address: originAddress, addressDetail: originAddressDetail, contact: normalizePhone(classified.originContact) || null },
    destination: { address: destAddress, addressDetail: destAddressDetail, contact: normalizePhone(classified.destinationContact) || null },
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

// ---- 프리미엄(시간제)·일일기사 — 웹/카카오 공유 ----
// 원래 lib/webIntakeTurn.js 안에만 있었는데, 카카오 채널도 같은 변환이 필요해져 여기로
// 옮겼다(탁송의 buildParsedFromClassified와 같은 이유 — 두 채널이 다른 변환을 쓰면 같은
// 문장이 채널에 따라 다른 오더가 된다).

// 짧은 답(없어 등)으로만 채워지는 항목이 한꺼번에 둘 이상 남으면, "없어" 한 마디가 어느
// 것에 대한 답인지 알 수 없다 — 이 지름길은 missing이 정확히 하나일 때만 쓴다.
// ⚠ 끝에 \b(단어 경계)를 쓰면 안 된다 — JS \b는 [A-Za-z0-9_] 기준이라 한글 뒤에서는 절대
// 성립하지 않는다. 대신 공백/구두점/문자열 끝을 직접 확인한다.
const PREMIUM_DECLINE_RE = /^(없음|없어요|없습니다|없어|없|모르겠|모름|모르|아니오|아니요|괜찮|스킵|no)([\s,.!~]|$)/i;
const PREMIUM_DECLINABLE_FIELD_IDS = new Set(['destination_wait', 'memo_customer', 'vehicle_number', 'waypoint']);

// orderType('premium'|'daily_driver') → classifyAndExtract의 intent 힌트. 카테고리가 이미
// 확정된 뒤 재분류할 때만 넘긴다(첫 분류는 이 값을 알아내는 호출이라 넘길 수 없다) — 넘기면
// hybridChat.js가 요약형 전달사항 지시문(_premiumMemoInstructions)을 쓴다.
function premiumOrderTypeToIntentHint(orderType) {
  if (orderType === 'daily_driver') return 'daily_driver_order';
  if (orderType === 'premium') return 'proxy_order';
  return null;
}

function parseTripTypeBareReply(text) {
  const t = String(text || '').trim();
  if (/^1\s*(번|\.|\))?$/.test(t)) return 'round_trip';
  if (/^2\s*(번|\.|\))?$/.test(t)) return 'one_way';
  return null;
}

// Gemini 추출 결과(+짧은 답 지름길로 미리 정한 값)를 프리미엄/일일기사 parsed 모양으로 맞춘다.
// overrides.tripType/declined는 지난 턴까지 확정된 값 — 이번 턴 Gemini 결과가 이를 다시 못
// 잡아내도(짧은 답이라 못 잡는 게 당연하다) 덮어써 잃지 않는다.
function buildPremiumParsedFromClassified(classified, text, overrides) {
  const ov = overrides || {};
  const join = (a, b) => [a, b].map((v) => String(v || '').trim()).filter(Boolean).join(' ') || null;

  const tripType = ov.tripType
    || (classified.tripType === 'round_trip' || classified.tripType === 'one_way' ? classified.tripType : null);

  const date = String(classified.reservationDate || '').trim() || null;
  const time = String(classified.reservationTime || '').trim() || null;
  const when = (date || time)
    ? { immediate: false, date, time, dateRolled: false, raw: [date, time].filter(Boolean).join(' ') }
    : { immediate: true, date: null, time: null, dateRolled: false, raw: null };

  // 주소/상세주소는 탁송(buildParsedFromClassified)과 같이 나눠서 보존한다 — 저장 컬럼이 두 칸이고
  // 콜마너 지점 memo도 상세주소를 쓴다. 최종 목적지는 저장 컬럼이 한 칸뿐이라 합쳐서 넣는다.
  const trim = (v) => String(v || '').trim() || null;
  const resolvePlace = (base, detail) => (trim(detail)
    ? { address: trim(base), addressDetail: trim(detail) }
    : splitRoadAddress(base));

  const origin = resolvePlace(classified.originAddress, classified.originAddressDetail);
  const originAddress = origin.address;
  const originAddressDetail = origin.addressDetail;
  const destination = resolvePlace(classified.destinationAddress, classified.destinationAddressDetail);
  const destAddress = destination.address;
  const destAddressDetail = destination.addressDetail;
  const finalDestAddress = join(classified.finalDestinationAddress, classified.finalDestinationAddressDetail);
  const plate = normalizePlate(classified.originVehicleNumber) || null;
  const vehicleType = String(classified.vehicleType || '').trim() || null;
  const waypoint = resolvePlace(classified.waypointAddress, classified.waypointAddressDetail);
  const waypointAddress = waypoint.address;
  const waypointAddressDetail = waypoint.addressDetail;

  const declined = new Set(ov.declined || []);
  let waitMinutes = (classified.destinationWaitMinutes !== undefined && classified.destinationWaitMinutes !== null && classified.destinationWaitMinutes !== '')
    ? Number(classified.destinationWaitMinutes) : null;
  if ((waitMinutes === null || Number.isNaN(waitMinutes)) && declined.has('destination_wait')) waitMinutes = 0;
  const memo = String(classified.memo || '').trim() || null;

  const values = {
    trip_type: tripType,
    reserved_date: date || time,
    origin_address: originAddress,
    origin_contact: normalizePhone(classified.originContact) || null,
    vehicle_number: plate || (declined.has('vehicle_number') ? 'x' : null),
    destination_address: destAddress,
    // 대리운전·일일기사는 경유 여부를 항상 물어본다(사용자 확정 규칙) — 탁송처럼 고객이 먼저
    // 말했을 때만 다루는 게 아니라, 언급이 없으면 missing에 남겨 되묻는다. "없어"로 답하면
    // declined에 담겨 이 필드가 채워진 것으로 본다(다른 declinable 필드와 같은 방식).
    waypoint: waypointAddress || (declined.has('waypoint') ? 'x' : null),
    destination_wait: waitMinutes !== null && !Number.isNaN(waitMinutes) ? String(waitMinutes) : null,
    final_destination_address: finalDestAddress,
    memo_customer: memo || (declined.has('memo_customer') ? 'x' : null),
  };

  const fields = getDailyDriverFields(tripType);
  const rawMissing = fields
    .filter((f) => {
      const v = values[f.id];
      return v === undefined || v === null || v === '';
    })
    .map((f) => f.id);

  const firstDeclinableIdx = rawMissing.findIndex((id) => PREMIUM_DECLINABLE_FIELD_IDS.has(id));
  const missing = firstDeclinableIdx === -1
    ? rawMissing
    : rawMissing.filter((id, i) => i <= firstDeclinableIdx || !PREMIUM_DECLINABLE_FIELD_IDS.has(id));

  const vehicle = { plate, type: vehicleType };
  return {
    matched: true,
    complete: missing.length === 0,
    missing,
    category: 'premium_daily',
    tripType,
    origin: { address: originAddress, addressDetail: originAddressDetail, contact: normalizePhone(classified.originContact) || null },
    destination: { address: destAddress, addressDetail: destAddressDetail, contact: null },
    vehicle,
    vehicles: (plate || vehicleType) ? [vehicle] : [], // describeKnownFields(공용 되묻기 요약)가 이 모양을 본다.
    when,
    destinationWait: { minutes: waitMinutes !== null && !Number.isNaN(waitMinutes) ? waitMinutes : null },
    finalDestinationAddress: tripType === 'round_trip' ? finalDestAddress : null,
    memo,
    // waypointAddress는 하위호환으로 남긴다(예전엔 이 값이 있으면 곧바로 상담원에게 넘겼다).
    // waypoints는 탁송(buildParsedFromClassified)과 같은 모양 — 지오코딩·주소후보 확인·
    // 오더 저장이 채널·카테고리 구분 없이 같은 코드를 타게 한다.
    waypointAddress,
    waypoints: waypointAddress ? [{
      address: waypointAddress,
      addressDetail: waypointAddressDetail,
      contact: normalizePhone(classified.waypointContact) || null,
      vehicleNumber: normalizePlate(classified.waypointVehicleNumber) || null,
    }] : [],
    declined: Array.from(declined),
    raw: text,
  };
}

// ---- 등록 전 "네/아니오" 확인 — 웹/카카오 공유 ----
// 원래 lib/webIntakeTurn.js에만 있었는데(웹만 등록 전 확인을 받았다), 카카오도 등록 전
// 확인을 받도록 바꾸면서 여기로 옮겼다. mcpDispatchAgent.js에도 비슷한 판정(isAffirmativeReply/
// isNegativeReply)이 있지만 그건 도구 실행 확인이라 문맥이 다르다 — 접수 확인 전용은 이 둘로 통일한다.
function isAffirmative(text) {
  const s = String(text || '').trim();
  if (!s) return false;
  return /^(네|넵|예|응|어|그래|그럼|좋아|좋습니다|괜찮|오케이|콜|ok|okay|yes|y)([\s,.!~]|$)/i.test(s)
    || /(그대로\s*(진행|해)|그렇게\s*(해|진행|부탁)|접수\s*(해|할|하)|맞습니다|맞아요|부탁\s*(해|드립|합니다|드려))/.test(s);
}

function isNegative(text) {
  const s = String(text || '').trim();
  return /^(아니|아뇨|노|no|안\s?돼|안\s?할래|취소)/i.test(s);
}

// 등록 실패 사유 → 사용자에게 그대로 보여줄 문구. origin_geocode_failed/operating_hours/
// exception은 고객이 스스로 고쳐서 다시 시도할 수 있는 사유라 채널과 무관하게 그대로 보여준다.
// waypoint_unsupported의 "오더 등록 화면에서 직접 접수해주세요"는 로그인 화면이 있는 웹
// 전용 안내라, 카카오는 이 reason을 이 표로 보여주지 않고 상담원에게 인계한다(경유지는
// "이 흐름이 못 다루면 사람에게"라는 같은 원칙을, 웹은 구형 폼으로/카카오는 상담원으로
// 각자의 유일한 수단으로 구현한 것 — 문자 그대로 같은 문구를 쓸 수는 없다).
const FAILURE_MESSAGES = {
  origin_geocode_failed: '출발지 주소를 확인할 수 없습니다. 더 정확한 주소로 다시 입력해주세요.',
  operating_hours: '요청하신 시간은 지사 운영시간 밖입니다. 시간을 다시 확인해주세요.',
  waypoint_unsupported: '경유지가 포함된 접수는 AI 챗봇으로 등록할 수 없습니다. 오더 등록 화면에서 직접 접수해주세요.',
  exception: '접수 처리 중 오류가 발생했습니다. 오더 등록 화면에서 직접 접수해주세요.',
};

module.exports = {
  parseKakaoIntake, buildParsedFromClassified, buildMissingQuestion, buildNextMissingQuestion,
  normalizePhone, normalizePlate,
  PREMIUM_DECLINE_RE, PREMIUM_DECLINABLE_FIELD_IDS, premiumOrderTypeToIntentHint, parseTripTypeBareReply,
  buildPremiumParsedFromClassified, isAffirmative, isNegative, FAILURE_MESSAGES, fullAddress,
};
