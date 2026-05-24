// /api/page/[slug]/stats.js
//
// GET endpoint that returns the live counts and SOTW flag for a single
// page. /p/[slug] body is edge-cached for 24h immutable so server-side
// counts would be stale; this endpoint is fetched on every page load
// by artifact-cluster.js to hydrate the right-cluster skeleton.
//
// Side effect: increments the page's hit counter, deduped per IP per
// slug per 24h (Redis SETNX with in-memory fallback) so a reload loop
// can't inflate the number.
//
// Response shape:
//   { upvotes: number, hits: number, site_of_the_week: boolean }
//
// Cache-Control: no-store. The endpoint is cheap (one indexed Mongo
// lookup + one $inc when deduped) and the whole point is freshness;
// caching would defeat the architecture.

import { getCallerIp, rateLimit, rateLimitMessage, recordHit } from '../../_shared.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const slug = String(req.query.slug || '');
  if (!VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }

  // When Mongo isn't configured, return zeroed stats rather than 503 —
  // the artifact cluster should still render (just with zero counts).
  if (!process.env.MONGODB_URI) {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ upvotes: 0, hits: 0, site_of_the_week: false });
  }

  const ip = getCallerIp(req);
  // Loose bucket — viewing a page shouldn't easily hit a rate limit,
  // but bots scraping stats shouldn't get a free pass either.
  const rl = await rateLimit(ip, 'stats', {
    perMin: 120, perHour: 2000, ipPerHour: 600, ipPerDay: 3000
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  try {
    const { getPageStats, incrementHit } = await import('../../_db.js');

    // Dedup: one hit per IP per slug per 24h. Increment first when fresh
    // so the returned `hits` already reflects this view (avoids a
    // two-call read/write race where the new visitor sees N-1).
    let freshHit = false;
    try { freshHit = await recordHit(ip, slug); } catch (_) {}
    if (freshHit) {
      try { await incrementHit(slug); } catch (err) {
        // Mongo blip on the increment shouldn't fail the read.
        console.error('Hit increment failed for slug=' + slug + ':', err && (err.message || err));
      }
    }

    const stats = await getPageStats(slug);
    if (!stats) {
      res.setHeader('Cache-Control', 'no-store');
      return res.status(404).json({ error: 'Not found.' });
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      upvotes: stats.upvotes || 0,
      hits: stats.hits || 0,
      site_of_the_week: !!stats.site_of_the_week
    });
  } catch (err) {
    console.error('Stats failed for slug=' + slug + ':', err && (err.stack || err.message || err));
    res.setHeader('Cache-Control', 'no-store');
    return res.status(500).json({ error: 'Internal error.' });
  }
}
