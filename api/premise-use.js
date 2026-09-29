// /api/premise-use.js
//
// Which composer chips this visitor has already dispatched.
//
// SEPARATE FROM /api/premises ON PURPOSE. That endpoint is CDN-cached for
// fifteen minutes because the catalogue is the same for everyone. This answer
// is different for every caller, so putting it there would serve one visitor's
// history to the next. no-store, always.
//
// Retirement used to live only in localStorage, which loses it on a cleared
// cache, a private window, a different browser, or a different origin — so a
// premise dispatched yesterday could be offered back today looking like a bug.
// This makes it durable.
//
// Keyed by the same salted IP hash votes and hits use: anonymous, no account,
// and the raw address is never stored. Per-visitor, NOT global — retiring a
// premise for everyone the first time anyone used it would consume the
// catalogue in about two days at launch traffic.
//
//   GET  /api/premise-use            -> { used: [label, ...] }
//   POST /api/premise-use  { label } -> { ok: true }

import crypto from 'crypto';
import { getCallerIp, parseBody, rateLimit } from './_shared.js';

// Same construction as recordVote/recordHit in _shared.js, so one visitor has
// one identity across every feature that counts them.
function hashIp(ip) {
  return crypto.createHash('sha256')
    .update((process.env.IP_HASH_SALT || 'ainetscape-default-salt-change-me') + String(ip))
    .digest('hex').slice(0, 16);
}

export default async function handler(req, res) {
  const isWrite = req.method === 'POST';
  if (req.method !== 'GET' && !isWrite) {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  res.setHeader('Cache-Control', 'no-store');

  // No database, no memory. The client keeps its localStorage copy and the
  // composer behaves exactly as it did before this endpoint existed.
  if (!process.env.MONGODB_URI) return res.status(200).json({ used: [], degraded: 'no-db' });

  const ip = getCallerIp(req);

  // Generous, and it gates the WRITE only — a visitor over their allowance
  // still gets their list back, they just stop adding to it. A chip dialog
  // must never fail to open because of a rate limit.
  const rl = await rateLimit(ip, 'premise', {
    perMin: 60, ipPerHour: 400, ipPerDay: 2000,
    perHour: 1_000_000_000_000,
    skipGlobal: true
  });

  try {
    const { getUsedPremises, recordUsedPremise } = await import('./_db.js');
    const ipHash = hashIp(ip);

    if (isWrite) {
      const label = String((parseBody(req) || {}).label || '').trim();
      if (!label) return res.status(400).json({ error: 'label required' });
      if (rl.allowed) await recordUsedPremise(ipHash, label);
      return res.status(200).json({ ok: true, recorded: !!rl.allowed });
    }

    return res.status(200).json({ used: await getUsedPremises(ipHash) });
  } catch (err) {
    // Degrade to the client's own copy rather than failing the dialog.
    console.error('[premise-use] failed:', err && (err.message || err));
    return res.status(200).json({ used: [], degraded: 'error' });
  }
}
