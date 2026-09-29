// /api/cron/ops-report.js
//
// Hourly activity + spend report, emailed to the operator. Built for a launch
// window, and designed to switch itself off afterwards.
//
// WHY IT EXPIRES ON ITS OWN. This was asked for as "hourly, for the next 48
// hours, just in case". A cron has no memory of why it was created, so left
// alone this would still be mailing a report every hour next March. It refuses
// to send after OPS_REPORT_UNTIL, so forgetting to remove it costs nothing.
//
// WHY THE RECIPIENT IS AN ENV VAR. This repository is public and the operator's
// real inbox is not webmaster@ainetscape.com. Hardcoding it here would publish
// it. OPS_ALERT_EMAIL is set in Vercel and never appears in git.
//
// FAILS CLOSED, TWICE. No CRON_SECRET, no OPS_ALERT_EMAIL, or no
// OPS_REPORT_UNTIL and nothing is sent. A misconfigured deploy is silent
// rather than mailing a stranger.
//
// Scheduled from .github/workflows/ops-report.yml rather than vercel.json,
// because Vercel's Hobby plan allows two cron jobs and both are spoken for
// (site-of-the-week, thumbnails). Actions minutes are free on a public repo.
//
//   GET /api/cron/ops-report      Authorization: Bearer <CRON_SECRET>

import crypto from 'crypto';
import { Redis } from '@upstash/redis';

// From the note above the generation caps: a 40/day single-IP allowance was
// costed at ~$5/day worst case. Override with OPS_COST_PER_GEN if the real
// number lands elsewhere — it is an estimate and the email says so.
const COST_PER_GEN = Number(process.env.OPS_COST_PER_GEN || 0.125);
const GEN_CEILING_PER_HR = Number(process.env.OPS_GEN_CEILING || 1200);
const FROM = 'AI Netscape Ops <webmaster@ainetscape.com>';

function timingSafeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  const expected = 'Bearer ' + String(process.env.CRON_SECRET || '');
  if (!process.env.CRON_SECRET || !timingSafeEqual(req.headers.authorization || '', expected)) {
    return res.status(404).json({ error: 'Not found.' });
  }

  const to = process.env.OPS_ALERT_EMAIL;
  const until = process.env.OPS_REPORT_UNTIL;
  if (!to)    return res.status(200).json({ ok: true, sent: false, reason: 'OPS_ALERT_EMAIL not set' });
  if (!until) return res.status(200).json({ ok: true, sent: false, reason: 'OPS_REPORT_UNTIL not set' });

  const deadline = new Date(until);
  if (isNaN(+deadline)) return res.status(200).json({ ok: true, sent: false, reason: 'OPS_REPORT_UNTIL unparseable' });
  if (Date.now() > +deadline) {
    return res.status(200).json({ ok: true, sent: false, reason: 'window closed', until });
  }

  let stats;
  try {
    stats = await gather();
  } catch (err) {
    console.error('[ops-report] gather failed:', err && (err.stack || err.message));
    return res.status(200).json({ ok: false, sent: false, reason: 'gather failed' });
  }

  const key = process.env.RESEND_API_KEY;
  if (!key) return res.status(200).json({ ok: true, sent: false, reason: 'RESEND_API_KEY not set', stats });

  const { subject, text, html } = render(stats, deadline);
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM, to: [to], subject, text, html })
    });
    if (!r.ok) {
      let d = ''; try { d = JSON.stringify(await r.json()); } catch (_) {}
      console.error('[ops-report] Resend rejected:', r.status, d);
      return res.status(200).json({ ok: false, sent: false, reason: 'resend ' + r.status, stats });
    }
  } catch (err) {
    console.error('[ops-report] Resend network failure:', err && err.message);
    return res.status(200).json({ ok: false, sent: false, reason: 'resend network', stats });
  }
  return res.status(200).json({ ok: true, sent: true, stats });
}

async function gather() {
  const { opsSnapshot } = await import('../_db.js');
  const snap = await opsSnapshot();

  // How close the current clock hour is to the spend ceiling. This is the
  // number that decides whether visitors start seeing "the exchange is at
  // capacity", and it is invisible everywhere else. Kept here rather than in
  // _db.js because it reads Redis, not Mongo.
  let ceilingUsed = null;
  try {
    const url = process.env.UPSTASH_REDIS_REST_URL, token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if (url && token) {
      const redis = new Redis({ url, token });
      const v = await redis.get(`rl:gen:global:${Math.floor(Date.now() / 3600000)}`);
      ceilingUsed = Number(v) || 0;
    }
  } catch (_) { /* a missing gauge must not cost the report */ }

  return { ...snap, ceilingUsed };
}

function render(s, deadline) {
  const money = (n) => '$' + n.toFixed(2);
  const costHr = s.genHour * COST_PER_GEN;
  const cost24 = s.gen24 * COST_PER_GEN;
  const pct = s.ceilingUsed == null ? null : Math.round((s.ceilingUsed / GEN_CEILING_PER_HR) * 100);
  const hoursLeft = Math.max(0, Math.round((+deadline - Date.now()) / 3600e3));

  // Deliberately plain. This is an alert read at speed, possibly at 3am; the
  // house voice belongs on the site, not on the instrument panel.
  const lines = [
    `GENERATION`,
    `  last hour        ${s.genHour}   (~${money(costHr)})`,
    `  last 24h         ${s.gen24}   (~${money(cost24)})`,
    `  all time         ${s.genTotal}`,
    `  avg duration     ${(s.avgMs / 1000).toFixed(1)}s`,
    `  tokens 24h       ${s.tokensIn.toLocaleString()} in / ${s.tokensOut.toLocaleString()} out`,
    ``,
    `SPEND CEILING`,
    pct == null
      ? `  current hour     unavailable (no Redis)`
      : `  current hour     ${s.ceilingUsed} / ${GEN_CEILING_PER_HR}  (${pct}%)${pct >= 80 ? '   <-- APPROACHING CAP' : ''}`,
    ``,
    `OUTCOMES (24h)`,
    ...Object.entries(s.events).map(([k, v]) => `  ${k.padEnd(24)} ${v}`),
    ``,
    `PROVIDERS (24h)`,
    ...Object.entries(s.models).map(([k, v]) => `  ${k.padEnd(24)} ${v}`),
    ``,
    `TRAFFIC`,
    `  homepage visits  ${s.visits}${s.visitsDelta == null ? '' : `   (+${s.visitsDelta} since last report)`}`,
    `  page views       ${s.hits}`,
    `  cool votes       ${s.votes}`,
    ``,
    `HEALTH`,
    `  undelivered mail ${s.undelivered == null ? 'n/a' : s.undelivered}`,
    ``,
    `Cost is an estimate at ${money(COST_PER_GEN)}/generation, not a bill.`,
    `Reports stop automatically in ~${hoursLeft}h (OPS_REPORT_UNTIL).`,
    `Emergency brake: set AI_KILL_SWITCH=1 in Vercel — no redeploy needed.`
  ];
  const text = lines.join('\n');

  const flag = pct != null && pct >= 80 ? ' [CAP ' + pct + '%]' : '';
  return {
    subject: `AI Netscape ops — ${s.genHour} gen/hr, ~${money(cost24)} today${flag}`,
    text,
    html: `<pre style="font:13px ui-monospace,Menlo,monospace;line-height:1.45">${
      text.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</pre>`
  };
}
