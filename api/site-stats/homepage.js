// /api/site-stats/homepage.js
//
// GET endpoint that returns the homepage's live visitor count for the
// starter doc's "This page has been visited N times" line. Side effect:
// increments the counter once per page load (true 1997 per-load counter).
//
// The increment is deliberately NOT gated behind per-IP/day dedupe: that
// gate (recordHomepageVisit) made the visible number freeze for any repeat
// or return visitor, since their second+ load of the day took the read-only
// path. Abuse is bounded by the rateLimit() below, not by dedupe. The write
// is a plain siteStats $inc — it shares no helper, hash, or index with the
// publish-time content-hash dedup (that path only ever writes `generations`).
//
// Response: { count: <int> }
// Cache-Control: no-store. Caching this would freeze the counter; the
// endpoint is cheap (a single atomic $inc per request).
//
// First-time bootstrap: the underlying siteStats row is seeded at 420
// in _db.js#incrementHomepageVisits when no doc exists yet, so a fresh
// install reads 420 on its first call (the seed IS the visit's count,
// not a +1 on top). See that helper for race-safety notes.

import { getCallerIp, rateLimit, rateLimitMessage } from '../_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // When Mongo isn't configured, return the seed value so the
  // counter still shows something plausible in dev / preview envs.
  if (!process.env.MONGODB_URI) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: 420 });
  }

  const ip = getCallerIp(req);
  // Loose bucket — a normal browser session might re-fetch this on
  // back/forward navigation; only flag if traffic is clearly abusive.
  const rl = await rateLimit(ip, 'sitestats', {
    perMin: 120, perHour: 2000, ipPerHour: 600, ipPerDay: 3000
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  try {
    const { incrementHomepageVisits } = await import('../_db.js');

    // Per-load increment, no dedupe gate. The $inc is atomic, so concurrent
    // loads never lose a count, and it runs against whatever the row already
    // holds — the value only ever moves up from its current floor, never
    // resets or re-seeds an existing row.
    const count = await incrementHomepageVisits();

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: Number(count) || 0 });
  } catch (err) {
    console.error('site-stats/homepage failed:', err && (err.stack || err.message || err));
    res.setHeader('Cache-Control', 'no-store');
    // Soft-degrade: return the seed so the visible counter stays
    // sane even if the DB is having a moment.
    return res.status(200).json({ count: 420 });
  }
}
