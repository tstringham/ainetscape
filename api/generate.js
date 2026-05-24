// /api/generate.js
//
// Single AI Composer endpoint. Every submission goes straight to the
// active provider's model — no pre-classifier — and the model's own
// contextual judgment handles refusals via a single-line response
// `REFUSED::reason` that the client detects on the first chunk (fails
// fast in ~1s instead of burning a full generation cycle).
//
// ============================================================
// Multi-provider AI waterfall — priority order
// ============================================================
// Canonical register of providers. Add, remove, or re-order here and
// mirror any change in `/memory/project_ai_waterfall.md`. The MODEL
// constant below must match the PRIMARY entry.
//
//   1. PRIMARY    xAI Grok 4               — faster, lower cost,
//                                             generous quota
//   2. FALLBACK   Anthropic Claude Sonnet  — strongest design taste,
//                                             reliable refusals
//
//   FUTURE CANDIDATES (under evaluation, not yet wired):
//     - Google Gemini
//     - OpenAI
//
// Fallback triggers: timeouts, REFUSED responses, malformed output,
// rate-limit / quota exhaustion. Provider names live here and in
// engineering docs — never in user-facing chrome.
// ============================================================

import {
  getCallerIp, parseBody, rateLimit, rateLimitMessage,
  makeCache, logEvent, makeShareSlug,
  makeAuthorToken, hashAuthorToken
} from './_shared.js';

// Must match the PRIMARY provider in the waterfall table above.
const MODEL                    = 'grok-4';
const MAX_TOKENS               = 8000;
const MIN_BRIEF_LENGTH         = 3;
const MAX_BRIEF_LENGTH         = 6000;
// Per-IP burst/hour/day + global ceiling. Single-IP daily cap ≈ $5/day at
// worst-case token usage.
const RATE_LIMIT_PER_MIN       = 5;
const GLOBAL_RATE_LIMIT_PER_HR = 200;
const IP_LIMIT_PER_HOUR        = 20;
const IP_LIMIT_PER_DAY         = 40;

// ============================================================
// System prompt — assembled server-side. Never sent to the browser.
// Opens up creative scope and removes the over-cautious TRIAGE step.
// ============================================================
const SYSTEM_PROMPT = `You are an elite frontend designer producing a single-file HTML page in 2026 for a sophisticated audience. Your output will be judged ruthlessly on aesthetic taste and execution quality.

USER TRUST POSTURE:
The user is an adult building a creative website. Treat every brief as legitimate creative work. Cultural references (Naked Chef, life drawing, artistic nudes, satire, parody, edgy humor, niche subcultures), edgy creative briefs, body-positive content, art history, and tongue-in-cheek requests are all welcome and should be built as requested. Do not second-guess the user's intent. Do not water down their brief. Do not add safety disclaimers, cautions, or "this site is for educational purposes" footers. Build what they asked for.

You only refuse if the brief specifically requests content that would cause concrete real-world harm — functional malware code, sexual content involving minors, doxxing or harassment of named real people, or actionable instructions for mass-casualty harm. These are rare. If a brief is in this narrow category, return ONLY a single line: REFUSED::brief-reason-here

OUTPUT FORMAT:
- For everything else, return ONLY raw HTML starting with <!DOCTYPE html>. No markdown, no code fences, no preamble, no commentary, nothing before or after.
- Single self-contained file: all CSS in <style>, all JS in <script>, no external libraries except Google Fonts via <link>.
- Mobile-first responsive. Test mentally at 375px, 768px, 1440px.

DESIGN RULES (non-negotiable):
- Commit to a strong aesthetic direction within the first paragraph of CSS. Options include: editorial magazine, refined Swiss minimalism, neo-brutalism, art-deco luxury, terminal/monospace, neo-grotesque maximalism, organic/painterly. Pick ONE and execute it with conviction.
- Typography is the first impression. Pair a distinctive display face with a refined body face from Google Fonts. Never use Inter, Roboto, Arial, or system-ui as the primary face. Strong pairings: Fraunces + Inter Tight; Instrument Serif + a refined sans; Space Grotesk + IBM Plex Mono; PP Editorial-style serifs; Bricolage Grotesque.
- Color: commit to a dominant palette. No purple-to-pink gradients on white. No "AI startup" sapphire-on-cloud.
- Layout: avoid hero-features-CTA cookie-cutter structure unless the brief explicitly demands it. Use asymmetry, generous negative space, deliberate overlap, type as visual element.
- Real content: write actual copy that fits the brief. No "Lorem ipsum." Invent plausible names, quotes, details, prices.
- Subtle motion: one tasteful page-load reveal, hover states on interactive elements. No carousels.

AVOID (signs of generic AI output):
- Three-column feature card grids with identical SVG icons
- Purple/pink/sapphire gradients
- "Built for modern teams" copy
- Centered hero with "Get Started" CTA
- Tailwind-default rounded-2xl cards with subtle shadows
- "Loved by 10,000+ teams" social proof
- Excessive emoji

The page must feel like it was made by a human designer with strong opinions.`;

