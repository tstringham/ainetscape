// /api/page/[slug]/stats.js
//
// GET endpoint that returns the live counts and SOTW flag for a single
// page. /p/[slug] body is edge-cached for 24h immutable so server-side
// counts would be stale; this endpoint is fetched on every page load
// by artifact-cluster.js to hydrate the right-cluster skeleton.
//
// Side effect: increments the page's hit counter ONCE PER PAGE LOAD.
//
// ============================================================
// IT COUNTS EVERY LOAD, AND IT NEVER REFUSES. Read before editing.
// ============================================================
// This is a 1997 hit counter and it behaves like one. Two things used to
// stop it doing that; both are shut, and neither should come back:
//
//  1. PER-IP-PER-DAY DEDUPE. recordHit() gated the $inc behind one hit per
//     IP per slug per 24h, to stop a reload loop inflating the number. The
//     cost was the entire effect: a page you loaded fifty times read "Hits:
//     2". An odometer that ignores you is not an odometer. The same gate was
//     removed from the homepage counter in e6b7fc5 for the same reason; this
//     is that change applied to the per-page counter. recordHit() is left in
//     _shared.js unused — do not re-wire it here.
//
//  2. THE GLOBAL HOURLY CEILING. rateLimit()'s `perHour` caps ALL callers
//     site-wide. It was built for /api/generate, where each call spends real
//     money with an AI provider, then copy-pasted here at 2000/hour. On this
//     endpoint it protects nothing and breaks the cluster outright: the
//     client does `r.ok ? r.json() : null`, so a 429 leaves every visitor
//     looking at an unhydrated skeleton with no counts at all. Now:
//     skipGlobal, plus perHour at one trillion as a backstop.
//
// The per-IP caps below are kept, but they gate the WRITE only. A caller
// over their allowance is never refused — they stop incrementing and still
// get the counts. Deny the write, never the read.
//
// Response shape:
//   { upvotes: number, hits: number, site_of_the_week: boolean }
//
// Cache-Control: no-store. The endpoint is cheap (one findOneAndUpdate that
// returns all three fields together) and the whole point is freshness;
// caching would defeat the architecture.

import { getCallerIp, rateLimit } from '../../_shared.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const slug = String(req.query.slug || '');
  if (!VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }

  res.setHeader('Cache-Control', 'no-store');

  // When Mongo isn't configured, return zeroed stats rather than 503 —
  // the artifact cluster should still render (just with zero counts).
  if (!process.env.MONGODB_URI) {
    return res.status(200).json({ upvotes: 0, hits: 0, site_of_the_week: false });
  }

  const ip = getCallerIp(req);
  // `allowed` decides whether this load COUNTS — never whether the caller
  // gets an answer. See note 2 above.
  const rl = await rateLimit(ip, 'stats', {
    perMin: 120, ipPerHour: 600, ipPerDay: 3000,
    perHour: 1_000_000_000_000,
    skipGlobal: true
  });

  try {
    const { getPageStats, incrementHit } = await import('../../_db.js');

    // Increment first, and read the result of that same write, so the
    // number returned already includes this view. A separate read after
    // the write would race and show the new visitor N-1.
    let stats = null;
    if (rl.allowed) {
      try {
        stats = await incrementHit(slug);
      } catch (err) {
        // A Mongo blip on the increment must not cost the caller their
        // counts — fall through to the read below.
        console.error('Hit increment failed for slug=' + slug + ':', err && (err.message || err));
      }
    }

    // Reached when: the caller is over their write allowance, the page is
    // hidden or not AI-authored (incrementHit's filter matched nothing), or
    // the increment errored. Pure read, no write, no 429.
    if (!stats) stats = await getPageStats(slug);

    if (!stats) {
      return res.status(404).json({ error: 'Not found.' });
    }

    return res.status(200).json({
      upvotes: stats.upvotes || 0,
      hits: stats.hits || 0,
      site_of_the_week: !!stats.site_of_the_week
    });
  } catch (err) {
    console.error('Stats failed for slug=' + slug + ':', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'Internal error.' });
  }
}
