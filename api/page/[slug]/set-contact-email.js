// /api/page/[slug]/set-contact-email.js
//
// POST endpoint that lets the original author of /p/[slug] register or
// change the email address where contact-form submissions go.
//
// Auth model:
//   - Author proves identity by sending the author token that was issued
//     in the X-AINetscape-Author-Token response header at generation time
//   - We hash it (SHA-256, unsalted — already 128 random bits) and match
//     against the author_token_hash stored on the row
//   - No author token, or no matching row, → 404 (don't leak which slugs
//     exist, don't tell a brute-forcer that the token was wrong)
//
// POST /api/page/[slug]/set-contact-email
//   Header:  X-AINetscape-Author-Token: <32-hex>
//   Body:    { "recipient_email": "you@example.com" }
//            or { "recipient_email": null } to clear
//
// Returns 200 { ok: true } on success. Sets recipient_email +
// recipient_email_set_at on the generations row.

import {
  getCallerIp, parseBody, rateLimit, rateLimitMessage, hashAuthorToken
} from '../../_shared.js';

const VALID_SLUG  = /^[A-Za-z0-9]{6,20}$/;
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_EMAIL   = 200;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'Service is temporarily unavailable.' });
  }

  const slug = String((req.query && req.query.slug) || '').trim();
  if (!VALID_SLUG.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug.' });
  }

  const token = req.headers['x-ainetscape-author-token'];
  if (!token || typeof token !== 'string' || token.length < 8) {
    return res.status(401).json({ error: 'Missing author token.' });
  }
  const authorTokenHash = hashAuthorToken(token);

  const ip = getCallerIp(req);
  // Tight bucket — there's no normal reason for one IP to PATCH many
  // recipient emails in rapid succession. Generous enough for honest
  // typo-fix bursts.
  const rl = await rateLimit(ip, 'recipient', {
    perMin: 5, perHour: 30, ipPerHour: 20, ipPerDay: 40
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  const body = parseBody(req);
  let email = body.recipient_email;
  if (email === null || email === undefined || email === '') {
    email = null;
  } else if (typeof email === 'string') {
    email = email.trim().slice(0, MAX_EMAIL);
    if (!VALID_EMAIL.test(email)) {
      return res.status(400).json({ error: 'Please provide a valid email address.' });
    }
  } else {
    return res.status(400).json({ error: 'recipient_email must be a string or null.' });
  }

  try {
    const { setContactRecipient } = await import('../../_db.js');
    const result = await setContactRecipient({
      slug,
      author_token_hash: authorTokenHash,
      recipient_email: email
    });
    if (!result.ok) {
      // not_found_or_unauthorized — could be wrong slug, wrong token,
      // or the row was deleted. Don't distinguish.
      return res.status(404).json({ error: 'That page could not be found.' });
    }
    return res.status(200).json({ ok: true, recipient_email: email });
  } catch (err) {
    console.error('[set-contact-email] update failed:',
      err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'The recipient could not be saved.' });
  }
}
