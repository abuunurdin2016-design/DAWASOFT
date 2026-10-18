/**
 * Netlify Function — the API gateway / reverse proxy in front of Google Apps Script.
 *
 * Why this exists: Apps Script Web Apps do not send CORS headers, so the browser cannot call
 * them directly. This function also gives us one place for the cross-cutting concerns from the
 * engineering checklist: rate limiting, timeouts, retries with exponential backoff + jitter,
 * a simple circuit breaker, CORS, and API-version enforcement.
 *
 * Env vars (set in Netlify UI):
 *   APPS_SCRIPT_URL       (required) the deployed Apps Script Web App /exec URL
 *   ALLOWED_ORIGIN        (optional) default "*"
 *   RATE_LIMIT_PER_MIN    (optional) default 120 requests / minute / client
 *   UPSTREAM_TIMEOUT_MS   (optional) default 25000
 */

const APPS_URL = process.env.APPS_SCRIPT_URL || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const API_VERSION = 'v1';
const SUPPORTED_VERSION = '1.0.0';
const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || '120', 10);
const UPSTREAM_TIMEOUT_MS = parseInt(process.env.UPSTREAM_TIMEOUT_MS || '25000', 10);
const MAX_ATTEMPTS = 3;

/* -------- in-memory state (best-effort; serverless instances are ephemeral) -------- */
const rateBuckets = new Map();      // key -> { count, resetAt }
const breaker = { failures: 0, openUntil: 0 };
const BREAKER_THRESHOLD = 5;
const BREAKER_COOLDOWN_MS = 30000;

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN === '*' ? (origin || '*') : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function envelope(action, ok, data, error, requestId) {
  return {
    ok, action: action || '', requestId: requestId || '',
    data: data === undefined ? null : data,
    error: error || null,
    serverTime: new Date().toISOString(),
    version: SUPPORTED_VERSION
  };
}

function reply(statusCode, body, origin) {
  return { statusCode, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) }, body: JSON.stringify(body) };
}

function clientKey(event, body) {
  const ip = (event.headers['x-nf-client-connection-ip'] || event.headers['client-ip'] ||
    (event.headers['x-forwarded-for'] || '').split(',')[0] || 'unknown').trim();
  const who = (body && body.token) ? String(body.token).slice(-12) : ip;
  return who;
}

function rateLimited(key) {
  const now = Date.now();
  const b = rateBuckets.get(key);
  if (!b || now > b.resetAt) { rateBuckets.set(key, { count: 1, resetAt: now + 60000 }); return false; }
  b.count += 1;
  return b.count > RATE_LIMIT_PER_MIN;
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** POST to Apps Script with timeout + retries (exponential backoff + jitter). */
async function callUpstream(payload) {
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const res = await fetch(APPS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error('Upstream HTTP ' + res.status);
      const text = await res.text();
      return JSON.parse(text);
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < MAX_ATTEMPTS) {
        const backoff = Math.min(4000, 300 * Math.pow(2, attempt - 1));
        const jitter = Math.floor(Math.random() * 250);
        await sleep(backoff + jitter);
      }
    }
  }
  throw lastErr || new Error('Upstream call failed');
}

exports.handler = async (event) => {
  const origin = event.headers.origin || '';

  // CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders(origin), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return reply(405, envelope('', false, null, { code: 'BAD_REQUEST', message: 'Use POST.' }), origin);
  }
  if (!APPS_URL) {
    return reply(500, envelope('', false, null, {
      code: 'SERVER_ERROR',
      message: 'APPS_SCRIPT_URL is not configured. Set it in Netlify environment variables.'
    }), origin);
  }

  // API version from path, e.g. /api/v1 or /.netlify/functions/api
  const path = event.path || '';
  const versionMatch = /\/api\/(v\d+)/.exec(path);
  if (versionMatch && versionMatch[1] !== API_VERSION) {
    return reply(400, envelope('', false, null, { code: 'BAD_REQUEST', message: 'Unsupported API version: ' + versionMatch[1] }), origin);
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch (err) {
    return reply(400, envelope('', false, null, { code: 'BAD_REQUEST', message: 'Invalid JSON body.' }), origin);
  }

  const action = body.action || '';
  const requestId = body.requestId || '';

  // Circuit breaker (fast-fail when the origin is unhealthy)
  if (Date.now() < breaker.openUntil) {
    return reply(503, envelope(action, false, null, { code: 'UPSTREAM_TIMEOUT', message: 'Service temporarily unavailable. Please retry.' }, requestId), origin);
  }

  // Rate limiting
  if (rateLimited(clientKey(event, body))) {
    return reply(429, envelope(action, false, null, { code: 'RATE_LIMITED', message: 'Too many requests. Slow down.' }, requestId), origin);
  }

  try {
    const upstream = await callUpstream(body);
    breaker.failures = 0;
    return reply(200, upstream, origin);
  } catch (err) {
    breaker.failures += 1;
    if (breaker.failures >= BREAKER_THRESHOLD) breaker.openUntil = Date.now() + BREAKER_COOLDOWN_MS;
    const isTimeout = err && (err.name === 'AbortError' || err.message === 'The operation was aborted');
    return reply(502, envelope(action, false, null, {
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'SERVER_ERROR',
      message: isTimeout ? 'Upstream timed out. Your operation was queued and will retry.' : ('Upstream error: ' + (err && err.message))
    }, requestId), origin);
  }
};
