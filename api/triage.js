// /api/triage.js
//
// Fast pre-flight classifier. Runs Haiku 4.5 against the brief and returns
// a single TRIAGE::category verdict in well under a second. The client uses
// the verdict to either render a warn/refuse modal (no full generation) or
// proceed to /api/generate for the build.
//
// Separate rate-limit bucket from /api/generate so the two endpoints can't
// starve each other. Same per-IP cap (5/min) and global cap (200/hr) since
// triage is the gating call — burning it down would also block generates.

import {
  getCallerIp, parseBody, rateLimit, rateLimitMessage,
  makeCache, logEvent
} from './_shared.js';

const MODEL                  = 'claude-haiku-4-5-20251001';
const MAX_TOKENS             = 32;     // one TRIAGE::word line is ~6 tokens
const MIN_BRIEF_LENGTH       = 3;
const MAX_BRIEF_LENGTH       = 6000;
const RATE_LIMIT_PER_MIN     = 5;
const GLOBAL_RATE_LIMIT_PER_HR = 200;

const SYSTEM_PROMPT = `You are a triage classifier for AI Netscape, a parody site that generates single HTML pages.

Read the user's brief and classify it into exactly one of these categories. Return ONLY a single line: TRIAGE::category

Categories:
- build — reasonable single HTML page request
- warn_scope — too large for single HTML page (full SaaS, requires database/auth/payments/backend, "scales to millions")
- warn_anachronism — explicitly requires 2026 capabilities the joke can't support (real-time multiplayer, mobile app, browser extension)
- warn_nonsense — empty, gibberish, fewer than 5 meaningful characters, non-language
- refuse_abuse — malware, phishing, harassment material, harmful content
- refuse_offtopic — homework, legal/medical/financial advice, anything that's not building a website

Return only the single line. No other text.`;

const KNOWN_VERDICTS = new Set([
  'build',
  'warn_scope', 'warn_anachronism', 'warn_nonsense',
  'refuse_abuse', 'refuse_offtopic'
]);

const cache = makeCache({ ttlMs: 10 * 60 * 1000, maxEntries: 500 });

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  if (process.env.AI_KILL_SWITCH === '1') {
    return res.status(503).json({ error: 'AI Composer is temporarily offline for maintenance. Please try again later.' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'The service is not configured correctly.' });
  }

  const ip = getCallerIp(req);
  const body = parseBody(req);
  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  const ref = typeof body.ref === 'string' ? body.ref.slice(0, 40) : null;

  if (brief.length < MIN_BRIEF_LENGTH) {
    return res.status(400).json({ error: 'Please provide a brief.' });
  }
  if (brief.length > MAX_BRIEF_LENGTH) {
    return res.status(400).json({ error: `Brief too long (maximum ${MAX_BRIEF_LENGTH} characters).` });
  }

  const rl = await rateLimit(ip, 'tri', {
    perMin: RATE_LIMIT_PER_MIN,
    perHour: GLOBAL_RATE_LIMIT_PER_HR
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  // Cache verdicts per brief — identical text re-triages to the same answer.
  const cached = cache.get(brief);
  if (cached) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);
    res.write(cached.text);
    res.end();
    return;
  }

  const startedAt = Date.now();
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        system: [{
          type: 'text',
          text: SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral' }
        }],
        messages: [{ role: 'user', content: 'Brief:\n\n' + brief }]
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic triage error:', upstream.status, data && data.error);
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({
        error: (data && data.error && data.error.message) || 'The triage service returned an error.'
      });
    }

    // Extract the verdict line. Haiku is constrained but defensively parse.
    const raw = ((data && data.content) || [])
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join('\n')
      .trim();
    const firstLine = raw.split('\n')[0].trim();
    const m = firstLine.match(/^TRIAGE::(\w+)$/);
    let verdict = m && m[1];
    if (!verdict || !KNOWN_VERDICTS.has(verdict)) {
      // Unknown / unparseable output — default to 'build' so the user can
      // still proceed; better to over-allow than to wrongly refuse.
      verdict = 'build';
    }
    const responseText = 'TRIAGE::' + verdict;

    cache.set(brief, { text: responseText });

    logEvent({
      ip, kind: 'triage', brief, data, ref, verdict,
      duration_ms: Date.now() - startedAt,
      referrer: req.headers.referer || req.headers.referrer || null,
      user_agent: req.headers['user-agent'] || null
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);
    res.write(responseText);
    res.end();
  } catch (err) {
    console.error('Triage handler error:', err);
    return res.status(500).json({ error: 'The triage request could not be completed.' });
  }
}
