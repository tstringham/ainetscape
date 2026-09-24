// /api/admin/health.js
//
// Admin-only configuration check. Answers one question that has now cost this
// project real time twice: IS THIS ACTUALLY CONFIGURED?
//
// Why it exists. api/cta.js returns 200 whether or not mail is sent — by
// design, because a visitor's confirmation must never depend on delivery. The
// consequence is that a working contact form and a completely dead one look
// identical from outside, and the only place the difference was written was a
// Vercel function log. RESEND_API_KEY went missing from Production and every
// submission was silently dropped; nothing on the site said so, and the notes
// in CLAUDE.md asserted the opposite. This endpoint makes that state readable
// in one request.
//
// NEVER returns a secret value. Presence booleans and lengths only — enough to
// tell "unset" from "set but wrong" (a truncated paste shows up as a bad
// length) without putting a key on screen, in a log, or in a shell history.
//
// Auth: same shared secret as the other admin endpoints
// (x-admin-token === ADMIN_EDIT_TOKEN). Refuses when the env var is unset, so
// a misconfigured deploy cannot accept any token.
//
// GET /api/admin/health
//   → { config: { <VAR>: { present, length } }, submissions: {...}, ok }

import { adminTokenValid } from '../_shared.js';

// Every variable the running site depends on, and what breaks without it.
const REQUIRED = [
  ['MONGODB_URI',             'database — generations, counters, submissions'],
  ['RESEND_API_KEY',          'contact form + CTA delivery to webmaster@'],
  ['XAI_API_KEY',             'primary AI provider'],
  ['ADMIN_EDIT_TOKEN',        'these admin endpoints'],
  ['IP_HASH_SALT',            'IP anonymisation']
];
const OPTIONAL = [
  ['UPSTASH_REDIS_REST_URL',  'durable rate limits + vote dedupe (falls back to per-instance memory)'],
  ['UPSTASH_REDIS_REST_TOKEN','durable rate limits + vote dedupe'],
  ['ANTHROPIC_API_KEY',       'fallback AI provider'],
  ['PEXELS_API_KEY',          'image pipeline (primary)'],
  ['UNSPLASH_ACCESS_KEY',     'image pipeline (legacy/failover)'],
  ['GITHUB_DISPATCH_TOKEN',   'thumbnail workflow dispatch'],
  ['CRON_SECRET',             'scheduled jobs']
];

function report(list) {
  const out = {};
  for (const [name, why] of list) {
    const v = process.env[name];
    out[name] = { present: !!v, length: v ? v.length : 0, purpose: why };
  }
  return out;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Fail closed: a missing ADMIN_EDIT_TOKEN refuses everyone rather than
  // accepting anyone.
  if (!adminTokenValid(req)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  res.setHeader('Cache-Control', 'no-store');

  const required = report(REQUIRED);
  const optional = report(OPTIONAL);
  const missingRequired = Object.keys(required).filter((k) => !required[k].present);

  let submissions = null;
  if (process.env.MONGODB_URI) {
    try {
      const { submissionHealth } = await import('../_db.js');
      submissions = await submissionHealth();
    } catch (err) {
      submissions = { error: String(err && err.message).slice(0, 200) };
    }
  }

  return res.status(200).json({
    ok: missingRequired.length === 0,
    missingRequired,
    required,
    optional,
    submissions
  });
}
