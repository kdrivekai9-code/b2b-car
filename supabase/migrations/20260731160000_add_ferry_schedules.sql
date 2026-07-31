-- 완도-제주 도선(페리) 운항 시간표 — 실제 배차/안내 참고용 데이터.
-- 주의: 여객선 시간표는 선사 사정으로 예고 없이 바뀔 수 있다(한일고속 홈페이지 안내 문구).
-- 아래 데이터는 2026-07-31 기준 웹 조사(전남일보 기사, 한일고속/여객선 정보 요약 게시물)로
-- 확보한 참고값이며, 실제 배차에 쓰기 전에는 한일고속(1688-2100)에 재확인이 필요하다.
create table if not exists ferry_schedules (
  id serial primary key,
  route_code text not null,
  ship_name text not null,
  origin_port text not null,
  destination_port text not null,
  departure_time text not null,
  arrival_time text,
  duration_minutes integer,
  operating_days text,
  note text,
  source_title text,
  source_url text,
  is_active integer not null default 1,
  created_at text default to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD HH24:MI:SS')
);

insert into ferry_schedules
  (route_code, ship_name, origin_port, destination_port, departure_time, arrival_time, duration_minutes, operating_days, note, source_title, source_url, is_active)
select v.route_code, v.ship_name, v.origin_port, v.destination_port, v.departure_time, v.arrival_time, v.duration_minutes, v.operating_days, v.note, v.source_title, v.source_url, v.is_active
from (values
  ('WANDO_JEJU', '골드스텔라', '완도항', '제주항', '09:20', '11:50', 150, '매일(일요일 제외)', '2025-01-15 취항. 완도-제주 노선 신설 선박.', '전남일보 - 한일고속 골드스텔라호 취항 기사', 'https://www.jnilbo.com/news/articleView.html?idxno=75887951034', 1),
  ('WANDO_JEJU', '골드스텔라', '제주항', '완도항', '16:00', '18:30', 150, '매일(일요일 제외)', '2025-01-15 취항. 완도-제주 노선 신설 선박.', '전남일보 - 한일고속 골드스텔라호 취항 기사', 'https://www.jnilbo.com/news/articleView.html?idxno=75887951034', 1),
  ('WANDO_JEJU', '실버클라우드', '완도항', '제주항', '02:30', '05:10', 160, '매일(일요일 제외)', '일요일 02:30편 휴항.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '실버클라우드', '완도항', '제주항', '15:00', '17:40', 160, '매일(토요일 제외)', '토요일 15:00편 휴항.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '실버클라우드', '제주항', '완도항', '08:40', NULL, 160, '매일', '출항시각이 자료마다 07:20~08:40로 다르게 나타남 — 확인 필요.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '실버클라우드', '제주항', '완도항', '19:30', '22:10', 160, '매일', NULL, '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '블루펄', '완도항', '제주항', '09:00', '11:40', 160, '매일(확인 필요)', '일부 자료는 블루펄이 골드스텔라로 대체됐다고도 함 — 실제 운항 여부 재확인 필요.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '블루펄', '제주항', '완도항', '17:10', '19:50', 160, '매일(확인 필요)', '일부 자료는 블루펄이 골드스텔라로 대체됐다고도 함 — 실제 운항 여부 재확인 필요.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 1),
  ('WANDO_JEJU', '송림블루오션', '완도항', '제주항(추자도 경유)', '07:30', NULL, 300, '확인 필요', '출항/도착 시각이 자료마다 상반되게 나타남(07:30~13:40 등) — 실제 시각 재확인 필요.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 0),
  ('WANDO_JEJU', '송림블루오션', '제주항(추자도 경유)', '완도항', '13:30', NULL, 300, '확인 필요', '출항/도착 시각이 자료마다 상반되게 나타남(08:00~18:30 등) — 실제 시각 재확인 필요.', '완도-제주 여객선 운항 시간표 요약 자료', 'https://tilnote.io/en/pages/68554be73b88c1fc499b2f05', 0)
) as v(route_code, ship_name, origin_port, destination_port, departure_time, arrival_time, duration_minutes, operating_days, note, source_title, source_url, is_active)
where not exists (
  select 1 from ferry_schedules existing where existing.route_code = 'WANDO_JEJU'
);
