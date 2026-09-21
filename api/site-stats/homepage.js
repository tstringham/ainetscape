// /api/site-stats/homepage.js
//
// GET endpoint that returns the homepage's live visitor count for the
// starter doc's "This page has been visited N times" line. Side effect:
// increments the counter once per page load (true 1997 per-load counter).
//
// ============================================================
// THE COUNTER NEVER STOPS AND NEVER REFUSES. Read this before touching
// anything below.
// ============================================================
// A visit counter that can freeze is not a visit counter. This endpoint
// therefore has NO failure mode in which a caller is denied the number.
// Three separate things used to be able to freeze it; all three are shut:
//
//  1. THE GLOBAL HOURLY CEILING. rateLimit()'s `perHour` is a site-wide
//     cap across ALL callers — built for /api/generate, where each call
//     spends real money with an AI provider and a hard ceiling is the
//     entire point. It was copy-pasted onto this endpoint at 2000/hour in
//     93f0a25. Here it protects nothing (one atomic $inc per call) and
//     costs everything: past 2000 homepage loads in one clock hour, every
//     further visitor got a 429 and saw the static placeholder instead of
//     the count — site-wide, until the hour rolled. Now: skipGlobal, so
//     the ceiling cannot fire at all, plus perHour set to one trillion as
//     a backstop in case anyone ever removes skipGlobal. Do not "tidy"
//     either of them back down.
//
//  2. THE PER-IP CAPS. These are worth keeping — they stop one caller
//     inflating the number — but a 429 in their name froze the display
//     just as hard. Now a caller over their allowance is NOT refused;
//     they simply stop incrementing and still get the current count.
//     Deny the write, never the read.
//
//  3. INT32 OVERFLOW. Not an issue: MongoDB promotes int32 -> int64 on
//     $inc overflow rather than erroring (verified against the live
//     cluster: 2147483647 + 1 = 2147483648, and the field reaches
//     1e12 fine). The count is stored as `int` today and will widen
//     itself when it needs to. Nothing to migrate.
//
// The increment is also NOT gated behind per-IP/day dedupe: that gate
// (recordHomepageVisit) made the visible number freeze for any repeat or
// return visitor, since their second+ load of the day took the read-only
// path. See e6b7fc5. The write is a plain siteStats $inc — it shares no
// helper, hash, or index with the publish-time content-hash dedup (that
// path only ever writes `generations`).
//
// Response: { count: <int> }  — always, whenever a number can be had.
//           { count: null, degraded: '<reason>' }  only when the database
//           genuinely cannot be read. NEVER a stand-in integer: this used
//           to soft-degrade to 420, a leftover from the original
//           HOMEPAGE_SEED. After dfe26ca moved the seed to 1042 that was
//           wrong twice over, and being BELOW the live count it rendered
//           as a counter that had visibly rolled backwards. The client
//           treats null as "leave the markup alone".
//
// Cache-Control: no-store. Caching this would freeze the counter.

import { getCallerIp, rateLimit, makeCache } from '../_shared.js';

// Serves callers who are over their per-IP increment allowance. Bounds the
// cost of a hammering client to one findOne per TTL instead of one per
// request, so honouring "always answer with a number" can't become a way
// to hammer Mongo.
const readCache = makeCache({ ttlMs: 10 * 1000, maxEntries: 4 });
const READ_KEY = 'homepage';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  res.setHeader('Cache-Control', 'no-store');

  // When Mongo isn't configured (dev / preview), say so rather than
  // inventing a count. The client keeps whatever the markup shipped with.
  if (!process.env.MONGODB_URI) {
    return res.status(200).json({ count: null, degraded: 'no-db' });
  }

  const ip = getCallerIp(req);

  // `allowed` here decides whether this caller's visit COUNTS — never
  // whether they get an answer. See note 1 and 2 above.
  const rl = await rateLimit(ip, 'sitestats', {
    perMin: 120, ipPerHour: 600, ipPerDay: 3000,
    perHour: 1_000_000_000_000,
    skipGlobal: true
  });

  try {
    const { incrementHomepageVisits, getHomepageVisitCount } = await import('../_db.js');

    let count;
    if (rl.allowed) {
      // Per-load increment. The $inc is atomic, so concurrent loads never
      // lose a count, and it runs against whatever the row already holds —
      // the value only ever moves up from its current floor, never resets
      // or re-seeds an existing row.
      count = await incrementHomepageVisits();
      readCache.set(READ_KEY, count);
    } else {
      // Over their allowance: read-only. Pure read, no write, no 429.
      const cached = readCache.get(READ_KEY);
      count = (typeof cached === 'number') ? cached : await getHomepageVisitCount();
      if (typeof count === 'number' && count > 0) readCache.set(READ_KEY, count);
    }

    // The row is seeded at 1042 and only ever climbs, so a non-positive
    // count means the read failed rather than the site having no visits.
    if (typeof count !== 'number' || !Number.isFinite(count) || count <= 0) {
      return res.status(200).json({ count: null, degraded: 'no-row' });
    }

    return res.status(200).json({ count });
  } catch (err) {
    console.error('site-stats/homepage failed:', err && (err.stack || err.message || err));
    return res.status(200).json({ count: null, degraded: 'db-error' });
  }
}
