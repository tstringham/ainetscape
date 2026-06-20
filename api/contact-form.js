// /api/contact-form.js
//
// POST endpoint that handles submissions from contact forms embedded in
// AI-generated pages. The model emits:
//   <form action="/api/contact-form" method="POST">
//     <input type="hidden" name="slug" value="...">
//     <input type="text"   name="website" style="display:none">  ← honeypot
//     <input type="text"   name="name">
//     <input type="email"  name="email">
//     <textarea name="message"></textarea>
//   </form>
// (the hidden slug + honeypot get injected by the generate.js
// post-processor — the model itself doesn't write them).
//
// Submissions are emailed via Resend from webmaster@ainetscape.com to
// whichever address the original page author registered after generation
// (see /api/page/[slug]/set-contact-email and api/_db.js#setContactRecipient).
//
// Reqs (per brief B5):
//   - Per-IP + per-form rate limit (its own bucket so it can't starve gen)
//   - Hidden honeypot field — if filled, return 200 silently (don't tell
//     the bot it was caught)
//   - Subject line ties to page_title — "New message from your <PAGE> page"
//
// Hard prerequisite: RESEND_API_KEY env var set, and DNS auth (SPF/DKIM
// for webmaster@ainetscape.com) completed in Resend. Without either, the
// send fails — see the error-handling block.

import { getCallerIp, parseBody, rateLimit, rateLimitMessage } from './_shared.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;
// Lightweight RFC5322-ish check. Resend will reject malformed addresses
// on its end; this just catches the obvious junk fast.
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_NAME    = 100;
const MAX_EMAIL   = 200;
const MAX_MESSAGE = 4000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }
  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'Contact submissions are temporarily unavailable.' });
  }

  const body = parseBody(req);

  // Honeypot. The post-processor injects an input named "website" that is
  // visually hidden + tabindex=-1; real users never fill it, bots will.
  // Return 200 so the bot doesn't know it was detected.
  if (body.website && String(body.website).trim() !== '') {
    return res.status(200).json({ ok: true });
  }

  const slug    = String(body.slug    || '').trim();
  const name    = String(body.name    || '').trim().slice(0, MAX_NAME);
  const email   = String(body.email   || '').trim().slice(0, MAX_EMAIL);
  const message = String(body.message || '').trim().slice(0, MAX_MESSAGE);

  if (!VALID_SLUG.test(slug))   return res.status(400).json({ error: 'Invalid slug.' });
  if (!name)                    return res.status(400).json({ error: 'Please provide your name.' });
  if (!VALID_EMAIL.test(email)) return res.status(400).json({ error: 'Please provide a valid email address.' });
  if (!message)                 return res.status(400).json({ error: 'Please include a message.' });

  const ip = getCallerIp(req);

  // Dedicated bucket — contact spam can't starve the generation budget,
  // and one abusive form can't lock another page's form. Per-day cap is
  // tight; legitimate users rarely submit > 5 contact forms in a day.
  const rl = await rateLimit(ip, 'contact', {
    perMin: 3, perHour: 20, ipPerHour: 10, ipPerDay: 25
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  let recipient;
  try {
    const { getContactRecipient } = await import('./_db.js');
    recipient = await getContactRecipient(slug);
  } catch (err) {
    console.error('[contact-form] recipient lookup failed:',
      err && (err.stack || err.message || err));
    return res.status(500).json({ error: 'Submission could not be processed.' });
  }

  if (!recipient) {
    return res.status(404).json({ error: 'That page is no longer accepting submissions.' });
  }
  if (!recipient.recipient_email) {
    // The author hasn't registered an inbox yet. Don't 500 the visitor —
    // surface a clean polite error so the form UI can show it.
    return res.status(409).json({
      error: 'This contact form has not been configured by its author.'
    });
  }

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    console.error('[contact-form] RESEND_API_KEY not set — cannot send');
    return res.status(503).json({ error: 'The mail server is offline.' });
  }

  const pageTitle = recipient.page_title || 'AI Netscape page';
  const pageUrl   = 'https://ainetscape.com/p/' + slug;
  const subject   = `New message from your ${pageTitle} page`;

  // HTML + plaintext alternate. Both omitted-from-API would silently
  // fall back to "text" but explicit is clearer and improves rendering
  // on broken mail clients.
  const safeName    = escapeHtml(name);
  const safeEmail   = escapeHtml(email);
  const safeMessage = escapeHtml(message);
  const safeTitle   = escapeHtml(pageTitle);

  const htmlBody =
    `<p>Someone submitted the contact form on your AI Netscape page <b>${safeTitle}</b>:</p>` +
    `<table style="border-collapse:collapse;margin:12px 0;">` +
      `<tr><td style="padding:4px 12px 4px 0;color:#555;">From:</td>` +
        `<td style="padding:4px 0;">${safeName} &lt;${safeEmail}&gt;</td></tr>` +
      `<tr><td style="padding:4px 12px 4px 0;color:#555;">Page:</td>` +
        `<td style="padding:4px 0;"><a href="${escapeAttr(pageUrl)}">${escapeAttr(pageUrl)}</a></td></tr>` +
    `</table>` +
    `<div style="border-left:3px solid #999;padding-left:12px;color:#222;">` +
      `${safeMessage.replace(/\n/g, '<br>')}` +
    `</div>` +
    `<p style="margin-top:24px;color:#888;font-size:11px;">` +
      `Reply directly to this message to respond to ${safeName}. AI Netscape forwards the email as-is.` +
    `</p>`;

  const textBody =
    `Someone submitted the contact form on your AI Netscape page "${pageTitle}":\n\n` +
    `From: ${name} <${email}>\n` +
    `Page: ${pageUrl}\n\n` +
    `${message}\n\n` +
    `--\nReply directly to this message to respond to ${name}.\n`;

  // Send via Resend HTTP API. No npm dependency — raw fetch keeps the
  // serverless bundle small. Set reply-to to the sender's address so the
  // recipient can hit Reply and land back at the visitor.
  let resendResp;
  try {
    resendResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: 'AI Netscape <webmaster@ainetscape.com>',
        to: [recipient.recipient_email],
        reply_to: email,
        subject,
        html: htmlBody,
        text: textBody
      })
    });
  } catch (err) {
    console.error('[contact-form] Resend network failure:', err && err.message);
    return res.status(502).json({ error: 'Mail server unreachable. Please try again later.' });
  }

  if (!resendResp.ok) {
    let detail = '';
    try { detail = JSON.stringify(await resendResp.json()); } catch (_) {}
    console.error('[contact-form] Resend rejected:', resendResp.status, detail);
    // 422 from Resend usually = invalid `from` domain or unverified DNS;
    // surface a friendly message rather than the raw API error.
    return res.status(502).json({ error: 'Mail server rejected the message.' });
  }

  return res.status(200).json({ ok: true });
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
