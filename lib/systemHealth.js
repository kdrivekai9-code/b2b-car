// 조용히 멈춘 기능을 드러내는 상태판.
//
// 왜 필요한가: 2026-08-24 하루에 오래 멈춰 있던 기능 두 개가 한꺼번에 드러났다.
//   · 콜마너 동기화 — 7일 정지(배차·운행시작·완료 감지와 고객 통보가 전부 멈춤)
//   · 상담원 답변 초안 — 16일간 0건(30초 무응답 자동 발송이 발동할 대상 자체가 없었음)
// 둘 다 "실패해도 서비스가 멈추면 안 된다"고 일부러 조용히 삼키는 자리였다. 그 설계는 맞지만,
// "한 번도 성공하지 못하는" 상태와 "가끔 실패하는" 상태를 구분할 방법이 없어서 아무도 몰랐다.
// 로그에는 매분 같은 한 줄이 남고 있었는데도.
//
// 그래서 건수만 세지 않고 **마지막으로 성공한 시각**을 함께 본다. 건수 0은 "고장"일 수도 있고
// "그럴 일이 없었다"일 수도 있어서 그것만으로는 판단할 수 없다.
//
// 경고는 그 구분이 분명한 항목에만 붙인다 — 매분 돌아야 하는 것이 10분째 안 돌면 확실히 이상이다.
// 트래픽이 있어야 생기는 것(초안 등)은 숫자만 보여주고 판단은 사람에게 맡긴다. 잘못된 경고가
// 쌓이면 진짜 경고도 같이 무시된다.
const db = require('../db');

// 매분 도는 크론이 이 시간 넘게 성공 기록을 남기지 못하면 멈춘 것으로 본다.
const SYNC_STALE_MINUTES = 10;

// 시각 값이 두 형태로 온다 — KST 문자열('YYYY-MM-DD HH:MM:SS')과 Date(timestamptz 컬럼).
// 문자열은 시간대 표시가 없어서 그냥 파싱하면 서버 시간대(UTC)로 읽혀 9시간이 어긋난다.
function minutesSince(value) {
  if (!value) return null;
  const t = value instanceof Date
    ? value.getTime()
    : Date.parse(String(value).replace(' ', 'T') + '+09:00');
  if (!Number.isFinite(t)) return null;
  return Math.floor((Date.now() - t) / 60000);
}

function describeAge(minutes) {
  if (minutes == null) return '기록 없음';
  if (minutes < 1) return '방금';
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.floor(hours / 24)}일 전`;
}

async function collectSystemHealth() {
  const [sync, notify, suggestions, errors] = await Promise.all([
    // 콜마너 동기화 — 매분 돌고, 성공할 때만 커서를 갱신한다. 이 시각이 곧 마지막 성공이다.
    db.get(`SELECT MAX(updated_at) AS last FROM callmaner_sync_state`)
      .catch((e) => { console.error('동기화 상태 조회 실패:', e.message); return null; }),
    // 시각 컬럼의 타입이 표마다 다르다 — 이 표만 timestamptz고, 나머지(chat_suggestions,
    // callmaner_sync_state, integration_errors)는 KST 문자열(text)이다. 섞어 비교하면
    // "operator does not exist"로 던지므로 표마다 맞춰 쓴다. 실제로 두 번 틀렸다.
    db.get(`
      SELECT COUNT(*) FILTER (WHERE status = 'sent')   AS sent,
             COUNT(*) FILTER (WHERE status = 'failed') AS failed,
             MAX(sent_at) AS last_sent
        FROM kakao_order_notifications
       WHERE created_at > now() - interval '24 hours'
    `).catch((e) => { console.error('통보 집계 실패:', e.message); return null; }),
    db.get(`
      SELECT COUNT(*) AS total, MAX(created_at) AS last
        FROM chat_suggestions
       WHERE created_at > to_char(now() at time zone 'Asia/Seoul' - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')
    `).catch((e) => { console.error('초안 집계 실패:', e.message); return null; }),
    // created_at은 timestamptz가 아니라 KST 문자열(text)이다 — now()와 직접 비교하면
    // "operator does not exist: text > timestamp with time zone"으로 던진다. 아래 .catch가
    // 그걸 삼켜서 0건으로 보였다(이 파일을 만들면서 실제로 그랬다 — 7,942건이 있는데 0으로
    // 표시됐다). 이 화면이 막으려는 바로 그 함정이라 문자열끼리 비교한다.
    db.get(`
      SELECT COUNT(*) AS total, MAX(created_at) AS last
        FROM integration_errors
       WHERE created_at > to_char(now() at time zone 'Asia/Seoul' - interval '24 hours', 'YYYY-MM-DD HH24:MI:SS')
    `).catch((e) => { console.error('연동 오류 집계 실패:', e.message); return null; }),
  ]);

  const syncMinutes = minutesSince(sync && sync.last);
  const suggestionLast = suggestions && suggestions.last;

  const items = [
    {
      key: 'callmaner_sync',
      label: '콜마너 동기화',
      value: describeAge(syncMinutes),
      // 매분 도는 것이라 10분이면 확실히 멈춘 것이다. 멈추면 배차·운행시작·완료 감지와
      // 고객 통보가 전부 따라 멈춘다 — 이 화면에서 가장 먼저 봐야 할 줄이다.
      level: syncMinutes == null || syncMinutes > SYNC_STALE_MINUTES ? 'bad' : 'ok',
      hint: syncMinutes == null || syncMinutes > SYNC_STALE_MINUTES
        ? '배차·운행시작·완료 감지와 고객 통보가 함께 멈춥니다.'
        : '매분 실행됩니다.',
    },
    {
      key: 'order_notify',
      label: '고객 통보 (24시간)',
      value: `발송 ${Number((notify && notify.sent) || 0)}건 · 실패 ${Number((notify && notify.failed) || 0)}건`,
      level: Number((notify && notify.failed) || 0) > 0 ? 'warn' : 'ok',
      hint: (notify && notify.last_sent) ? `마지막 발송 ${describeAge(minutesSince(notify.last_sent))}` : '최근 발송 없음',
    },
    {
      key: 'agent_suggestion',
      label: '상담원 답변 초안 (24시간)',
      value: `${Number((suggestions && suggestions.total) || 0)}건`,
      // 상담원 응대가 있어야 생기는 값이라 0이 곧 고장은 아니다 — 경고를 붙이지 않고
      // 마지막 생성 시각을 함께 보여준다. 며칠째 0이면 그게 신호다.
      level: 'ok',
      hint: suggestionLast ? `마지막 생성 ${describeAge(minutesSince(suggestionLast))}` : '최근 생성 없음',
    },
    {
      key: 'integration_errors',
      label: '연동 오류 (24시간)',
      value: `${Number((errors && errors.total) || 0)}건`,
      level: Number((errors && errors.total) || 0) > 0 ? 'warn' : 'ok',
      hint: (errors && errors.last) ? `마지막 ${describeAge(minutesSince(errors.last))}` : '없음',
      href: '/integration-errors',
    },
  ];

  return { items, worst: items.some((i) => i.level === 'bad') ? 'bad' : (items.some((i) => i.level === 'warn') ? 'warn' : 'ok') };
}

module.exports = { collectSystemHealth, minutesSince, describeAge, SYNC_STALE_MINUTES };
