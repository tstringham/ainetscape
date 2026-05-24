// /api/cron/site-of-the-week.js
//
// Weekly cron: every Monday 00:00 UTC, pick the page with the highest
// 7-day upvote count (public, source=ai, not flagged) and stamp
// site_of_the_week on it. The gallery feature box and the /p/[slug]
// badge both read off that field — see _db.js#findCurrentSiteOfTheWeek.
//
// Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` when
// the env var is set. Anything else 401s, so manually triggering this
// endpoint requires knowing the secret. Comparison is constant-time
// to keep timing side-channels closed.
//
// Order of operations follows the spec literally: clear first, then
// select, then mark. If selection returns null (no votes this week,
// fresh install, all flagged), we end with nothing marked — and the
// gallery / page badge both hide themselves, which is correct.

import { Buffer } from 'node:buffer';

export default async function handler(req, res) {
  // Constant-time compare against the env-configured bearer token.
  // When CRON_SECRET isn't set, no caller can satisfy this — the route
  // is effectively closed until the env var is provisioned.
  const provided = String(req.headers.authorization || '');
  const expected = 'Bearer ' + String(process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'Database not configured.' });
  }

  try {
    const {
      clearAllSiteOfTheWeek,
      findSiteOfTheWeekCandidate,
      markSiteOfTheWeek
    } = await import('../_db.js');

    const cleared = await clearAllSiteOfTheWeek();
    const candidate = await findSiteOfTheWeekCandidate();

    if (!candidate || !candidate.share_slug) {
      console.log('[sotw cron] no winner this week — cleared', cleared, 'prior row(s)');
      return res.status(200).json({ ok: true, cleared, picked: null });
    }

    const marked = await markSiteOfTheWeek(candidate.share_slug);
    console.log(
      '[sotw cron] picked', candidate.share_slug,
      'upvotes=' + (candidate.upvotes || 0),
      'cleared=' + cleared,
      'marked=' + marked
    );
    return res.status(200).json({
      ok: true,
      cleared,
      picked: {
        slug: candidate.share_slug,
        title: candidate.page_title || null,
        upvotes: candidate.upvotes || 0,
        marked
      }
    });
  } catch (err) {
    console.error('[sotw cron] failed:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'Cron failed.' });
  }
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
