#!/usr/bin/env node

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';
const fs = require('fs');
const path = require('path');

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRateLimitMeta(headers) {
  const policy = headers.get('ratelimit-policy') || '';
  const limit = headers.get('ratelimit-limit') || '';
  const remaining = headers.get('ratelimit-remaining') || '';
  const reset = headers.get('ratelimit-reset') || '';
  const retryAfter = headers.get('retry-after') || '';
  return {
    policy,
    limit,
    remaining,
    reset,
    retryAfter,
  };
}

function computeRetryDelayMs(attempt, meta, baseMs, maxMs) {
  const expBackoff = Math.min(baseMs * (2 ** (attempt - 1)), maxMs);
  const retryAfterSec = Number(meta.retryAfter || '');
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    return Math.min(Math.floor(retryAfterSec * 1000), maxMs);
  }
  const resetSec = Number(meta.reset || '');
  if (Number.isFinite(resetSec) && resetSec > 0) {
    return Math.min(Math.floor(resetSec * 1000), maxMs);
  }
  return expBackoff;
}

// 자동화는 QA 전용 계정만 쓴다.
//
// 예전 기본값은 admin / seoul_manager / seoulmotors였다 — 사람이 실제로 쓰는 계정이다.
// 로그인은 단일 세션이라 이 게이트가 돌면 **그 계정을 쓰던 사람이 로그아웃된다.** 2026-08-25에
// 같은 일이 실제로 났고(접속기록에 admin LOGIN_BLOCKED 5건), 그때 tests/e2e-credentials.js는
// 기본값을 qa_test_bot으로 바꿔 고쳤다. 이 게이트만 옛 기본값에 남아 있었다.
//
// 이 값이 중요한 이유가 하나 더 있다: 이 게이트를 푸시마다 돌리려면 낮에도 돌아야 하고,
// 낮에 실사용 계정으로 로그인하면 작업 중인 사람을 계속 튕겨낸다. 계정을 QA로 옮기는 것이
// 그 전제조건이다.
function getAccountsFromEnv() {
  return [
    {
      label: 'admin',
      loginId: process.env.LOGIN_ID_ADMIN || 'qa_test_bot',
      password: process.env.LOGIN_PASSWORD_ADMIN || '',
    },
    {
      label: 'branch_manager',
      loginId: process.env.LOGIN_ID_BRANCH_MANAGER || 'qa_test_branch_manager',
      password: process.env.LOGIN_PASSWORD_BRANCH_MANAGER || '',
    },
    {
      label: 'client',
      loginId: process.env.LOGIN_ID_CLIENT || 'qa_test_client',
      password: process.env.LOGIN_PASSWORD_CLIENT || '',
    },
  ];
}

// 한 번이라도 시도하기 전에 막는다.
//
// 비밀번호가 비어 있으면 그대로 로그인을 시도해 LOGIN_FAILURE가 쌓인다. 2026-08-25에 그렇게
// qa_test_bot에 실패 18건이 쌓이고 이어서 LOGIN_RATE_LIMITED 78건이 찍혀 정상 계정까지
// 잠겼다. 값이 없으면 조용히 틀린 값을 쓰는 대신 **즉시 멈추는 것**이 맞다.
//
// 계정 이름도 본다. QA 계정만 쓴다는 것이 주석에만 적혀 있으면 다음에 누가 워크플로에서
// 다시 admin을 넣는다 — 실제로 그렇게 됐다. 일부러 실계정으로 확인해야 하는 경우
// (workflow_dispatch로 프로덕션 로그인을 점검할 때)는 ALLOW_NON_QA_LOGIN=1로 넘긴다.
function assertSafeAccounts(accounts) {
  const problems = [];
  const allowNonQa = String(process.env.ALLOW_NON_QA_LOGIN || '') === '1';

  for (const a of accounts) {
    if (!a.password) {
      problems.push(`${a.label}: 비밀번호가 없습니다(LOGIN_PASSWORD_${a.label.toUpperCase()}).`
        + ' 빈 값으로 시도하면 로그인 실패가 쌓여 계정이 잠깁니다.');
    }
    if (!allowNonQa && !/^qa_/.test(a.loginId)) {
      problems.push(`${a.label}: '${a.loginId}'는 QA 전용 계정이 아닙니다.`
        + ' 로그인은 단일 세션이라 이 계정을 쓰던 사람이 로그아웃됩니다.'
        + ` QA 계정을 LOGIN_ID_${a.label.toUpperCase()}로 지정하거나,`
        + ' 일부러 실계정을 점검하려면 ALLOW_NON_QA_LOGIN=1을 주세요.');
    }
  }

  if (!problems.length) return;
  console.error('로그인 게이트를 시작하지 않았습니다 — 계정 설정을 먼저 고쳐주세요.\n');
  problems.forEach((p) => console.error(`  · ${p}`));
  process.exit(1);
}

