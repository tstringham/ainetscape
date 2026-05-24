// /api/vote.js
//
// POST /api/vote { slug } → { ok, upvotes, already_voted }
//
// One vote per IP per slug, deduped via Redis SETNX (30-day TTL). Rate-
// limited on its own bucket so a flood of vote clicks can't starve the
// generation budget. Only votes on public AI pages succeed — a slug that
// doesn't match a votable row returns 404.

import { getCallerIp, parseBody, rateLimit, rateLimitMessage, recordVote } from './_shared.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }
  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'Voting is temporarily unavailable.' });
  }

  const body = parseBody(req);
  const slug = String(body.slug || '');
  if (!VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }

  const ip = getCallerIp(req);

  // Separate bucket from gen/page so vote bursts can't drain the
  // generation budget. Per-IP burst loose enough to allow a quick scroll
  // through the gallery + tap a few cards without hitting the limit.
  const rl = await rateLimit(ip, 'vote', {
    perMin: 20, perHour: 300, ipPerHour: 120, ipPerDay: 400
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  try {
    const fresh = await recordVote(ip, slug);
    const { incrementUpvote, getUpvoteCount } = await import('./_db.js');

    if (!fresh) {
      // Already voted — return current count, no $inc.
      const current = await getUpvoteCount(slug);
      return res.status(200).json({ ok: true, upvotes: current, already_voted: true });
    }

    const next = await incrementUpvote(slug);
    if (next === null) {
      // Slug exists in dedupe but not as a votable row — surface 404 so
      // the client can show a polite error rather than a misleading count.
      return res.status(404).json({ error: 'That page is not in the gallery.' });
    }
    return res.status(200).json({ ok: true, upvotes: next, already_voted: false });
  } catch (err) {
    console.error('Vote failed:', err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'The vote could not be recorded.' });
  }
}
