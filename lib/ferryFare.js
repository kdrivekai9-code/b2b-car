const db = require('../db');

const GOLD_STELLA_SOURCE = {
  routeCode: 'WANDO_JEJU',
  shipName: '골드스텔라',
  sourceTitle: '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)',
  sourceUrl: 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do',
};

const DEFAULT_GOLD_STELLA_RULES = [
  {
    vehicle_label: '티코, 마티즈, 비스토, 모닝, 스파크, 트위지(전기차), 스마트(전기차), 마이브(전기차), 캠시스(전기차), 마이브 M1(전기차), 캠시스 CEVO-C SE(전기차), 캠시스 CEVO-C VAN(전기차), 스마트 EV d2c(전기차), 스마트 EV d2p(전기차), 마스타 (전기차)',
    weekday_fare: 95250,
    holiday_fare: 101790,
    sort_order: 1,
  },
  {
    vehicle_label: '엑셀, 스쿠프, 아토스, 르망, 프레스토, 레이, 캐스퍼, 타우너, 다마스, 코닉세그 CCX, 캐스퍼(전기차), 레이 EV(전기차)',
    weekday_fare: 108670,
    holiday_fare: 116140,
    sort_order: 2,
  },
  {
    vehicle_label: '라보(공차), 포트로(공차/전기차)',
    weekday_fare: 103000,
    holiday_fare: 110470,
    sort_order: 3,
  },
  {
    vehicle_label: '라보(적차), 포트로(적차/전기차)',
    weekday_fare: 117320,
    holiday_fare: 128070,
    sort_order: 4,
  },
  {
    vehicle_label: '엑센트, 아벨라, 엘란, 슈마, 엘란트라, i30, 넥시아, 베르나, 클릭, 씨에로, 캐피탈, 리오, 티뷰론, 라노스, SM3, 칼로스, 세피아, 젠트라, 투스카니, 프라이드, 벨로스터, 클리오, 르노 조에(전기차), SM3(전기차), E토비(전기차)',
    weekday_fare: 123420,
    holiday_fare: 131820,
    sort_order: 5,
  },
  {
    vehicle_label: '라세티, 누비라SP, 크루즈, 아반떼, 레간자, 크레도스, 포르테, 라비타, 쎄라토, 스펙트라, 마르샤, 쏘울, K3, 아베오, 아이오닉(전기차), 제네시스 G70, QM3, 쉐보레 볼트EV(전기차), 티볼리, 니로, 코나, 스토닉, 베뉴, 에스페로, 콩코드, 프린스, 캡쳐, 아반떼투어링, 코나(전기차), 니로 EV(전기차), 니로 플러스(전기차), 쏘울(전기차), 쉐보레 볼트 EREV, 기아 XCEED, 아이오닉',
    weekday_fare: 136780,
    holiday_fare: 146120,
    sort_order: 6,
  },
  {
    vehicle_label: '쏘나타(전차종), 로체, SM5, SM6, 매그너스, 스팅어, i40, K5, 토스카, 옵티마, 카렌스, 레조, X트랙, 트랙스, 투싼, 레토나, 카스타, 록스타, 스포티지, 스포티지R, 싼타모, 제네시스 쿠페, 셀토스, 말리부, 트레일블레이저, XM3, 소나타, 리갈, 엑스트랙, 브롬, 슈퍼싸롱, EV3(전기차), 쉐보레 볼트EUV(전기차), 르노 아르카나, EV4(전기차), 다니고벤(전기차)',
    weekday_fare: 150130,
    holiday_fare: 160410,
    sort_order: 7,
  },
  {
    vehicle_label: '다이너스티, 아카디아, SM7, 그랜져, 스테이츠맨, 오피러스, 아슬란, 체어맨, 임팔라, K7, 제네시스, 제네시스 G80, 알페온, K9, 코란도 C, 올란도, 넥쏘(수소차), K8, 아이오닉5(전기차), 아이오닉6(전기차), EV6(전기차), 엔터프라이즈, 포텐샤, 베리타스, 훼미리, 뷰티플코란도, 제네시스 G80(전기차), 제네시스 GV60(전기차), 코란도 EV(전기차), 티볼리에어',
    weekday_fare: 163860,
    holiday_fare: 175070,
    sort_order: 8,
  },
  {
    vehicle_label: '이쿼녹스, 쌍용 무쏘, 갤로퍼, 코란도, 싼타페, 카이런, 엑티언, 테라칸, 쏘렌토, 캡티바, QM5, QM6, 에쿠스, EQ900, 제네시스 G90, 트라제, 제네시스 GV70, 토레스, 이쿼녹스 EV(전기차), 토레스 EVX(전기차), GV70 (전기차), 르노 그랑콜레오스, GM 윈스톰, EV5 (전기차), 르노 필랑트',
    weekday_fare: 169740,
    holiday_fare: 181880,
    sort_order: 9,
  },
  {
    vehicle_label: '렉스톤, 베라크루즈, 모하비, 맥스크루즈, 엑티언스포츠, 코란도스포츠, 코란도투리스모, 체어맨 리무진, 에쿠스 리무진, 제네시스 리무진, 그레이스, 카니발, 로디우스, 제네시스 GV80, 베스타, 펠리세이드, 팰리세이드, 렉스턴, PV5 (전기차)',
    weekday_fare: 191760,
    holiday_fare: 204830,
    sort_order: 10,
  },
  {
    vehicle_label: '이스타나, 토픽, 봉고(15인승), 그레이스(15인승), 프레지오, 봉고3(승합차), 그랜드스타렉스, 렉스턴 스포츠, 스타리아, 트래버스, 스타렉스, EV9(전기차), 타스만, 아이오닉9 (전기차), 무쏘 스포츠, 무쏘EV (전기차), KGM무쏘, 스타리아 (전기차)',
    weekday_fare: 218570,
    holiday_fare: 233520,
    sort_order: 11,
  },
  {
    vehicle_label: '무쏘칸(픽업)',
    weekday_fare: 245570,
    holiday_fare: 262380,
    sort_order: 12,
  },
  {
    vehicle_label: 'BMW Z3, 피아트 토포리노, 혼다 비트, 스즈키 카푸치노, 로버 미니, 혼다 S660, 다이하쓰 코펜, 스마트 포투, 스마트 로드스터, 오펠 스피드스터, 로터스 엘리스, 로터스 유로파, 다이하쓰 디베이스, 도요타 IQ, 스즈키 알토라팡, 다이하쓰 미라, 다이하쓰 미라지노, 도요타 사이언 iQ, 스즈키 마이티, 푸조 205, 스즈키 알토, 다이하쓰 캐스트, 혼다 N-ONE, 로버 MGF, 페라리 308, 다이하쓰 태프트, 도요타 MR, 미쯔오카 레인보우, 푸조 107, 미쓰비시 ek x ev (전기차), 다이하쓰 무브, 페라리 328, 로터스 엑시지, 스즈키 왜건, 마쯔다 mx-5, 닛산 휘가로, 스즈키 허슬러, 혼다 CRX, 닛산 파오, 피아트 모비, 피아트 124, 피아트 스파이더, 다이하쓰 탄토, 알파로메오 4C, 폭스바겐 업, 시트로엥 C2, 스즈키 스페시아, 재규어 E 타입, 혼다 N-BOX, 피아트 500, 500C, 스마트 포포, 르노 트윙고, 다이하쓰 웨이크, 폰티악 솔스티스, 도요타 사이언 xA, 혼다 S2000, 다이하쓰 분, 피아트 판다, 크라이슬러 크로스파이어, 혼다 NSX, 페라리 348, 다이하쓰 하이젯 트럭, 페라리 F355, 로터스 에스프리, 스마트 포스타스, 미니 컨버터블, 새턴 스카이, 다이하쓰 하이젯 카고, 다이하쓰 아틀레이, 다이하쓰 시리온, 미쯔오카 록스타, 부가티 EB110, 스즈키 셀레리오, 미쓰비시 미라지, 람보르기니 우라칸 에보, 포르쉐718, 미니쿠퍼(3도어 / 일반), 미니쿠퍼 해치백 SE(전기차), 미니쿠퍼 해치백 E(전기차), 미니쿠퍼 S로드스터, 스마트 포투(전기차), 푸조 104',
    weekday_fare: 117530,
    holiday_fare: 125000,
    sort_order: 13,
  },
  {
    vehicle_label: '닛산 마치, 페라리 F40, 피아트 우노, 도요타 사이언 FR-S, 닛산 실비아, 피아트 시에나, 람보르기니 가야르도, 벤츠 SLC클래스, 푸조 206, 스즈키 이그니스, 스즈키 스위프트, 도요타 아이고, 도요타 윌, 미쯔오카 히미코, 미쓰비시 FTO, 닛산 SX, GM 트랙커, 스즈키 사이드킥, 푸조 207, 푸조 306, 벤츠 SLK, 도요타 86, 스바루 BRZ, 도요타 셀리카, 혼다 CR-Z, 로터스 에보라, 오펠 아담, 푸조 1007, 다이하쓰 노리오리, 다이하쓰 템포, 페라리 512, 알파로메오 GTV, 람보르기니 디아블로, 마쯔다 아이코닉, 포르쉐 박스터, 알파로메오 미토, 포르쉐 카이맨, 오펠 코르사, 포드 GT, 르노 모뒤스, 도요타 사이언 xD, 푸조 208, 람보르기니 우라칸, 피아트 푼토, 람보르기니 우라칸 에보 스파이더, 닛산 Z, 란치아 입실론, 크라이슬러 ME 4-12, 새턴 SC, 폭스바겐 폴로, 파가니 존다, 혼다 프렐류드, 스즈키 발레노, 페라리 360, BMW Z4, 도요타 BB, 맥라렌 720 S, 도요타 야리스(비츠), 알파로메오 147, 스즈키 솔리오, 어큐라 RSX, 페라리 F430, 피아트 아르고, 크라이슬러 프라울러, 맥라렌 765lt, 캐딜락 XLR, 도요타 수프라, 부가티 베이론, 맥라렌 600 LT, 다이하쓰 마테리아, 푸조 RCZ, 페라리 296, 새턴 SL, 어큐라 NSX, 크라이슬러 네온, 맥라렌 아투라, 홀덴 비바 해치백, 스즈키 xbee, 마세라티 3200 GT, 페라리 458, 시트로엥 C4 칵투스, 벤츠 SLC43 amg, 아우디 R8, 미니쿠퍼 해치백 5도어, 푸조 E-208(전기차), 맥라렌 아투라(전기차), 페라리 296 GTB(전기차), 페라리 296 GTS(전기차), 르노 E-테크(전기차), 미니 에이스맨E(전기차), 아우디TT RS, 도요타 프리우스C, 아우디 A1, 로터스 에미라',
    weekday_fare: 132440,
    holiday_fare: 140840,
    sort_order: 14,
  },
  {
    vehicle_label: '1톤(공차), 봉고3(1톤/공차/전기차), 다나고 C(전기차), 다나고 L(전기차), 다나고 R(전기차), 다나고 T(전기차), 다나고 W(전기차), 젤라EV(공차/전기차), 마사다 픽업(공차/전기차), 전기차 1톤 공차(전기차), pv5 오픈베드 (공차/전기차)',
    weekday_fare: 165740,
    holiday_fare: 176950,
    sort_order: 15,
  },
  {
    vehicle_label: '1톤(적차), 봉고3(1톤/적차/전기차), 다나고 C(적차/전기차), 다나고 L(적차/전기차), 다나고 R(적차/전기차), 다나고 T(적차/전기차), 다나고 W(적차/전기차), 젤라EV(적차/전기차), 마사다 픽업(적차/전기차), 전기차 1톤 적차(전기차), pv5 오픈베드(적재/전기차)',
    weekday_fare: 189740,
    holiday_fare: 205280,
    sort_order: 16,
  },
  {
    vehicle_label: '1.2톤 / 1.4톤, ST1(공차/전기차), 1.2톤/1.4톤(전기차), 봉고3(1.2톤/공차/전기차), BYD T4K(공차/전기차), 리베로(공차)',
    weekday_fare: 194870,
    holiday_fare: 209820,
    sort_order: 17,
  },
  {
    vehicle_label: '1.2톤(적차) / 1.4톤(적차), ST1(적차/전기차), 1.2톤(적차)/1.4톤(적차)(전기차), 봉고3(1.2톤/적차/전기차), BYD T4K(적차/전기차), 리베로(적차)',
    weekday_fare: 223330,
    holiday_fare: 243640,
    sort_order: 18,
  },
  {
    vehicle_label: '캠핑카(5~6m미만), 1톤(이동식업무차), 장의, 웨딩 리무진 (소), 이비온 E6(전기차), 포터 씨티밴, 워크스루밴, 캠핑트레일러(5~6m미만)',
    weekday_fare: 274310,
    holiday_fare: 292990,
    sort_order: 19,
  },
  {
    vehicle_label: '캠핑카(6~7m미만), 장의, 웨딩 리무진 (대), 캠핑트레일러(6~7m미만)',
    weekday_fare: 337710,
    holiday_fare: 365730,
    sort_order: 20,
  },
  {
    vehicle_label: '캠핑카(7~8m미만), 캠핑트레일러(7~8m미만)',
    weekday_fare: 401110,
    holiday_fare: 438470,
    sort_order: 21,
  },
  {
    vehicle_label: '캠핑카(8~9m미만), 캠핑트레일러(8~9m미만)',
    weekday_fare: 487170,
    holiday_fare: 533870,
    sort_order: 22,
  },
  {
    vehicle_label: '캠핑카(9m이상), 캠핑트레일러(9m이상)',
    weekday_fare: 584590,
    holiday_fare: 640630,
    sort_order: 23,
  },
  {
    vehicle_label: '르노마스터, 포드 트랜짓 익스플로어, 르노마스터(전기차), 트라베리 EV (전기차), 쉐보레 HD',
    weekday_fare: 290830,
    holiday_fare: 313240,
    sort_order: 24,
  },
  {
    vehicle_label: '코러스, 콤비, 쏠라티, 레스타, 카운티, 카운티(전기차), 브이버스60(전기차), 브이버스(전기차)',
    weekday_fare: 312500,
    holiday_fare: 339580,
    sort_order: 25,
  },
];

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[()\[\]{}.,·\/\\_-]/g, '');
}

