// /api/_shared.js
//
// Shared helpers for /api/generate.js and /api/triage.js. Files prefixed
// with "_" are not routed as endpoints by Vercel.
//
// Each endpoint passes a `kind` ('gen' or 'tri') so rate-limit and cache
// keys are namespaced — neither endpoint can starve the other.

import { Redis } from '@upstash/redis';

// ============================================================
// IP + body extraction
// ============================================================
export function getCallerIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || req.headers['x-real-ip'] || 'unknown';
}

export function parseBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (_) { body = {}; }
  }
  return body || {};
}

// ============================================================
// Rate limiting — durable (Upstash) with an in-memory fallback.
// ============================================================
let _redis;
function getRedis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = (url && token) ? new Redis({ url, token }) : null;
  return _redis;
}

// In-memory fallback. Per-instance only. Keyed by `${kind}:${ip}`.
const memIpBuckets = new Map();
const memGlobalBuckets = new Map();

function memRateLimit(ip, kind, perMin, perHour) {
  const now = Date.now();
  const minStart = now - 60 * 1000;
  const hrStart = now - 60 * 60 * 1000;

  const globalKey = kind;
  const gBucket = (memGlobalBuckets.get(globalKey) || []).filter(t => t > hrStart);
  if (gBucket.length >= perHour) {
    memGlobalBuckets.set(globalKey, gBucket);
    return { allowed: false, scope: 'global', retryAfter: 3600 };
  }
  const ipKey = `${kind}:${ip}`;
  const bucket = (memIpBuckets.get(ipKey) || []).filter(t => t > minStart);
  if (bucket.length >= perMin) {
    return { allowed: false, scope: 'ip', retryAfter: 60 };
  }
  bucket.push(now);
  gBucket.push(now);
  memIpBuckets.set(ipKey, bucket);
  memGlobalBuckets.set(globalKey, gBucket);
  if (memIpBuckets.size > 2000) {
    for (const [k, v] of memIpBuckets) {
      if (v[v.length - 1] < minStart) memIpBuckets.delete(k);
    }
  }
  return { allowed: true };
}

export async function rateLimit(ip, kind = 'gen', { perMin = 5, perHour = 200 } = {}) {
  const redis = getRedis();
  if (!redis) return memRateLimit(ip, kind, perMin, perHour);
  try {
    const now = Date.now();
    const ipKey = `rl:${kind}:ip:${ip}:${Math.floor(now / 60000)}`;
    const globalKey = `rl:${kind}:global:${Math.floor(now / 3600000)}`;

    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, 120);
    if (ipCount > perMin) {
      return { allowed: false, scope: 'ip', retryAfter: 60 };
    }
    const globalCount = await redis.incr(globalKey);
    if (globalCount === 1) await redis.expire(globalKey, 7200);
    if (globalCount > perHour) {
      return { allowed: false, scope: 'global', retryAfter: 3600 };
    }
    return { allowed: true };
  } catch (err) {
    console.error(`Redis rate limiter failed (${kind}) — falling back to in-memory:`, err);
    return memRateLimit(ip, kind, perMin, perHour);
  }
}

// Friendly 429 messages for the two scope kinds.
export function rateLimitMessage(scope) {
  return scope === 'global'
    ? 'The exchange is at capacity. Please try again in an hour.'
    : 'The line is busy. Please wait a minute and try again.';
}

// ============================================================
// In-memory cache factory. Each endpoint gets its own cache; sized for
// hot bursts of identical briefs (example-button mashing, viral clicks).
// ============================================================
export function makeCache({ ttlMs = 10 * 60 * 1000, maxEntries = 200 } = {}) {
  const map = new Map();
  return {
    get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (Date.now() - entry.ts > ttlMs) { map.delete(key); return null; }
      return entry.data;
    },
    set(key, data) {
      map.set(key, { data, ts: Date.now() });
      if (map.size > maxEntries) {
        map.delete(map.keys().next().value);
      }
    }
  };
}

// ============================================================
// Fire-and-forget anonymized logging.
// ============================================================
export async function logEvent(event) {
  if (!process.env.MONGODB_URI) return;
  try {
    const { logEvent: _logEvent } = await import('./_db.js');
    await _logEvent(event);
  } catch (err) {
    console.error('Logger failed:', err);
  }
}