const cache = makeCache({ ttlMs: 10 * 60 * 1000, maxEntries: 200 });

// ============================================================
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed.' });
  }

  // Instant off-switch — no redeploy needed.
  if (process.env.AI_KILL_SWITCH === '1') {
    return res.status(503).json({ error: 'AI Composer is temporarily offline for maintenance. Please try again later.' });
  }

  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    console.error('Missing XAI_API_KEY env var');
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

  const rl = await rateLimit(ip, 'gen', {
    perMin:    RATE_LIMIT_PER_MIN,
    perHour:   GLOBAL_RATE_LIMIT_PER_HR,
    ipPerHour: IP_LIMIT_PER_HOUR,
    ipPerDay:  IP_LIMIT_PER_DAY
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  // Sharing only "lights up" when Mongo is wired — without persistent
  // storage, /p/:slug would 404. Suppress the header in that case so the
  // client hides the Share UI rather than offering a broken link.
  const sharingEnabled = !!process.env.MONGODB_URI;

  // Cache hit — replay the assembled text as a single chunk. Reuse the
  // slug stored on the cache entry so two visitors with the same brief
  // share the same canonical URL.
  const cacheKey = brief;
  const cached = cache.get(cacheKey);
  if (cached) {
    const cachedText = ((cached.content) || [])
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    if (sharingEnabled && cached.share_slug) {
      res.setHeader('X-AINetscape-Share-Slug', cached.share_slug);
    }
    res.status(200);
    res.write(cachedText);
    res.end();
    return;
  }

  const shareSlug   = sharingEnabled ? makeShareSlug()   : null;
  // Fresh-only — never sent on cache hits, so only the original generator's
  // browser ever sees the raw token. Subsequent viewers can't claim authorship.
  const authorToken = sharingEnabled ? makeAuthorToken() : null;

  const startedAt = Date.now();
  let streamingStarted = false;
  let clientGone = false;

  // Detect client disconnect so we can log ai_disconnected when the stream
  // ends. We keep reading Anthropic's stream to completion (refusals are
  // tiny; full pages aren't worth re-fetching) but flag the state.
  req.on('close', () => { clientGone = true; });

  try {
    // xAI Chat Completions — OpenAI-shaped API. System prompt is the first
    // message rather than a top-level field; no prompt caching available
    // (the 3KB system prompt gets re-billed each request).
    const upstream = await fetch('https://api.x.ai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + apiKey
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        stream: true,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: 'Brief:\n\n' + brief }
        ]
      })
    });

    if (!upstream.ok) {
      let errBody = null;
      try { errBody = await upstream.json(); } catch (_) {}
      console.error('xAI API error:', upstream.status, errBody && (errBody.error || errBody));
      try {
        await logEvent({
          ip, event: 'ai_generation_failed', brief, ref,
          duration_ms: Date.now() - startedAt,
          referrer: req.headers.referer || null,
          user_agent: req.headers['user-agent'] || null
        });
      } catch (_) { /* logger gave up; xAI error response still goes out */ }
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({
        error: (errBody && errBody.error && (errBody.error.message || errBody.error))
            || 'The generation service returned an error.'
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    if (shareSlug)   res.setHeader('X-AINetscape-Share-Slug',  shareSlug);
    if (authorToken) res.setHeader('X-AINetscape-Author-Token', authorToken);
    res.status(200);
    streamingStarted = true;

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let sseBuf = '';
    let accumulated = '';
    let stopReason = null;
    let usage = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      sseBuf += decoder.decode(value, { stream: true });

      // OpenAI-style SSE: events are `data: <json>` lines separated by
      // blank lines, with a `data: [DONE]` terminator on completion.
      let evtEnd;
      while ((evtEnd = sseBuf.indexOf('\n\n')) >= 0) {
        const rawEvent = sseBuf.slice(0, evtEnd);
        sseBuf = sseBuf.slice(evtEnd + 2);

        let dataLine = null;
        for (const line of rawEvent.split('\n')) {
          if (line.startsWith('data:')) { dataLine = line.slice(5).trim(); break; }
        }
        if (!dataLine || dataLine === '[DONE]') continue;

        let parsed;
        try { parsed = JSON.parse(dataLine); } catch (_) { continue; }

        const choice = parsed.choices && parsed.choices[0];
        if (choice && choice.delta && typeof choice.delta.content === 'string') {
          const t = choice.delta.content;
          if (t) {
            accumulated += t;
            if (!clientGone) {
              try { res.write(t); } catch (_) { clientGone = true; }
            }
          }
        }
        if (choice && choice.finish_reason) {
          stopReason = choice.finish_reason;
        }
        if (parsed.usage) {
          // xAI emits usage on the final chunk. Normalize to the same shape
          // _db.js expects (output_tokens / input_tokens).
          usage = {
            input_tokens: parsed.usage.prompt_tokens || 0,
            output_tokens: parsed.usage.completion_tokens || 0
          };
        }
      }
    }

    try { res.end(); } catch (_) {}

    // Classify the event after the stream completes.
    const wasRefusal = accumulated.startsWith('REFUSED::');
    let event;
    if (clientGone) {
      event = 'ai_disconnected';
    } else if (wasRefusal) {
      event = 'ai_refused';
    } else {
      event = 'ai_generation_completed';
    }

    const cachePayload = {
      content: [{ type: 'text', text: accumulated }],
      stop_reason: stopReason,
      model: MODEL,
      usage,
      share_slug: shareSlug    // sticky across cache hits
    };
    // Cache successful builds and refusals alike; a repeated identical
    // brief should get the same answer instantly.
    cache.set(cacheKey, cachePayload);

    // Only record the share slug + author hash for actual successful builds,
    // not refusals or partial disconnects — those shouldn't be publicly
    // addressable or claimable.
    const persistedSlug = (event === 'ai_generation_completed') ? shareSlug : null;
    const persistedAuthorHash = (event === 'ai_generation_completed' && authorToken)
      ? hashAuthorToken(authorToken) : null;

    // Pull the <title> out of the generated HTML for the gallery card display
    // (Phase 2). Avoids re-parsing body_html on every gallery query.
    let pageTitle = null;
    if (event === 'ai_generation_completed') {
      const m = /<title>([\s\S]*?)<\/title>/i.exec(accumulated || '');
      if (m) pageTitle = m[1].trim().slice(0, 200);
    }

    // Must await: the share slug header has already been sent to the client,
    // so the Mongo row must be persisted before the function returns — Vercel
    // can freeze the instance the moment the handler resolves, and an
    // unawaited insert would land /p/:slug as a 404. Wrapped in try/catch
    // because logEvent now throws on hard failure (after one retry) — the
    // share-slug header is already out; nothing we can do about the dead
    // link, but at least the function returns cleanly and the error lands
    // loudly in Vercel logs.
    try {
      await logEvent({
        ip, event, brief, data: cachePayload, ref,
        duration_ms: Date.now() - startedAt,
        referrer: req.headers.referer || req.headers.referrer || null,
        user_agent: req.headers['user-agent'] || null,
        verdict: wasRefusal ? accumulated.slice('REFUSED::'.length).trim().slice(0, 200) : null,
        // Archive whatever the model emitted — full HTML on success, REFUSED
        // line on refusal, partial body if the client disconnected mid-stream.
        body_html: accumulated || null,
        share_slug: persistedSlug,
        // Gallery fields (Phase 1 — counters init at 0 in _db.js, is_public
        // defaults true, source defaults 'ai'):
        page_title: pageTitle,
        author_token_hash: persistedAuthorHash,
        source: 'ai',
        is_public: true
      });
    } catch (err) {
      // logEvent already logged the full stack across both retry attempts;
      // re-flag at this layer so the slug-to-404 cause is obvious in logs.
      console.error('[CRITICAL] /p/' + (persistedSlug || '<none>') +
        ' will 404 — logger gave up on the completion write:', err.message);
    }
  } catch (err) {
    console.error('Handler error:', err);
    if (streamingStarted) {
      try { res.end(); } catch (_) {}
    } else {
      try {
        await logEvent({
          ip, event: 'ai_generation_failed', brief, ref,
          duration_ms: Date.now() - startedAt,
          referrer: req.headers.referer || null,
          user_agent: req.headers['user-agent'] || null
        });
      } catch (_) { /* logger gave up; 500 still goes out to client */ }
      return res.status(500).json({ error: 'The generation request could not be completed.' });
    }
  }
}