function splitAliases(vehicleLabel) {
  return String(vehicleLabel || '')
    .split(',')
    .map((alias) => alias.trim())
    .filter(Boolean);
}

function weekdayTypeFromDate(dateStr) {
  if (!dateStr) return 'weekday';
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'weekday';
  return date.getDay() === 0 ? 'holiday' : 'weekday';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function scoreAliasMatch(input, alias) {
  const normalizedInput = normalizeText(input);
  const normalizedAlias = normalizeText(alias);
  if (!normalizedInput || !normalizedAlias) return 0;
  if (normalizedInput === normalizedAlias) return 1000 + normalizedAlias.length;
  if (normalizedInput.includes(normalizedAlias)) return 500 + normalizedAlias.length;
  if (normalizedAlias.includes(normalizedInput)) return 250 + normalizedInput.length;
  return 0;
}

async function loadFerryFareRules() {
  try {
    const rows = await db.all(
      `SELECT route_code, ship_name, vehicle_label, weekday_fare, holiday_fare, source_title, source_url, sort_order, is_active
       FROM ferry_fare_rules
       WHERE route_code = ? AND ship_name = ? AND is_active = 1
       ORDER BY sort_order, id`,
      [GOLD_STELLA_SOURCE.routeCode, GOLD_STELLA_SOURCE.shipName]
    );
    if (rows.length) {
      return rows.map((row) => ({
        ...row,
        weekday_fare: toNumber(row.weekday_fare) || 0,
        holiday_fare: toNumber(row.holiday_fare) || 0,
      }));
    }
  } catch (e) {
    if (!e || e.code !== '42P01') throw e;
  }

  return DEFAULT_GOLD_STELLA_RULES.map((rule) => ({
    route_code: GOLD_STELLA_SOURCE.routeCode,
    ship_name: GOLD_STELLA_SOURCE.shipName,
    vehicle_label: rule.vehicle_label,
    weekday_fare: rule.weekday_fare,
    holiday_fare: rule.holiday_fare,
    source_title: GOLD_STELLA_SOURCE.sourceTitle,
    source_url: GOLD_STELLA_SOURCE.sourceUrl,
    sort_order: rule.sort_order,
    is_active: 1,
  }));
}

function pickBestRule(vehicleType, rules) {
  let best = null;
  for (const rule of rules) {
    const aliases = splitAliases(rule.vehicle_label);
    for (const alias of aliases) {
      const score = scoreAliasMatch(vehicleType, alias);
      if (!score) continue;
      if (!best || score > best.score || (score === best.score && Number(rule.sort_order || 9999) < Number(best.rule.sort_order || 9999))) {
        best = { rule, score, alias };
      }
    }
  }
  return best;
}

async function getGoldStellaFerryFareQuote(options = {}) {
  const vehicleType = String(options.vehicleType || options.vehicle_type || '').trim();
  const routeMeta = options.routeMeta || {};
  const hasFerryLeg = !!(options.hasFerryLeg || routeMeta.hasFerryLeg || (Array.isArray(routeMeta.ferryLegs) && routeMeta.ferryLegs.length));
  const reservedDate = options.reservedDate || options.reserved_date || null;
  const dayType = String(options.dayType || '').trim().toLowerCase() || weekdayTypeFromDate(reservedDate);
  const effectiveDayType = dayType === 'holiday' || dayType === 'weekend' ? 'holiday' : 'weekday';

  if (!hasFerryLeg) {
    return {
      enabled: false,
      ferryApplied: false,
      ferryFare: 0,
      ferryMatched: false,
      ferryNeedVehicleType: false,
      ferryDayType: effectiveDayType,
      ferrySourceLabel: GOLD_STELLA_SOURCE.sourceTitle,
      ferrySourceUrl: GOLD_STELLA_SOURCE.sourceUrl,
      ferryNote: null,
      vehicleType: vehicleType || null,
    };
  }

  if (!vehicleType) {
    return {
      enabled: true,
      ferryApplied: false,
      ferryFare: null,
      ferryMatched: false,
      ferryNeedVehicleType: true,
      ferryDayType: effectiveDayType,
      ferrySourceLabel: GOLD_STELLA_SOURCE.sourceTitle,
      ferrySourceUrl: GOLD_STELLA_SOURCE.sourceUrl,
      ferryNote: '도선료 계산을 위해 차종 정보가 필요합니다.',
      vehicleType: null,
    };
  }

  const rules = await loadFerryFareRules();
  const best = pickBestRule(vehicleType, rules);
  if (!best) {
    return {
      enabled: true,
      ferryApplied: false,
      ferryFare: null,
      ferryMatched: false,
      ferryNeedVehicleType: false,
      ferryDayType: effectiveDayType,
      ferrySourceLabel: GOLD_STELLA_SOURCE.sourceTitle,
      ferrySourceUrl: GOLD_STELLA_SOURCE.sourceUrl,
      ferryNote: '입력한 차종과 일치하는 골드스텔라 도선료 항목을 찾지 못했습니다.',
      vehicleType,
    };
  }

  const rule = best.rule;
  const ferryFare = effectiveDayType === 'holiday' ? Number(rule.holiday_fare) : Number(rule.weekday_fare);
  return {
    enabled: true,
    ferryApplied: true,
    ferryMatched: true,
    ferryFare,
    ferryFareLabel: rule.vehicle_label,
    ferryMatchAlias: best.alias,
    ferryNeedVehicleType: false,
    ferryDayType: effectiveDayType,
    ferrySourceLabel: rule.source_title || GOLD_STELLA_SOURCE.sourceTitle,
    ferrySourceUrl: rule.source_url || GOLD_STELLA_SOURCE.sourceUrl,
    ferryNote: null,
    vehicleType,
  };
}

module.exports = {
  GOLD_STELLA_SOURCE,
  getGoldStellaFerryFareQuote,
  weekdayTypeFromDate,
};