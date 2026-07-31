const db = require('../db');

const GOLD_STELLA_SOURCE = {
  routeCode: 'WANDO_JEJU',
  shipName: '골드스텔라',
  sourceTitle: '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)',
  sourceUrl: 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do',
};

const OCEAN_VISTA_SOURCE = {
  routeCode: 'SAMCHEONPO_JEJU',
  shipName: '오션비스타제주',
  sourceTitle: '현성MCT 오션비스타제주호 차량운임(홈페이지 기준, 평일/주말 요금 구분 없음)',
  sourceUrl: 'https://www.oceanvista.co.kr/theme/main/html/price_car.php',
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
    vehicle_label: '다이너스티, 아카디아, SM7, 그랜져, 그랜저, 스테이츠맨, 오피러스, 아슬란, 체어맨, 임팔라, K7, 제네시스, 제네시스 G80, 알페온, K9, 코란도 C, 올란도, 넥쏘(수소차), K8, 아이오닉5(전기차), 아이오닉6(전기차), EV6(전기차), 엔터프라이즈, 포텐샤, 베리타스, 훼미리, 뷰티플코란도, 제네시스 G80(전기차), 제네시스 GV60(전기차), 코란도 EV(전기차), 티볼리에어',
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

// 오션비스타제주(삼천포신항-제주항) 차량운임 — 2026-07-31 기준 공식 홈페이지(oceanvista.co.kr)
// "정상요금" 컬럼 조사. 사이트 자체에 평일/주말 구분(할증요금 칼럼)이 없어 weekday=holiday로 둔다.
// 오토바이/버스는 이 플랫폼이 실제 취급하는 차종과 거리가 있어 제외했다.
const DEFAULT_OCEAN_VISTA_RULES = [
  { vehicle_label: '마티즈, 모닝, 비스토, 스파크, 아토스, 포니', weekday_fare: 130000, holiday_fare: 130000, sort_order: 1 },
  { vehicle_label: '다마스, 라보, 레이, 캐스퍼, 클릭, 프라이드', weekday_fare: 138000, holiday_fare: 138000, sort_order: 2 },
  { vehicle_label: 'i30, 리오, 베르나, 세라토, 아베오, 아벨라, 엑센트, 젠트라, 칼로스, 클리오', weekday_fare: 152000, holiday_fare: 152000, sort_order: 3 },
  { vehicle_label: 'K3, QM3, SM3, 라비타, 라세티, 베뉴, 벨로스터, 셀토스, 스토닉, 스펙트라, 아반떼, 아이오닉, 캡처, 코나, 크레도스, 크루즈, 투스카니, 트랙스, 티볼리, 포르테', weekday_fare: 168000, holiday_fare: 168000, sort_order: 4 },
  { vehicle_label: 'G70, i40, K5, SM5, SM6, XM3, 니로, 레조, 레토나, 로체, 리갈, 말리부, 매그너스, 소나타, 스팅어, 쏘울, 엑스트랙, 옵티마, 제네시스쿠페, 카렌스, 토스카, 트레블레이저, 프린스', weekday_fare: 183000, holiday_fare: 183000, sort_order: 5 },
  { vehicle_label: 'GV60, K7, K8, SM7, 그랜저, 그랜져, 넥쏘, 스테이츠맨, 스포티지, 알페온, 올란도, 임팔라, 카스타, 코란도C, 투싼, 포텐샤', weekday_fare: 201000, holiday_fare: 201000, sort_order: 6 },
  { vehicle_label: 'EQ900, G80, G90, GV70, K9, QM5, QM6, 갤로퍼, 그랑콜레오스, 다이너스티, 렉스턴, 무쏘, 싼타페, 쏘렌토, 아슬란, 액티언, 에쿠스, 오피러스, 윈스톰, 이쿼녹스, 제네시스 BH330, 제네시스 DH, 체어맨, 카이런, 캡티바, 코란도, 테라칸, 토레스, 트라제, 필랑트', weekday_fare: 212000, holiday_fare: 212000, sort_order: 7 },
  { vehicle_label: '맥스크루즈, 베라크루즈, 산타크루즈', weekday_fare: 236000, holiday_fare: 236000, sort_order: 8 },
  { vehicle_label: 'GV80, 렉스턴 스포츠, 모하비, 무쏘 스포츠, 액티언 스포츠, 코란도 스포츠, 팰리세이드', weekday_fare: 247000, holiday_fare: 247000, sort_order: 9 },
  { vehicle_label: '그랜드스타렉스, 그랜드카니발, 그레이스투어, 로디우스, 스타리아, 이스타나, 콜로라도, 타스만, 토픽, 투리스모, 트래버스, 프레지오', weekday_fare: 258000, holiday_fare: 258000, sort_order: 10 },
  { vehicle_label: '벤츠 스마트(전기차), 삼성 트위지(전기차), 쎄보-C(전기차), 에디슨 EV D2(전기차), 에디슨 EVZ(전기차)', weekday_fare: 98000, holiday_fare: 98000, sort_order: 11 },
  { vehicle_label: 'E-토비(전기차), 레이(전기차), 캐스퍼 EV(전기차)', weekday_fare: 138000, holiday_fare: 138000, sort_order: 12 },
  { vehicle_label: 'SM3(전기차), 볼트(전기차), 아이오닉(전기차), 조에(전기차), 코나(전기차)', weekday_fare: 168000, holiday_fare: 168000, sort_order: 13 },
  { vehicle_label: 'EV3(전기차), EV4(전기차), 니로(전기차), 쏘울(전기차)', weekday_fare: 183000, holiday_fare: 183000, sort_order: 14 },
  { vehicle_label: 'EV6(전기차), GV60(전기차), 아이오닉5(전기차), 아이오닉6(전기차), 코란도(전기차)', weekday_fare: 201000, holiday_fare: 201000, sort_order: 15 },
  { vehicle_label: 'EV5(전기차), G80(전기차), GV70(전기차), 토레스 EV(전기차)', weekday_fare: 212000, holiday_fare: 212000, sort_order: 16 },
  { vehicle_label: 'EV9(전기차), GV80(전기차), PV5(전기차), 무쏘 EV(전기차), 아이오닉9(전기차)', weekday_fare: 247000, holiday_fare: 247000, sort_order: 17 },
  { vehicle_label: '쎄아(전기차), 이티밴(전기차)', weekday_fare: 258000, holiday_fare: 258000, sort_order: 18 },
  { vehicle_label: '1톤(공차)(전기차)', weekday_fare: 192000, holiday_fare: 192000, sort_order: 19 },
  { vehicle_label: '1톤(적차)(전기차)', weekday_fare: 217000, holiday_fare: 217000, sort_order: 20 },
  { vehicle_label: '1.2톤(공차), 1.4톤(공차), ST1(공차)', weekday_fare: 214000, holiday_fare: 214000, sort_order: 21 },
  { vehicle_label: '1.2톤(적차), 1.4톤(적차), ST1(적차)', weekday_fare: 244000, holiday_fare: 244000, sort_order: 22 },
  { vehicle_label: '국산 캠핑카(5m미만), 국산 캠핑트레일러(5m미만)', weekday_fare: 285000, holiday_fare: 285000, sort_order: 23 },
  { vehicle_label: '국산 캠핑카(5m~6m미만), 국산 캠핑트레일러(5m~6m미만)', weekday_fare: 350000, holiday_fare: 350000, sort_order: 24 },
  { vehicle_label: '국산 캠핑카(6m~7m미만), 국산 캠핑트레일러(6m~7m미만)', weekday_fare: 380000, holiday_fare: 380000, sort_order: 25 },
  { vehicle_label: '국산 캠핑카(7m~8m미만), 국산 캠핑트레일러(7m~8m미만)', weekday_fare: 412000, holiday_fare: 412000, sort_order: 26 },
  { vehicle_label: '외제 캠핑카(5m미만), 외제 캠핑트레일러(5m미만)', weekday_fare: 311000, holiday_fare: 311000, sort_order: 27 },
  { vehicle_label: '외제 캠핑카(5m~6m미만), 외제 캠핑트레일러(5m~6m미만)', weekday_fare: 375000, holiday_fare: 375000, sort_order: 28 },
  { vehicle_label: '외제 캠핑카(6m~7m미만), 외제 캠핑트레일러(6m~7m미만)', weekday_fare: 405000, holiday_fare: 405000, sort_order: 29 },
  { vehicle_label: '외제 캠핑카(7m~8m미만), 외제 캠핑트레일러(7m~8m미만)', weekday_fare: 437000, holiday_fare: 437000, sort_order: 30 },
  {
    vehicle_label: 'BMW 1시리즈, BMW 2시리즈, BMW 3시리즈, BMW 4시리즈, BMW X1, BMW X2, BMW Z4, DS3, 닛산 쥬크, 닛산 캐시카이, 닛산 큐브, 닛산 피가로, 렉서스 CT, 링컨 LS, 링컨 MKZ, 마쯔다 MX-5, 미니 S, 미니 SD, 미니 컨버터블, 미니 쿠퍼, 미니 쿠페, 벤츠 A-Class, 벤츠 B-Class, 벤츠 C-Class, 벤츠 CL, 벤츠 CLA, 벤츠 CLK, 벤츠 GLA, 벤츠 GLK, 볼보 C30, 볼보 V40, 스즈키 짐니, 스즈키 허슬러, 시트로엥 C3, 아우디 A1, 아우디 A3, 아우디 A4, 아우디 A5, 아우디 Q2, 아우디 TT, 아우디 TTS, 인피니티 G37, 인피니티 Q30, 지프 레니게이드, 지프 컴패스, 코펜, 크라이슬러 PT크루저, 토요타 비비, 토요타 윌비, 토요타 프리우스, 포드 몬데오, 포드 이스케이프, 포드 포커스, 폭스바겐 골프, 폭스바겐 뉴비틀, 폭스바겐 시로코, 폭스바겐 제타, 폭스바겐 티록, 폭스바겐 폴로, 푸조 206, 푸조 207, 푸조 208, 푸조 307, 푸조 308, 푸조 RCZ, 피아트 500, 혼다 CR-Z, 혼다 HR-V, 혼다 N1, 혼다 S660, 혼다 시빅',
    weekday_fare: 212000, holiday_fare: 212000, sort_order: 31,
  },
  {
    vehicle_label: 'BMW 5시리즈, BMW 6시리즈, BMW X3, BMW X4, DS4, DS5, DS6, DS7, 닛산 로그, 닛산 맥시마, 닛산 무라노, 닛산 알티마, 닷지 캘리버, 렉서스 ES, 렉서스 IS, 렉서스 NX, 렉서스 RC, 렉서스 SC, 렉서스 UX, 링컨 MKC, 링컨 노틸러스, 링컨 코세어, 미니 컨트리맨, 미니 클럽맨, 미쓰비시 RVR, 미쓰비시 랜서, 미쓰비시 랜서 에볼루션, 미쓰비시 아웃랜더, 미쓰비시 이클립스, 벤츠 CLE, 벤츠 CLS, 벤츠 E-Class, 벤츠 GLB, 벤츠 GLC, 볼보 S40, 볼보 S60, 볼보 V50, 볼보 V60, 볼보 XC40, 볼보 XC60, 쉐보레 S-10, 스바루 레거시, 시트로엥 C4, 아우디 A6, 아우디 Q3, 아우디 RS5, 아우디 RS6, 아우디 S4, 아우디 S5, 아우디 S6, 인피니티 EX35, 인피니티 GX35, 인피니티 M30, 인피니티 Q50, 인피니티 Q70, 인피니티 QX70, 재규어 S, 재규어 X, 재규어 XE, 재규어 XF, 재규어 XJL, 재규어 XJS, 재규어 XK, 캐딜락 CT4, 캐딜락 STS, 크라이슬러 200, 토요타 GR86, 토요타 RAV4, 토요타 수프라, 토요타 아발론, 토요타 캠리, 토요타 크라운, 토요타 GT86, 포드 쿠가, 포드 토러스, 포드 퓨전, 폭스바겐 CC, 폭스바겐 아테온, 폭스바겐 티구안, 폭스바겐 파사트, 푸조 3008, 푸조 408/508, 푸조 5008, 혼다 CR-V, 혼다 레전드, 혼다 스탭왜건, 혼다 어코드',
    weekday_fare: 248000, holiday_fare: 248000, sort_order: 32,
  },
  {
    vehicle_label: 'BMW 7시리즈, BMW 8시리즈, BMW M3, BMW M4, BMW M5, BMW X3M, BMW X4M, BMW X5, BMW X6, 닛산 370Z, 닛산 GT-R, 닛산 엑스테라, 닛산 엑스트레일, 닛산 패스파인더, 랜드로버 디스커버리 스포츠, 랜드로버 이보크, 랜드로버 프리랜더, 렉서스 LS, 렉서스 RX, 링컨 MKS, 링컨 MKX, 링컨 컨티넨탈, 링컨 타운카, 미쓰비시 파제로, 벤츠 GLE, 벤츠 M-Class, 벤츠 S-Class, 벤츠 SL, 볼보 S70, 볼보 S80, 볼보 S90, 볼보 V90, 볼보 XC70, 볼보 XC90, 쉐보레 카마로, 시트로엥 C5, 아우디 A7, 아우디 Q5, 아우디 RS7, 아우디 S7, 인피니티 QX50, 인피니티 QX55, 인피니티 QX60, 인피니티 FX, 재규어 E-페이스, 재규어 F-타입, 재규어 F-페이스, 재규어 I-페이스, 재규어 XJ, 재규어 XJR, 캐딜락 CT5, 캐딜락 CT6, 캐딜락 XT4, 캐딜락 XT5, 토요타 랜드크루저, 토요타 시에나, 토요타 알파드, 토요타 타코마, 토요타 하이랜더, 포르쉐 박스터, 포르쉐 카이맨, 폭스바겐 투아렉, 폭스바겐 페이톤, 혼다 앨리먼트, 혼다 크로스투어',
    weekday_fare: 280000, holiday_fare: 280000, sort_order: 33,
  },
  {
    vehicle_label: 'BMW X7, GMC 시에라, GMC 유콘, 닛산 NV밴, 닛산 타이탄, 닛산 프론티어, 닷지 다코타, 랜드로버 디스커버리, 랜드로버 디펜더, 랜드로버 벨라, 벤츠 AMG GT, 벤츠 AMG GTS, 벤츠 GLS, 아우디 A8, 아우디 Q7, 아우디 Q8, 아우디 S8, 인피니티 QX80, 지프 그랜드 체로키, 지프 랭글러, 지프 체로키, 캐딜락 CTS-V, 캐딜락 XT6, 크라이슬러 퍼시피카, 토요타 세콰이어, 토요타 툰드라, 포드 E150, 포드 랩터, 포드 레인저, 포드 브롱코, 포드 익스페디션, 포드 익스플로러, 포드 트랜짓, 포르쉐 마칸, 폭스바겐 캐디, 혼다 릿지라인, 혼다 오딧세이, 혼다 파일럿, 혼다 호라이즌, 르노마스터 밴, 쉐보레 타호, 외제승용차 밴, 포드 E350',
    weekday_fare: 313000, holiday_fare: 313000, sort_order: 34,
  },
  {
    vehicle_label: 'BMW X5M, BMW X6M, 닷지 램, 랜드로버 레인지로버, 랜드로버 레인지로버 스포츠, 렉서스 LC, 렉서스 LM500H, 렉서스 LX700H, 링컨 네비게이터, 링컨 에비에이터, 마세라티 기블리, 벤츠 G바겐, 벤츠 스프린터, 쉐보레 익스프레스, 쉐보레 스타크래프트, 쉐보레 콜벳, 아우디 RSQ8, 재규어 F-타입SVR, 지프 글래디에이터, 캐딜락 에스컬레이드, 포드 F-150, 포드 F-250, 포드 머스탱, 포르쉐 911, 포르쉐 카이엔, 포르쉐 파나메라, 허머 H1, 허머 H2',
    weekday_fare: 357000, holiday_fare: 357000, sort_order: 35,
  },
  {
    vehicle_label: 'BMW I8, BMW M8, 람보르기니 전차량, 롤스로이스 전차량, 마세라티 Grecale, 마세라티 MC20, 마세라티 르반떼, 마세라티 콰트로포르테, 맥라렌 전차량, 벤츠 마이바흐, 벤츠 마이바흐GLS, 벤틀리 전차량, 아우디 R8, 애스턴마틴 전차량, 페라리 전차량, 포르쉐 스파이더',
    weekday_fare: 605000, holiday_fare: 605000, sort_order: 36,
  },
];

const FERRY_ROUTES = {
  [GOLD_STELLA_SOURCE.routeCode]: { ...GOLD_STELLA_SOURCE, defaultRules: DEFAULT_GOLD_STELLA_RULES },
  [OCEAN_VISTA_SOURCE.routeCode]: { ...OCEAN_VISTA_SOURCE, defaultRules: DEFAULT_OCEAN_VISTA_RULES },
};
const DEFAULT_ROUTE_CODE = GOLD_STELLA_SOURCE.routeCode;

// 출발지 주소의 시/도 표기로 어느 도선 노선을 쓸지 정한다 — 강원/경남/경북/부산/울산 출발은
// 삼천포신항-제주(오션비스타) 노선을, 그 외(전남/완도 인근 등)는 완도-제주(골드스텔라)를 기본으로 쓴다.
const SAMCHEONPO_REGION_RE = /(강원|경상남도|경남|경상북도|경북|부산|울산)/;
function pickFerryRouteCode(originAddress) {
  const addr = String(originAddress || '').trim();
  if (SAMCHEONPO_REGION_RE.test(addr)) return OCEAN_VISTA_SOURCE.routeCode;
  return DEFAULT_ROUTE_CODE;
}

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

// 이전에는 일요일만 휴일로 쳐서 토요일/법정공휴일에 평일 요금이 잘못 적용됐다 — 토요일도
// 휴일로 보고, 공휴일은 public_holidays 테이블(연도별로 데이터를 채워둬야 함)로 확인한다.
async function weekdayTypeFromDate(dateStr) {
  if (!dateStr) return 'weekday';
  const date = new Date(`${dateStr}T00:00:00`);
  if (Number.isNaN(date.getTime())) return 'weekday';
  const day = date.getDay();
  if (day === 0 || day === 6) return 'holiday';
  try {
    const row = await db.get('SELECT 1 FROM public_holidays WHERE holiday_date = ?', [dateStr]);
    if (row) return 'holiday';
  } catch (e) {
    if (!e || e.code !== '42P01') throw e; // 마이그레이션 미반영 시(테이블 없음)에는 요일 기준만 사용
  }
  return 'weekday';
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

async function loadFerryFareRules(route) {
  try {
    const rows = await db.all(
      `SELECT route_code, ship_name, vehicle_label, weekday_fare, holiday_fare, source_title, source_url, sort_order, is_active
       FROM ferry_fare_rules
       WHERE route_code = ? AND ship_name = ? AND is_active = 1
       ORDER BY sort_order, id`,
      [route.routeCode, route.shipName]
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

  return (route.defaultRules || []).map((rule) => ({
    route_code: route.routeCode,
    ship_name: route.shipName,
    vehicle_label: rule.vehicle_label,
    weekday_fare: rule.weekday_fare,
    holiday_fare: rule.holiday_fare,
    source_title: route.sourceTitle,
    source_url: route.sourceUrl,
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

async function getFerryFareQuote(options = {}) {
  const vehicleType = String(options.vehicleType || options.vehicle_type || '').trim();
  const routeMeta = options.routeMeta || {};
  const hasFerryLeg = !!(options.hasFerryLeg || routeMeta.hasFerryLeg || (Array.isArray(routeMeta.ferryLegs) && routeMeta.ferryLegs.length));
  const reservedDate = options.reservedDate || options.reserved_date || null;
  const dayType = String(options.dayType || '').trim().toLowerCase() || await weekdayTypeFromDate(reservedDate);
  const effectiveDayType = dayType === 'holiday' || dayType === 'weekend' ? 'holiday' : 'weekday';

  const routeCode = options.routeCode || pickFerryRouteCode(options.originAddress || options.origin_address);
  const route = FERRY_ROUTES[routeCode] || FERRY_ROUTES[DEFAULT_ROUTE_CODE];

  if (!hasFerryLeg) {
    return {
      enabled: false,
      ferryApplied: false,
      ferryFare: 0,
      ferryMatched: false,
      ferryNeedVehicleType: false,
      ferryDayType: effectiveDayType,
      ferrySourceLabel: route.sourceTitle,
      ferrySourceUrl: route.sourceUrl,
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
      ferrySourceLabel: route.sourceTitle,
      ferrySourceUrl: route.sourceUrl,
      ferryNote: '도선료 계산을 위해 차종 정보가 필요합니다.',
      vehicleType: null,
    };
  }

  const rules = await loadFerryFareRules(route);
  const best = pickBestRule(vehicleType, rules);
  if (!best) {
    return {
      enabled: true,
      ferryApplied: false,
      ferryFare: null,
      ferryMatched: false,
      ferryNeedVehicleType: false,
      ferryDayType: effectiveDayType,
      ferrySourceLabel: route.sourceTitle,
      ferrySourceUrl: route.sourceUrl,
      ferryNote: '입력한 차종과 일치하는 도선료 항목을 찾지 못했습니다.',
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
    ferryRouteCode: route.routeCode,
    ferryShipName: route.shipName,
    ferrySourceLabel: rule.source_title || route.sourceTitle,
    ferrySourceUrl: rule.source_url || route.sourceUrl,
    ferryNote: null,
    vehicleType,
  };
}

module.exports = {
  GOLD_STELLA_SOURCE,
  OCEAN_VISTA_SOURCE,
  FERRY_ROUTES,
  DEFAULT_GOLD_STELLA_RULES,
  DEFAULT_OCEAN_VISTA_RULES,
  pickFerryRouteCode,
  getFerryFareQuote,
  weekdayTypeFromDate,
};
