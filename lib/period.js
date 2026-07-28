// 대시보드 기간 프리셋(전일/금일/전주/금주/전월/금월/커스텀) 계산 헬퍼.
// 서버 타임존과 무관하게 KST 기준 날짜를 얻기 위해 UTC 시각에 +9시간을 더한 뒤 UTC getter로 읽는다.
function kstNow() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}
function toDateStr(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

const PRESET_LABELS = {
  yesterday: '전일', today: '금일', this_week: '금주', last_week: '전주',
  this_month: '금월', last_month: '전월',
};

function periodRange(preset, customFrom, customTo) {
  if (preset === 'custom' && customFrom && customTo) return { from: customFrom, to: customTo };

  const now = kstNow();
  const dow = now.getUTCDay(); // 0=일 ... 6=토 (kstNow 보정 덕분에 KST 기준 요일)
  const mondayOffset = dow === 0 ? -6 : 1 - dow;
  const thisMonday = addDays(now, mondayOffset);

  let from, to;
  if (preset === 'yesterday') { from = to = addDays(now, -1); }
  else if (preset === 'today') { from = to = now; }
  else if (preset === 'this_week') { from = thisMonday; to = now; }
  else if (preset === 'last_week') { from = addDays(thisMonday, -7); to = addDays(thisMonday, -1); }
  else if (preset === 'this_month') { from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); to = now; }
  else if (preset === 'last_month') {
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0));
  } else {
    return { from: null, to: null };
  }
  return { from: toDateStr(from), to: toDateStr(to) };
}

function previousPeriod(from, to) {
  if (!from || !to) return { from: null, to: null };
  const f = new Date(from + 'T00:00:00Z');
  const t = new Date(to + 'T00:00:00Z');
  const days = Math.round((t - f) / 86400000) + 1;
  const prevTo = addDays(f, -1);
  const prevFrom = addDays(prevTo, -(days - 1));
  return { from: toDateStr(prevFrom), to: toDateStr(prevTo) };
}

module.exports = { periodRange, previousPeriod, PRESET_LABELS, kstNow, toDateStr };
