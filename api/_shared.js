// /api/_shared.js
//
// Shared helpers for /api/generate.js and /api/triage.js. Files prefixed
// with "_" are not routed as endpoints by Vercel.
//
// Each endpoint passes a `kind` ('gen' or 'tri') so rate-limit and cache
// keys are namespaced — neither endpoint can starve the other.

import { Redis } from '@upstash/redis';
import crypto from 'crypto';

// ============================================================
// Share-slug generator. 10-char base62 = 62^10 ≈ 8.4×10^17 keyspace,
// collision-safe at internet scale, URL-friendly, 10 chars fits in a
// tweet without arm-wrestling.
// ============================================================
const SLUG_ALPHA = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export function makeShareSlug(len = 10) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += SLUG_ALPHA[bytes[i] % 62];
  return out;
}

// Author token — 32 hex chars (128 bits of entropy). Issued on fresh
// generations so the original author can later prove authorship via the
// cookie (Phase 5 verify-author endpoint). Unguessable; never reused.
export function makeAuthorToken() {
  return crypto.randomBytes(16).toString('hex');
}
// Server-side hash for storage. Unsalted SHA-256 — the input is already
// 128 random bits, salt adds no protection vs precomputation.
export function hashAuthorToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

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

// In-memory fallback. Per-instance only. Per-IP buckets are keyed by
// `${kind}:${window}:${ip}` so the same IP can be tracked across the
// minute/hour/day windows independently.
const memIpBuckets = new Map();
const memGlobalBuckets = new Map();

function memRateLimit(ip, kind, opts) {
  const now = Date.now();
  const minStart = now - 60 * 1000;
  const hrStart  = now - 60 * 60 * 1000;
  const dayStart = now - 24 * 60 * 60 * 1000;

  // Global hourly cap.
  const gBucket = (memGlobalBuckets.get(kind) || []).filter(t => t > hrStart);
  if (gBucket.length >= opts.perHour) {
    memGlobalBuckets.set(kind, gBucket);
    return { allowed: false, scope: 'global', retryAfter: 3600 };
  }

  // Per-IP windows. Each is its own keyed array because the windows differ.
  const ipMinKey  = `${kind}:min:${ip}`;
  const ipHrKey   = `${kind}:hr:${ip}`;
  const ipDayKey  = `${kind}:day:${ip}`;
  const minBucket = (memIpBuckets.get(ipMinKey) || []).filter(t => t > minStart);
  const hrBucket  = (memIpBuckets.get(ipHrKey)  || []).filter(t => t > hrStart);
  const dayBucket = (memIpBuckets.get(ipDayKey) || []).filter(t => t > dayStart);

  if (minBucket.length >= opts.perMin) {
    return { allowed: false, scope: 'ip', retryAfter: 60 };
  }
  if (hrBucket.length >= opts.ipPerHour) {
    return { allowed: false, scope: 'ip-hour', retryAfter: 3600 };
  }
  if (dayBucket.length >= opts.ipPerDay) {
    return { allowed: false, scope: 'ip-day', retryAfter: 24 * 3600 };
  }

  minBucket.push(now); hrBucket.push(now); dayBucket.push(now); gBucket.push(now);
  memIpBuckets.set(ipMinKey, minBucket);
  memIpBuckets.set(ipHrKey, hrBucket);
  memIpBuckets.set(ipDayKey, dayBucket);
  memGlobalBuckets.set(kind, gBucket);

  // Cheap LRU sweep on the per-IP map so a long-running instance doesn't
  // accumulate keys for dead IPs forever.
  if (memIpBuckets.size > 4000) {
    for (const [k, v] of memIpBuckets) {
      if (v[v.length - 1] < dayStart) memIpBuckets.delete(k);
    }
  }
  return { allowed: true };
}

