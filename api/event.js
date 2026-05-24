// /api/event.js
//
// Tiny beacon endpoint. The client posts here when it cancels a
// generation or hits the 5-minute hard timeout, so analytics can split
// `ai_cancelled` from `ai_timeout` — distinctions the server can't reliably
// make on its own when the client just disconnects.

import { getCallerIp, parseBody, rateLimit, logEvent } from './_shared.js';

const ALLOWED = new Set(['ai_cancelled', 'ai_timeout']);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const body = parseBody(req);
  const event = String(body.event || '');
  if (!ALLOWED.has(event)) {
    return res.status(400).json({ error: 'Invalid event' });
  }

  const ip = getCallerIp(req);

  // Light rate-limiting so this endpoint can't be used to flood Mongo.
  // Separate bucket so beacons can't starve generation rate budget.
  const rl = await rateLimit(ip, 'evt', {
    perMin: 30, perHour: 500, ipPerHour: 60, ipPerDay: 200
  });
  if (!rl.allowed) {
    return res.status(204).end();   // silently drop — analytics, not user-facing
  }

  // Await: Vercel can freeze the function instance the moment the handler
  // resolves, dropping unawaited Mongo writes (same class of bug as the
  // generate.js share_slug 404). try/catch because logEvent now throws on
  // hard failure — this beacon is fire-and-forget so a logger crash
  // shouldn't 500 the client.
  try {
    await logEvent({
      ip,
      event,
      brief: typeof body.brief === 'string' ? body.brief.slice(0, 6000) : '',
      ref: typeof body.ref === 'string' ? body.ref.slice(0, 40) : null,
      duration_ms: typeof body.duration_ms === 'number' ? body.duration_ms : 0,
      referrer: req.headers.referer || req.headers.referrer || null,
      user_agent: req.headers['user-agent'] || null
    });
  } catch (_) { /* logger gave up; client doesn't care, beacon is best-effort */ }

  return res.status(204).end();
}
