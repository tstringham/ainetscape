// /api/cta.js
//
// Generated-page CTA + contact/order/signup submissions. Every generated page
// ships a small dispatcher (public/cta-dispatch.js, injected by generate.js)
// that POSTs here; this endpoint emails the submission to the site owner via
// Resend.
//
// Launch-spike design decision: the owner inbox is a FIXED address
// (webmaster@ainetscape.com). This is deliberately NOT the per-page-recipient
// flow in api/contact-form.js (that path needs a recipient_email registered per
// slug and 409s until it is — still unwired). Subject is prefixed "[AI Netscape]"
// so the owner can filter the launch flood.
//
// NEVER errors the visitor: honeypot, rate-limit, missing key, and Resend
// failure all return 200 (failures logged server-side) so the page can always
// show its 1997 "dispatched to the webmaster" confirmation.
//
// The generated document runs in a sandboxed, opaque-origin iframe (no
// allow-same-origin on /p/:slug), so requests arrive cross-origin with
// Origin: null. CORS is wide-open (no credentials sent) and OPTIONS is handled,
// so both CORS-simple (text/plain) and preflighted (application/json) posts get
// through.

import { getCallerIp, parseBody, rateLimit } from './_shared.js';

const OWNER_INBOX = 'webmaster@ainetscape.com';
const FROM        = 'AI Netscape <webmaster@ainetscape.com>';
const VALID_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const MAX_TITLE   = 140;
const MAX_ACTION  = 140;
const MAX_URL     = 300;
const MAX_FIELD_K = 60;
const MAX_FIELD_V = 4000;
const MAX_FIELDS  = 25;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const body = parseBody(req);

  // Honeypot: a hidden field named "website" (top-level or inside fields) is
  // filled only by bots. Silent 200 — never reveal detection, never send.
  const hpTop  = body.website;
  const hpNest = body.fields && typeof body.fields === 'object' ? body.fields.website : '';
  if ((hpTop && String(hpTop).trim()) || (hpNest && String(hpNest).trim())) {
    return res.status(200).json({ ok: true });
  }

  // Dedicated bucket so CTA spam can't starve the generation budget. A
  // rate-limited visitor is dropped SILENTLY (still 200) — the drop is the
  // anti-abuse action; erroring them would only leak that a limit exists.
  let rl;
  try {
    rl = await rateLimit(getCallerIp(req), 'cta', { perMin: 6, perHour: 40, ipPerHour: 30, ipPerDay: 100 });
  } catch (_) { rl = { allowed: true }; }
  if (rl && !rl.allowed) return res.status(200).json({ ok: true });

  const title  = clean(body.title,  MAX_TITLE) || 'A web page';
  const action = clean(body.action, MAX_ACTION);
  const url     = clean(body.url,   MAX_URL);
  const fields  = normalizeFields(body.fields);
  const replyTo = pickReplyTo(fields);

  const resendKey = process.env.RESEND_API_KEY;
  if (!resendKey) {
    // Config gap — log, but still 200 so the visitor sees the confirmation.
    console.error('[cta] RESEND_API_KEY not set — dropping submission for', JSON.stringify(title));
    return res.status(200).json({ ok: true });
  }

  const subject = ('[AI Netscape] ' + title).slice(0, 180);
  const { html, text } = renderEmail({ title, action, url, fields });

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: FROM,
        to: [OWNER_INBOX],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject,
        html,
        text
      })
    });
    if (!r.ok) {
      let detail = '';
      try { detail = JSON.stringify(await r.json()); } catch (_) {}
      console.error('[cta] Resend rejected:', r.status, detail);
    }
  } catch (err) {
    console.error('[cta] Resend network failure:', err && err.message);
  }

  // ALWAYS 200 — the visitor's confirmation must never depend on delivery.
  return res.status(200).json({ ok: true });
}

// Single-line fields (title/action/url): collapse whitespace, trim, cap.
function clean(v, max) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);
}

// Form fields: preserve newlines in values (messages), cap counts + sizes,
// drop the honeypot key if it slipped in.
function normalizeFields(raw) {
  const out = [];
  if (!raw || typeof raw !== 'object') return out;
  for (const k of Object.keys(raw)) {
    if (out.length >= MAX_FIELDS) break;
    const key = String(k).replace(/\s+/g, ' ').trim().slice(0, MAX_FIELD_K);
    if (!key || key.toLowerCase() === 'website') continue;
    let val = raw[k];
    val = (val == null ? '' : String(val)).slice(0, MAX_FIELD_V);
    out.push({ key, value: val });
  }
  return out;
}

// Reply-To = the visitor's email so the owner can hit Reply. Prefer a field
// literally named email; else the first field whose value is a valid address.
function pickReplyTo(fields) {
  for (const f of fields) {
    if (/e-?mail/i.test(f.key) && VALID_EMAIL.test(f.value.trim())) return f.value.trim();
  }
  for (const f of fields) {
    if (VALID_EMAIL.test(f.value.trim())) return f.value.trim();
  }
  return null;
}

function renderEmail({ title, action, url, fields }) {
  const rows = fields.map((f) =>
    `<tr><td style="padding:4px 12px 4px 0;color:#555;vertical-align:top;">${safe(f.key)}</td>` +
    `<td style="padding:4px 0;">${safe(f.value).replace(/\n/g, '<br>')}</td></tr>`
  ).join('');
  const html =
    `<p>A visitor used <b>${safe(title)}</b> on AI Netscape.</p>` +
    (action ? `<p style="color:#555;">Action: <b>${safe(action)}</b></p>` : '') +
    (rows
      ? `<table style="border-collapse:collapse;margin:12px 0;">${rows}</table>`
      : `<p style="color:#888;">(no form fields — single-click CTA)</p>`) +
    (url ? `<p style="color:#888;font-size:12px;">Page: <a href="${safe(url)}">${safe(url)}</a></p>` : '');
  const text =
    `A visitor used "${title}" on AI Netscape.\n` +
    (action ? `Action: ${action}\n` : '') +
    (fields.length
      ? '\n' + fields.map((f) => `${f.key}: ${f.value}`).join('\n') + '\n'
      : '\n(no form fields — single-click CTA)\n') +
    (url ? `\nPage: ${url}\n` : '');
  return { html, text };
}

function safe(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