export async function rateLimit(ip, kind = 'gen', {
  perMin     = 5,    // per-IP, per-minute (burst limit)
  perHour    = 200,  // global, per-hour (hard ceiling across all callers)
  ipPerHour  = 20,   // per-IP, per-hour (sustained pacing cap)
  ipPerDay   = 40    // per-IP, per-day (total-volume cap, defeats IP-rotation pacing)
} = {}) {
  const opts = { perMin, perHour, ipPerHour, ipPerDay };
  const redis = getRedis();
  if (!redis) return memRateLimit(ip, kind, opts);
  try {
    const now = Date.now();
    const ipMinKey  = `rl:${kind}:ip:min:${ip}:${Math.floor(now / 60000)}`;
    const ipHrKey   = `rl:${kind}:ip:hr:${ip}:${Math.floor(now / 3600000)}`;
    const ipDayKey  = `rl:${kind}:ip:day:${ip}:${Math.floor(now / 86400000)}`;
    const globalKey = `rl:${kind}:global:${Math.floor(now / 3600000)}`;

    const ipMin = await redis.incr(ipMinKey);
    if (ipMin === 1) await redis.expire(ipMinKey, 120);
    if (ipMin > perMin) return { allowed: false, scope: 'ip', retryAfter: 60 };

    const ipHr = await redis.incr(ipHrKey);
    if (ipHr === 1) await redis.expire(ipHrKey, 7200);
    if (ipHr > ipPerHour) return { allowed: false, scope: 'ip-hour', retryAfter: 3600 };

    const ipDay = await redis.incr(ipDayKey);
    if (ipDay === 1) await redis.expire(ipDayKey, 86400 * 2);
    if (ipDay > ipPerDay) return { allowed: false, scope: 'ip-day', retryAfter: 24 * 3600 };

    const globalCount = await redis.incr(globalKey);
    if (globalCount === 1) await redis.expire(globalKey, 7200);
    if (globalCount > perHour) return { allowed: false, scope: 'global', retryAfter: 3600 };

    return { allowed: true };
  } catch (err) {
    console.error(`Redis rate limiter failed (${kind}) — falling back to in-memory:`, err);
    return memRateLimit(ip, kind, opts);
  }
}

// Friendly 429 messages by scope. The copy stays in character — every line
// could plausibly come from a 1997 ISP help desk.
export function rateLimitMessage(scope) {
  switch (scope) {
    case 'global':  return 'The exchange is at capacity. Please try again in an hour.';
    case 'ip-hour': return 'You have made many requests this hour. Please rest the line for a bit and try again later.';
    case 'ip-day':  return 'You have reached your daily allotment of compose requests. Please try again tomorrow.';
    case 'ip':
    default:        return 'The line is busy. Please wait a minute and try again.';
  }
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
// Mongo write helpers with retry-once + throw semantics.
//
// All three (logEvent, insertPagePlaceholder, completePageRow) share the
// same retry harness: one immediate attempt → 250ms backoff → one more
// attempt → throw on final failure with full stack already in Vercel
// logs. Callers MUST wrap awaits in try/catch so a Mongo blip can't
// take down a streaming response.
//
// Two-stage write architecture (insertPagePlaceholder + completePageRow)
// fixes the recurring /p/:slug 404: the share-slug response header is
// only emitted when the placeholder write succeeds, so a dead Mongo
// never produces a dead share link the client thinks is live.
// ============================================================

async function withRetry(label, ctx, fn) {
  if (!process.env.MONGODB_URI) return;
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await fn();
      if (attempt > 1) {
        console.log(label, 'recovered on retry attempt', attempt,
          ctx ? ('— ' + ctx) : '');
      }
      return;
    } catch (err) {
      lastErr = err;
      console.error(label, 'attempt', attempt, 'failed',
        ctx ? ('— ' + ctx) : '',
        '— err:', err && (err.stack || err.message || err));
      if (attempt === 1) await new Promise(r => setTimeout(r, 250));
    }
  }
  const e = new Error(label + ' failed after retries: ' +
    (lastErr && (lastErr.message || lastErr)));
  e.code = 'MONGO_WRITE_FAILED';
  e.cause = lastErr;
  throw e;
}

export async function logEvent(event) {
  return withRetry('logEvent',
    'event=' + (event && event.event) + ' slug=' + (event && event.share_slug),
    async () => {
      const { logEvent: _logEvent } = await import('./_db.js');
      await _logEvent(event);
    });
}

export async function insertPagePlaceholder(payload) {
  return withRetry('insertPagePlaceholder',
    'slug=' + (payload && payload.share_slug),
    async () => {
      const { insertPagePlaceholder: _insert } = await import('./_db.js');
      await _insert(payload);
    });
}

export async function completePageRow(payload) {
  return withRetry('completePageRow',
    'slug=' + (payload && payload.share_slug) + ' event=' + (payload && payload.event),
    async () => {
      const { completePageRow: _update } = await import('./_db.js');
      await _update(payload);
    });
}
