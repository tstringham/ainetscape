// /api/site-stats/homepage.js
//
// GET endpoint that returns the homepage's live visitor count for the
// starter doc's "This page has been visited N times" line. Side effect:
// increments the counter once per IP per UTC day (Redis SETNX dedupe).
//
// Response: { count: <int> }
// Cache-Control: no-store. Caching this would freeze the counter; the
// endpoint is cheap (one indexed Mongo lookup + one $inc when deduped).
//
// First-time bootstrap: the underlying siteStats row is seeded at 1042
// in _db.js#incrementHomepageVisits when no doc exists yet, so a fresh
// install reads 1042 on its first call (the seed IS the visit's count,
// not a +1 on top). See that helper for race-safety notes.

import { getCallerIp, rateLimit, rateLimitMessage, recordHomepageVisit } from '../_shared.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // When Mongo isn't configured, return the seed value so the
  // counter still shows something plausible in dev / preview envs.
  if (!process.env.MONGODB_URI) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: 1042 });
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
    const { getHomepageVisitCount, incrementHomepageVisits } = await import('../_db.js');

    let fresh = false;
    try { fresh = await recordHomepageVisit(ip); } catch (_) {}

    let count;
    if (fresh) {
      count = await incrementHomepageVisits();
    } else {
      count = await getHomepageVisitCount();
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ count: Number(count) || 0 });
  } catch (err) {
    console.error('site-stats/homepage failed:', err && (err.stack || err.message || err));
    res.setHeader('Cache-Control', 'no-store');
    // Soft-degrade: return the seed so the visible counter stays
    // sane even if the DB is having a moment.
    return res.status(200).json({ count: 1042 });
  }
}