async function checkOne(baseUrl, account, options) {
  const maxRetries = options.maxRetries;
  const retryOn429 = options.retryOn429;
  const retryBaseMs = options.retryBaseMs;
  const retryMaxMs = options.retryMaxMs;
  let attempts = 0;

  while (attempts <= maxRetries) {
    attempts += 1;
  const startedAt = Date.now();
  const body = new URLSearchParams({
    login_id: account.loginId,
    password: account.password,
  });

  const response = await fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    redirect: 'manual',
  });

    const location = response.headers.get('location') || '';
    const pass = response.status === 302 && location === '/';
    const durationMs = Date.now() - startedAt;
    const rateLimit = parseRateLimitMeta(response.headers);

    const result = {
      label: account.label,
      loginId: account.loginId,
      status: response.status,
      location,
      durationMs,
      attempts,
      rateLimit,
      pass,
    };

    if (response.status === 429 && retryOn429 && attempts <= maxRetries) {
      const delayMs = computeRetryDelayMs(attempts, rateLimit, retryBaseMs, retryMaxMs);
      await wait(delayMs);
      continue;
    }

    return result;
  }

  // 논리상 도달하지 않지만, 타입/가독성을 위해 안전 반환.
  return {
    label: account.label,
    loginId: account.loginId,
    status: 0,
    location: '',
    durationMs: 0,
    attempts: 0,
    rateLimit: { policy: '', limit: '', remaining: '', reset: '', retryAfter: '' },
    pass: false,
  };
}

async function checkHealth(baseUrl, targetPath, expectedStatuses) {
  const startedAt = Date.now();
  const response = await fetch(`${baseUrl}${targetPath}`, {
    method: 'GET',
    redirect: 'manual',
  });
  const pass = expectedStatuses.includes(response.status);
  const durationMs = Date.now() - startedAt;
  return {
    path: targetPath,
    status: response.status,
    expectedStatuses,
    durationMs,
    pass,
  };
}

function writeReportIfNeeded(report, reportPath) {
  if (!reportPath) return;
  const absPath = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}

