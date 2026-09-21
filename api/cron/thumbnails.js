// /api/cron/thumbnails.js
//
// Every five minutes: render any page that is still missing its thumbnail.
//
// This exists because the backstop we thought we had was never running.
// .github/workflows/thumbnails.yml carries a cron, and across 18 runs of that
// workflow GitHub has fired the schedule exactly once -- every other run was a
// manual or API dispatch. GitHub delays and silently drops scheduled workflows
// under load, which is documented behaviour and fine for a nightly job and
// useless as a safety net. On 21 September, when publish-time dispatch stopped
// working, "the schedule will catch it" turned out to mean nothing at all.
//
// Vercel Cron is a different mechanism with a different reliability story, and
// it is already trusted here for site-of-the-week. So the net moves to it.
//
// Order of preference, and both are attempted:
//   1. Render in this function, with our own browser (_render_thumb.js).
//   2. Failing that, ask the GitHub workflow to do it, which still works
//      whenever GITHUB_DISPATCH_TOKEN is valid.
//
// Nothing here is on any visitor's path. The worst outcome is that a card keeps
// the placeholder it already had for another five minutes.

import { Buffer } from 'node:buffer';

// Bounded per run, deliberately. Each render can take up to 25 seconds, and a
// backfill that tried to clear a large queue in one invocation would hit the
// function's ceiling and lose the work it had already done. Three per run at
// five-minute intervals drains 36 an hour, which is far faster than anyone
// publishes, and an idle run costs one indexed query.
const PER_RUN = 3;

export default async function handler(req, res) {
  // Same gate as the site-of-the-week cron: Vercel sends
  // `Authorization: Bearer ${CRON_SECRET}`. With no secret provisioned nobody
  // can satisfy this and the route stays closed, which is the right way round.
  const provided = String(req.headers.authorization || '');
  const expected = 'Bearer ' + String(process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || !timingSafeEqual(provided, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'Database not configured.' });
  }

  try {
    const { listSlugsMissingThumbnails } = await import('../_db.js');
    const pending = await listSlugsMissingThumbnails(PER_RUN);

    if (!pending.length) {
      return res.status(200).json({ ok: true, pending: 0, rendered: 0, dispatched: false });
    }

    const { renderThumbnail } = await import('../_render_thumb.js');
    const rendered = [];
    const failed = [];

    for (const row of pending) {
      const slug = row.share_slug;
      if (!slug) continue;
      // renderThumbnail never throws; it returns a boolean and records the
      // reason on the page's own row when it returns false.
      const ok = await renderThumbnail(slug);
      (ok ? rendered : failed).push(slug);
    }

    // One dispatch covers every slug still outstanding -- the workflow renders
    // the whole queue, so asking once is asking enough.
    let dispatched = false;
    if (failed.length) {
      const { requestThumbnail } = await import('../_thumbjob.js');
      dispatched = await requestThumbnail(failed[0]);
    }

    console.log('[thumb cron] pending=' + pending.length +
      ' rendered=' + rendered.length + ' failed=' + failed.length +
      ' dispatched=' + dispatched);

    return res.status(200).json({
      ok: true,
      pending: pending.length,
      rendered: rendered.length,
      failed: failed.length,
      dispatched
    });
  } catch (err) {
    console.error('[thumb cron] failed:', err && (err.stack || err.message || err));
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
