-- 완도항 골드스텔라 차량 도선료(주중/휴일) 기준 테이블

create table if not exists ferry_fare_rules (
  id integer generated always as identity primary key,
  route_code text not null,
  ship_name text not null,
  vehicle_label text not null,
  weekday_fare integer not null,
  holiday_fare integer not null,
  source_title text,
  source_url text,
  sort_order integer not null default 0,
  is_active integer not null default 1,
  created_at text not null default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

create unique index if not exists idx_ferry_fare_rules_unique
  on ferry_fare_rules(route_code, ship_name, vehicle_label);

create index if not exists idx_ferry_fare_rules_lookup
  on ferry_fare_rules(route_code, ship_name, is_active, sort_order);

insert into ferry_fare_rules (
  route_code, ship_name, vehicle_label, weekday_fare, holiday_fare, source_title, source_url, sort_order, is_active
) values
  ('WANDO_JEJU', '골드스텔라', '티코, 마티즈, 비스토, 모닝, 스파크, 트위지(전기차), 스마트(전기차), 마이브(전기차), 캠시스(전기차), 마이브 M1(전기차), 캠시스 CEVO-C SE(전기차), 캠시스 CEVO-C VAN(전기차), 스마트 EV d2c(전기차), 스마트 EV d2p(전기차), 마스타 (전기차)', 95250, 101790, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 1, 1),
  ('WANDO_JEJU', '골드스텔라', '엑셀, 스쿠프, 아토스, 르망, 프레스토, 레이, 캐스퍼, 타우너, 다마스, 코닉세그 CCX, 캐스퍼(전기차), 레이 EV(전기차)', 108670, 116140, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 2, 1),
  ('WANDO_JEJU', '골드스텔라', '라보(공차), 포트로(공차/전기차)', 103000, 110470, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 3, 1),
  ('WANDO_JEJU', '골드스텔라', '라보(적차), 포트로(적차/전기차)', 117320, 128070, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 4, 1),
  ('WANDO_JEJU', '골드스텔라', '엑센트, 아벨라, 엘란, 슈마, 엘란트라, i30, 넥시아, 베르나, 클릭, 씨에로, 캐피탈, 리오, 티뷰론, 라노스, SM3, 칼로스, 세피아, 젠트라, 투스카니, 프라이드, 벨로스터, 클리오, 르노 조에(전기차), SM3(전기차), E토비(전기차)', 123420, 131820, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 5, 1),
  ('WANDO_JEJU', '골드스텔라', '라세티, 누비라SP, 크루즈, 아반떼, 레간자, 크레도스, 포르테, 라비타, 쎄라토, 스펙트라, 마르샤, 쏘울, K3, 아베오, 아이오닉(전기차), 제네시스 G70, QM3, 쉐보레 볼트EV(전기차), 티볼리, 니로, 코나, 스토닉, 베뉴, 에스페로, 콩코드, 프린스, 캡쳐, 아반떼투어링, 코나(전기차), 니로 EV(전기차), 니로 플러스(전기차), 쏘울(전기차), 쉐보레 볼트 EREV, 기아 XCEED, 아이오닉', 136780, 146120, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 6, 1),
  ('WANDO_JEJU', '골드스텔라', '쏘나타(전차종), 로체, SM5, SM6, 매그너스, 스팅어, i40, K5, 토스카, 옵티마, 카렌스, 레조, X트랙, 트랙스, 투싼, 레토나, 카스타, 록스타, 스포티지, 스포티지R, 싼타모, 제네시스 쿠페, 셀토스, 말리부, 트레일블레이저, XM3, 소나타, 리갈, 엑스트랙, 브롬, 슈퍼싸롱, EV3(전기차), 쉐보레 볼트EUV(전기차), 르노 아르카나, EV4(전기차), 다니고벤(전기차)', 150130, 160410, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 7, 1),
  ('WANDO_JEJU', '골드스텔라', '다이너스티, 아카디아, SM7, 그랜져, 스테이츠맨, 오피러스, 아슬란, 체어맨, 임팔라, K7, 제네시스, 제네시스 G80, 알페온, K9, 코란도 C, 올란도, 넥쏘(수소차), K8, 아이오닉5(전기차), 아이오닉6(전기차), EV6(전기차), 엔터프라이즈, 포텐샤, 베리타스, 훼미리, 뷰티플코란도, 제네시스 G80(전기차), 제네시스 GV60(전기차), 코란도 EV(전기차), 티볼리에어', 163860, 175070, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 8, 1),
  ('WANDO_JEJU', '골드스텔라', '이쿼녹스, 쌍용 무쏘, 갤로퍼, 코란도, 싼타페, 카이런, 엑티언, 테라칸, 쏘렌토, 캡티바, QM5, QM6, 에쿠스, EQ900, 제네시스 G90, 트라제, 제네시스 GV70, 토레스, 이쿼녹스 EV(전기차), 토레스 EVX(전기차), GV70 (전기차), 르노 그랑콜레오스, GM 윈스톰, EV5 (전기차), 르노 필랑트', 169740, 181880, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 9, 1),
  ('WANDO_JEJU', '골드스텔라', '렉스톤, 베라크루즈, 모하비, 맥스크루즈, 엑티언스포츠, 코란도스포츠, 코란도투리스모, 체어맨 리무진, 에쿠스 리무진, 제네시스 리무진, 그레이스, 카니발, 로디우스, 제네시스 GV80, 베스타, 펠리세이드, 팰리세이드, 렉스턴, PV5 (전기차)', 191760, 204830, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 10, 1),
  ('WANDO_JEJU', '골드스텔라', '이스타나, 토픽, 봉고(15인승), 그레이스(15인승), 프레지오, 봉고3(승합차), 그랜드스타렉스, 렉스턴 스포츠, 스타리아, 트래버스, 스타렉스, EV9(전기차), 타스만, 아이오닉9 (전기차), 무쏘 스포츠, 무쏘EV (전기차), KGM무쏘, 스타리아 (전기차)', 218570, 233520, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 11, 1),
  ('WANDO_JEJU', '골드스텔라', '무쏘칸(픽업)', 245570, 262380, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 12, 1),
  ('WANDO_JEJU', '골드스텔라', 'BMW Z3, 피아트 토포리노, 혼다 비트, 스즈키 카푸치노, 로버 미니, 혼다 S660, 다이하쓰 코펜, 스마트 포투, 스마트 로드스터, 오펠 스피드스터, 로터스 엘리스, 로터스 유로파, 다이하쓰 디베이스, 도요타 IQ, 스즈키 알토라팡, 다이하쓰 미라, 다이하쓰 미라지노, 도요타 사이언 iQ, 스즈키 마이티, 푸조 205, 스즈키 알토, 다이하쓰 캐스트, 혼다 N-ONE, 로버 MGF, 페라리 308, 다이하쓰 태프트, 도요타 MR, 미쯔오카 레인보우, 푸조 107, 미쓰비시 ek x ev (전기차), 다이하쓰 무브, 페라리 328, 로터스 엑시지, 스즈키 왜건, 마쯔다 mx-5, 닛산 휘가로, 스즈키 허슬러, 혼다 CRX, 닛산 파오, 피아트 모비, 피아트 124, 피아트 스파이더, 다이하쓰 탄토, 알파로메오 4C, 폭스바겐 업, 시트로엥 C2, 스즈키 스페시아, 재규어 E 타입, 혼다 N-BOX, 피아트 500, 500C, 스마트 포포, 르노 트윙고, 다이하쓰 웨이크, 폰티악 솔스티스, 도요타 사이언 xA, 혼다 S2000, 다이하쓰 분, 피아트 판다, 크라이슬러 크로스파이어, 혼다 NSX, 페라리 348, 다이하쓰 하이젯 트럭, 페라리 F355, 로터스 에스프리, 스마트 포스타스, 미니 컨버터블, 새턴 스카이, 다이하쓰 하이젯 카고, 다이하쓰 아틀레이, 다이하쓰 시리온, 미쯔오카 록스타, 부가티 EB110, 스즈키 셀레리오, 미쓰비시 미라지, 람보르기니 우라칸 에보, 포르쉐718, 미니쿠퍼(3도어 / 일반), 미니쿠퍼 해치백 SE(전기차), 미니쿠퍼 해치백 E(전기차), 미니쿠퍼 S로드스터, 스마트 포투(전기차), 푸조 104', 117530, 125000, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 13, 1),
  ('WANDO_JEJU', '골드스텔라', '닛산 마치, 페라리 F40, 피아트 우노, 도요타 사이언 FR-S, 닛산 실비아, 피아트 시에나, 람보르기니 가야르도, 벤츠 SLC클래스, 푸조 206, 스즈키 이그니스, 스즈키 스위프트, 도요타 아이고, 도요타 윌, 미쯔오카 히미코, 미쓰비시 FTO, 닛산 SX, GM 트랙커, 스즈키 사이드킥, 푸조 207, 푸조 306, 벤츠 SLK, 도요타 86, 스바루 BRZ, 도요타 셀리카, 혼다 CR-Z, 로터스 에보라, 오펠 아담, 푸조 1007, 다이하쓰 노리오리, 다이하쓰 템포, 페라리 512, 알파로메오 GTV, 람보르기니 디아블로, 마쯔다 아이코닉, 포르쉐 박스터, 알파로메오 미토, 포르쉐 카이맨, 오펠 코르사, 포드 GT, 르노 모뒤스, 도요타 사이언 xD, 푸조 208, 람보르기니 우라칸, 피아트 푼토, 람보르기니 우라칸 에보 스파이더, 닛산 Z, 란치아 입실론, 크라이슬러 ME 4-12, 새턴 SC, 폭스바겐 폴로, 파가니 존다, 혼다 프렐류드, 스즈키 발레노, 페라리 360, BMW Z4, 도요타 BB, 맥라렌 720 S, 도요타 야리스(비츠), 알파로메오 147, 스즈키 솔리오, 어큐라 RSX, 페라리 F430, 피아트 아르고, 크라이슬러 프라울러, 맥라렌 765lt, 캐딜락 XLR, 도요타 수프라, 부가티 베이론, 맥라렌 600 LT, 다이하쓰 마테리아, 푸조 RCZ, 페라리 296, 새턴 SL, 어큐라 NSX, 크라이슬러 네온, 맥라렌 아투라, 홀덴 비바 해치백, 스즈키 xbee, 마세라티 3200 GT, 페라리 458, 시트로엥 C4 칵투스, 벤츠 SLC43 amg, 아우디 R8, 미니쿠퍼 해치백 5도어, 푸조 E-208(전기차), 맥라렌 아투라(전기차), 페라리 296 GTB(전기차), 페라리 296 GTS(전기차), 르노 E-테크(전기차), 미니 에이스맨E(전기차), 아우디TT RS, 도요타 프리우스C, 아우디 A1, 로터스 에미라', 132440, 140840, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 14, 1),
  ('WANDO_JEJU', '골드스텔라', '1톤(공차), 봉고3(1톤/공차/전기차), 다나고 C(전기차), 다나고 L(전기차), 다나고 R(전기차), 다나고 T(전기차), 다나고 W(전기차), 젤라EV(공차/전기차), 마사다 픽업(공차/전기차), 전기차 1톤 공차(전기차), pv5 오픈베드 (공차/전기차)', 165740, 176950, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 15, 1),
  ('WANDO_JEJU', '골드스텔라', '1톤(적차), 봉고3(1톤/적차/전기차), 다나고 C(적차/전기차), 다나고 L(적차/전기차), 다나고 R(적차/전기차), 다나고 T(적차/전기차), 다나고 W(적차/전기차), 젤라EV(적차/전기차), 마사다 픽업(적차/전기차), 전기차 1톤 적차(전기차), pv5 오픈베드(적재/전기차)', 189740, 205280, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 16, 1),
  ('WANDO_JEJU', '골드스텔라', '1.2톤 / 1.4톤, ST1(공차/전기차), 1.2톤/1.4톤(전기차), 봉고3(1.2톤/공차/전기차), BYD T4K(공차/전기차), 리베로(공차)', 194870, 209820, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 17, 1),
  ('WANDO_JEJU', '골드스텔라', '1.2톤(적차) / 1.4톤(적차), ST1(적차/전기차), 1.2톤(적차)/1.4톤(적차)(전기차), 봉고3(1.2톤/적차/전기차), BYD T4K(적차/전기차), 리베로(적차)', 223330, 243640, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 18, 1),
  ('WANDO_JEJU', '골드스텔라', '캠핑카(5~6m미만), 1톤(이동식업무차), 장의, 웨딩 리무진 (소), 이비온 E6(전기차), 포터 씨티밴, 워크스루밴, 캠핑트레일러(5~6m미만)', 274310, 292990, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 19, 1),
  ('WANDO_JEJU', '골드스텔라', '캠핑카(6~7m미만), 장의, 웨딩 리무진 (대), 캠핑트레일러(6~7m미만)', 337710, 365730, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 20, 1),
  ('WANDO_JEJU', '골드스텔라', '캠핑카(7~8m미만), 캠핑트레일러(7~8m미만)', 401110, 438470, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 21, 1),
  ('WANDO_JEJU', '골드스텔라', '캠핑카(8~9m미만), 캠핑트레일러(8~9m미만)', 487170, 533870, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 22, 1),
  ('WANDO_JEJU', '골드스텔라', '캠핑카(9m이상), 캠핑트레일러(9m이상)', 584590, 640630, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 23, 1),
  ('WANDO_JEJU', '골드스텔라', '르노마스터, 포드 트랜짓 익스플로어, 르노마스터(전기차), 트라베리 EV (전기차), 쉐보레 HD', 290830, 313240, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 24, 1),
  ('WANDO_JEJU', '골드스텔라', '코러스, 콤비, 쏠라티, 레스타, 카운티, 카운티(전기차), 브이버스60(전기차), 브이버스(전기차)', 312500, 339580, '한일고속 선박요금 - 골드스텔라 차량요금(완도↔제주)', 'https://www.hanilexpress.co.kr/expressFerry/shipfare/shippingFareA.do', 25, 1)
on conflict (route_code, ship_name, vehicle_label) do nothing;
