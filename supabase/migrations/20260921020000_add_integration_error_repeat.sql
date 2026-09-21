-- 같은 연동 오류가 반복되면 줄을 늘리지 않고 횟수만 센다.
--
-- 왜 필요한가(사용자 지시 2026-09-21): 바깥(콜마너)이 고장 나 매분 같은 오류 3건이 그대로
-- 쌓였다. 19분에 57건. 이 상태가 몇 시간 이어지면 연동 오류 화면은 같은 줄로 가득 차고,
-- 그 사이에 난 **진짜 다른 오류가 그 밑에 묻힌다.** 실제로 9월 초에도 같은 일이 있었다
-- (AUTO_SEND_NOTICE is not defined가 10분에 10건).
--
-- 접는 기준은 "무엇이 잘못됐는가"가 같은 것 — source + operation + ref_type + ref_id + message다.
-- error_code는 기준에 넣지 않는다. 같은 실패의 코드가 비었다 채워졌다 하면 한 사건이 두 줄로
-- 갈라지기 때문이다.
--
-- repeat_count: 이 줄이 대표하는 발생 횟수. 처음 기록될 때가 1이다.
-- last_seen_at : 마지막으로 같은 오류가 난 시각. created_at은 **처음** 난 시각으로 남겨둔다 —
--                둘이 있어야 "언제부터 언제까지 몇 번"을 읽을 수 있다.
--
-- 기존 줄은 repeat_count=1, last_seen_at=created_at으로 채운다. 접기 이전에 쌓인 줄들은
-- 실제로 한 번씩 기록된 것이 맞으므로 이 값이 사실과 어긋나지 않는다.
ALTER TABLE integration_errors ADD COLUMN IF NOT EXISTS repeat_count integer NOT NULL DEFAULT 1;
ALTER TABLE integration_errors ADD COLUMN IF NOT EXISTS last_seen_at text;

UPDATE integration_errors SET last_seen_at = created_at WHERE last_seen_at IS NULL;

-- 접을 대상을 찾는 조회(같은 묶음의 가장 최근 줄)를 위한 인덱스.
-- message는 최대 1000자라 인덱스 키에 통째로 넣지 않고, 앞부분만 본다 — 실제 조회는
-- 이 인덱스로 후보를 좁힌 뒤 message를 비교한다.
CREATE INDEX IF NOT EXISTS idx_integration_errors_fold
  ON integration_errors (source, operation, ref_type, ref_id, id DESC);
