function parseRetryAfterMs(retryAfterRaw) {
  if (!retryAfterRaw) return null;

  const value = String(retryAfterRaw).trim();
  if (!value) return null;

  const asSeconds = Number(value);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    return Math.ceil(asSeconds * 1000);
  }

  const asDate = Date.parse(value);
  if (!Number.isFinite(asDate)) return null;

  return Math.max(0, asDate - Date.now());
}

function strictRetryDelayMs(headers, attempt) {
  const retryAfterMs = parseRetryAfterMs(headers && headers['retry-after']);
  if (retryAfterMs !== null) {
    // 서버가 요구한 대기를 우선하되, 테스트 타임아웃을 넘지 않게 상한을 둔다.
    return Math.min(Math.max(retryAfterMs, 300), 5000);
  }

  return Math.min(400 * (attempt + 1), 2000);
}

module.exports = {
  strictRetryDelayMs,
};