function buildSummaryMarkdown(report) {
  const lines = [];
  lines.push('# Preflight Summary');
  lines.push('');
  lines.push(`- Checked At: ${report.checkedAt}`);
  lines.push(`- Base URL: ${report.baseUrl}`);
  lines.push(`- Overall: ${report.pass ? 'PASS' : 'FAIL'}`);
  lines.push('');
  lines.push('## Health Checks');
  lines.push('');
  lines.push('| Path | Status | Expected | Duration(ms) | Result |');
  lines.push('| --- | ---: | --- | ---: | --- |');
  for (const item of report.healthChecks) {
    const expected = (item.expectedStatuses || []).join(',');
    lines.push(`| ${item.path} | ${item.status} | ${expected} | ${item.durationMs} | ${item.pass ? 'PASS' : 'FAIL'} |`);
  }
  lines.push('');
  lines.push('## Login Checks');
  lines.push('');
  lines.push('| Label | Login ID | Status | Location | Duration(ms) | Attempts | Result |');
  lines.push('| --- | --- | ---: | --- | ---: | ---: | --- |');
  for (const item of report.loginResults) {
    lines.push(`| ${item.label} | ${item.loginId} | ${item.status} | ${item.location || ''} | ${item.durationMs} | ${item.attempts} | ${item.pass ? 'PASS' : 'FAIL'} |`);
  }

  if (report.rateLimitEvents && report.rateLimitEvents.length) {
    lines.push('');
    lines.push('## Rate Limit Events');
    lines.push('');
    lines.push('| Label | Status | Remaining | Reset(s) | Retry-After(s) | Policy |');
    lines.push('| --- | ---: | ---: | ---: | ---: | --- |');
    for (const ev of report.rateLimitEvents) {
      lines.push(`| ${ev.label} | ${ev.status} | ${ev.remaining || ''} | ${ev.reset || ''} | ${ev.retryAfter || ''} | ${ev.policy || ''} |`);
    }
  }

  if (!report.pass) {
    lines.push('');
    lines.push('## Failed Items');
    lines.push('');
    const failedHealth = report.healthChecks.filter((x) => !x.pass);
    const failedLogin = report.loginResults.filter((x) => !x.pass);
    if (!failedHealth.length && !failedLogin.length) {
      lines.push('- No explicit failed rows were detected.');
    }
    for (const item of failedHealth) {
      lines.push(`- Health FAIL: ${item.path} (status=${item.status}, expected=${(item.expectedStatuses || []).join(',')})`);
    }
    for (const item of failedLogin) {
      lines.push(`- Login FAIL: ${item.label}/${item.loginId} (status=${item.status}, location=${item.location || '(empty)'})`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}\n`;
}

function writeSummaryIfNeeded(report, summaryPath) {
  if (!summaryPath) return;
  const absPath = path.resolve(summaryPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buildSummaryMarkdown(report), 'utf8');
}

async function main() {
  const baseUrl = (process.env.LOGIN_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '');
  const accounts = getAccountsFromEnv();
  assertSafeAccounts(accounts);
  const reportPath = process.env.PREFLIGHT_REPORT_PATH || '';
  const summaryPath = process.env.PREFLIGHT_SUMMARY_PATH || '';
  const retryOn429 = String(process.env.PREFLIGHT_RETRY_ON_429 || 'true') !== 'false';
  const maxRetries = toPositiveInt(process.env.PREFLIGHT_MAX_RETRIES, 2);
  const retryBaseMs = toPositiveInt(process.env.PREFLIGHT_RETRY_BASE_MS, 250);
  const retryMaxMs = toPositiveInt(process.env.PREFLIGHT_RETRY_MAX_MS, 3000);

  const results = [];
  for (const account of accounts) {
    // 계정별 쿠키를 섞지 않기 위해 로그인 요청을 독립적으로 수행한다.
    // redirect: 'manual' 이므로 302 + Location 헤더를 그대로 검증 가능하다.
    const result = await checkOne(baseUrl, account, {
      retryOn429,
      maxRetries,
      retryBaseMs,
      retryMaxMs,
    });
    results.push(result);
  }

  // 런타임(Express 단독 / Next+Proxy 공존)과 배포 환경에 따라
  // 비인증 리다이렉트가 302 또는 307로 달라질 수 있다.
  const REDIRECT_STATUSES = [302, 307];

  const healthChecks = await Promise.all([
    checkHealth(baseUrl, '/login', [200]),
    checkHealth(baseUrl, '/', REDIRECT_STATUSES),
    checkHealth(baseUrl, '/orders', REDIRECT_STATUSES),
  ]);

  const pass = results.every((r) => r.pass) && healthChecks.every((h) => h.pass);
  const rateLimitEvents = results
    .filter((r) => r.status === 429)
    .map((r) => ({
      label: r.label,
      loginId: r.loginId,
      status: r.status,
      policy: r.rateLimit.policy,
      limit: r.rateLimit.limit,
      remaining: r.rateLimit.remaining,
      reset: r.rateLimit.reset,
      retryAfter: r.rateLimit.retryAfter,
      attempts: r.attempts,
    }));

  const report = {
    baseUrl,
    checkedAt: new Date().toISOString(),
    pass,
    retryPolicy: {
      retryOn429,
      maxRetries,
      retryBaseMs,
      retryMaxMs,
    },
    healthChecks,
    loginResults: results,
    rateLimitEvents,
  };

  writeReportIfNeeded(report, reportPath);
  writeSummaryIfNeeded(report, summaryPath);
  console.log(JSON.stringify(report, null, 2));
  process.exit(pass ? 0 : 1);
}

main().catch((error) => {
  const cause = error && error.cause ? {
    message: error.cause.message,
    code: error.cause.code,
    name: error.cause.name,
  } : null;
  console.error('다중 로그인 스모크 체크 실패:', JSON.stringify({
    message: error.message,
    name: error.name,
    cause,
  }, null, 2));
  process.exit(1);
});
