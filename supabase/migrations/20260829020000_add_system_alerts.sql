-- 시스템 장애 알림.
--
-- 왜 필요한가(실측): 2026-08-19 ~ 08-24 사이 integration_errors에 콜마너 동기화 오류가
-- 7,737건 쌓였다. 그동안 배차·운행시작·완료 감지와 고객 통보가 7일간 멈춰 있었는데
-- 아무도 몰랐다 — 오류를 보고 알려주는 장치가 하나도 없었기 때문이다.
-- 로그에 남는 것과 사람이 아는 것은 다르다.

-- 관리자별 수신 여부. 기본 1(받음) — 장애 알림은 기본으로 켜져 있어야 의미가 있다.
-- 이미 구독 중인 사람에게도 켜준다(기본값은 새 행에만 적용되므로 UPDATE가 따로 필요하다).
ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS notify_system_alert integer DEFAULT 1;
UPDATE push_subscriptions SET notify_system_alert = 1 WHERE notify_system_alert IS NULL;

-- ── 알림 발송 이력 ─────────────────────────────────────────────────────────
-- 같은 장애로 매분 알림이 오면 사람은 곧 알림을 끈다. 그러면 정작 다음 장애를 놓친다.
-- alert_key마다 마지막 발송 시각을 두고 쿨다운 안에는 다시 보내지 않는다.
--
-- last_value를 함께 남기는 이유: 같은 장애라도 규모가 크게 뛰면(20건 → 500건) 다시 알려야
-- 한다. 쿨다운만 있으면 상황이 악화돼도 조용하다.
CREATE TABLE IF NOT EXISTS system_alert_state (
  alert_key    text PRIMARY KEY,
  last_sent_at timestamptz NOT NULL DEFAULT now(),
  last_value   integer,
  last_title   text,
  send_count   integer NOT NULL DEFAULT 1
);

-- 알림이 실제로 나갔는지 나중에 확인할 수 있어야 한다 — "장애였는데 알림이 왔었나?"를
-- 되짚지 못하면 이 장치를 믿을 수 없다.
CREATE TABLE IF NOT EXISTS system_alert_log (
  id         bigserial PRIMARY KEY,
  alert_key  text NOT NULL,
  title      text NOT NULL,
  body       text,
  value      integer,
  sent_to    integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS system_alert_log_created_idx ON system_alert_log(created_at DESC);

-- integration_errors를 시각 범위로 훑는 조회가 매 5분 돌므로 인덱스를 둔다.
CREATE INDEX IF NOT EXISTS integration_errors_created_idx ON integration_errors(created_at DESC);
