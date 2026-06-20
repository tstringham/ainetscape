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
  makeAuthorToken, hashAuthorToken,
  insertPagePlaceholder, completePageRow
} from './_shared.js';
import { postProcessUnsplash } from './_unsplash.js';

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

IMAGERY DIRECTIVE:
When you want to include a photograph in the page, emit an <img> tag using this special placeholder syntax: <img src="[UNSPLASH:descriptive query terms]" alt="descriptive alt text">. The query terms should specifically describe what the photo should depict.

Examples:
- <img src="[UNSPLASH:vancouver street photography rain at night]" alt="Wet Vancouver street at night">
- <img src="[UNSPLASH:luxury cosmetics flatlay marble surface]" alt="Cosmetics product flatlay">
- <img src="[UNSPLASH:heineken beer bottle green glass]" alt="Heineken bottle">

Be specific with query terms — generic queries like [UNSPLASH:business] return generic photos. Specific queries like [UNSPLASH:wooden desk laptop notebook morning light] return better-matched photos.

The server will replace these placeholders with real Unsplash photos and add a small photo credit below each image. You do NOT need to write the photo credit — that gets added automatically.

Do NOT use other image services (picsum.photos, placeholder.com, source.unsplash.com directly, etc.) — they return random unrelated images. Always use the [UNSPLASH:...] placeholder syntax for photographic imagery.

For non-photographic visuals (icons, decorative elements, color blocks, abstract patterns), continue using CSS, SVG, and typography. Reserve Unsplash placeholders for actual photographs.

INTERACTIVE ELEMENTS (non-negotiable):
- Every clickable element MUST work without a backend. Use only:
  (a) in-page anchor links that jump to a section on the same page (e.g. <a href="#features">Features</a> targeting <section id="features">), or
  (b) external links to genuine, well-known URLs (e.g. https://example.com).
- NEVER emit a <button> with no behavior, NEVER use href="#" or href="javascript:void(0)" stubs, NEVER write "Get Started" or "Sign Up" buttons that go nowhere.
- For navigation menus, use anchor links to sections you actually build on the page. If you write a "Pricing" link in the nav, you MUST include a <section id="pricing"> further down.
- For CTAs in pitch/SaaS/portfolio pages: prefer an anchor to an on-page contact section (with form OR a mailto: link OR a phone number) over a dead "Start Free Trial" button.

CONTACT (when the brief implies one):
- For now, contact affordances must be a working mailto: link (e.g. <a href="mailto:webmaster@ainetscape.com?subject=Hello">Contact us</a>) — NOT a contact form that submits to a non-existent backend.
- If the brief explicitly asks for a "contact form", build the form's UI but make the submit button a mailto: link OR have it open the user's email client via window.location.href = 'mailto:...' with the form fields encoded into the body.
- If the brief does NOT imply a contact need, do NOT add a contact affordance just to fill space.

COPYRIGHT + DATES (in-character):
- If the page includes a footer copyright line, the year MUST be 1997 (e.g. "© 1997 Whiskers Esq. Law").
- If the page includes any "Last updated", "Founded in", or "Established" date, the year MUST be 1997 unless the brief explicitly asks otherwise.
- This is non-negotiable — the site lives in 1997 forever.

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

  // ---- Stage 1 of the two-stage write ----
  // Pre-write a placeholder row with the slug + author hash before any
  // headers are sent. If this fails, the share-slug + author-token headers
  // are suppressed, so the client never shows a Share button pointing at
  // a row that doesn't exist. Briefs are stored here too — abuse review
  // works even on requests that never complete.
  let placeholderOk = false;
  if (sharingEnabled) {
    try {
      await insertPagePlaceholder({
        ip,
        share_slug: shareSlug,
        author_token_hash: hashAuthorToken(authorToken),
        brief, ref,
        referrer: req.headers.referer || req.headers.referrer || null,
        user_agent: req.headers['user-agent'] || null
      });
      placeholderOk = true;
    } catch (err) {
      console.error('[CRITICAL] placeholder insert failed; share UI will be',
        'suppressed for this request — err:', err && err.message);
    }
  }

  const startedAt = Date.now();
  let streamingStarted = false;
  let clientGone = false;

  // Detect client disconnect so we can log ai_disconnected when the stream
  // ends. We keep reading the upstream stream to completion (refusals are
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

    // Buffer the upstream stream server-side rather than forwarding chunks
    // to the client. Post-processing (Unsplash placeholder substitution)
    // must run on the whole HTML before any of it is sent, otherwise the
    // client would render unresolved [UNSPLASH:...] strings and we'd lose
    // the chance to swap them in-place. The tradeoff: no incremental
    // chunks on the client; full page arrives in one shot once the
    // upstream model + substitution are done. The client's silence timer
    // accommodates this (see STREAM_SILENCE_MS in public/index.html).
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
          if (choice.delta.content) accumulated += choice.delta.content;
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

    // Classify the event before sending anything — drives both the response
    // body and which event we log.
    const wasRefusal = accumulated.startsWith('REFUSED::');
    let event;
    if (clientGone) {
      event = 'ai_disconnected';
    } else if (wasRefusal) {
      event = 'ai_refused';
    } else {
      event = 'ai_generation_completed';
    }

    // Unsplash substitution runs ONLY on successful HTML output — refusals
    // are short literal strings, disconnects mean nobody's listening. If
    // substitution throws (e.g. Mongo cache module fails to import), fall
    // back to the unsubstituted HTML so the user still gets a page rather
    // than a 500. Individual photo failures already degrade to CSS
    // fallback blocks inside postProcessUnsplash.
    let finalBody = accumulated;
    if (event === 'ai_generation_completed' && accumulated.includes('[UNSPLASH:')) {
      try {
        finalBody = await postProcessUnsplash(accumulated);
      } catch (err) {
        console.error('[unsplash] post-processing threw — sending unsubstituted',
          'HTML to avoid losing the generation:', err && err.message);
        finalBody = accumulated;
      }
    }

    // Headers + body written together at the end. Done now (rather than
    // earlier) so a downstream error path can still respond with JSON.
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    // Only expose the share + author headers when the placeholder row
    // actually landed in Mongo — guarantees /p/:slug will resolve to a
    // real row (body may be empty if completion later fails, but the
    // row exists and /p/:slug shows the in-character 404 vs. nothing).
    if (placeholderOk && shareSlug)   res.setHeader('X-AINetscape-Share-Slug',  shareSlug);
    if (placeholderOk && authorToken) res.setHeader('X-AINetscape-Author-Token', authorToken);
    res.status(200);
    streamingStarted = true;
    if (!clientGone) {
      try { res.write(finalBody); } catch (_) { clientGone = true; }
    }
    try { res.end(); } catch (_) {}

    const cachePayload = {
      content: [{ type: 'text', text: finalBody }],
      stop_reason: stopReason,
      model: MODEL,
      usage,
      share_slug: shareSlug    // sticky across cache hits
    };

    // Pull the <title> out of the generated HTML for the gallery card display.
    let pageTitle = null;
    if (event === 'ai_generation_completed') {
      const m = /<title>([\s\S]*?)<\/title>/i.exec(finalBody || '');
      if (m) pageTitle = m[1].trim().slice(0, 200);
    }

    // ---- Stage 2 of the two-stage write ----
    // If a placeholder row exists (sharingEnabled + placeholderOk), update
    // it in place. Cache is only populated on a successful completion so
    // subsequent identical briefs never replay a slug whose Mongo row was
    // lost. Without a placeholder (Mongo off, or stage 1 failed), fall
    // through to the legacy single-insert logEvent path for analytics.
    let completionOk = false;
    if (placeholderOk) {
      try {
        await completePageRow({
          share_slug: shareSlug,
          event,
          body_html: finalBody || null,
          page_title: pageTitle,
          data: cachePayload,
          duration_ms: Date.now() - startedAt,
          verdict: wasRefusal ? accumulated.slice('REFUSED::'.length).trim().slice(0, 200) : null
        });
        completionOk = true;
      } catch (err) {
        console.error('[CRITICAL] /p/' + shareSlug + ' — completion update',
          'failed; row will stay ai_generation_pending and /p/:slug will',
          '404 via the in-character page:', err.message);
      }
    } else {
      // Either sharing is off or the placeholder failed. No row to update —
      // still write an analytics-only event so we have a record.
      try {
        await logEvent({
          ip, event, brief, data: cachePayload, ref,
          duration_ms: Date.now() - startedAt,
          referrer: req.headers.referer || req.headers.referrer || null,
          user_agent: req.headers['user-agent'] || null,
          verdict: wasRefusal ? accumulated.slice('REFUSED::'.length).trim().slice(0, 200) : null,
          body_html: finalBody || null,
          // No share_slug, no author hash — there's no row for it to attach to.
          page_title: pageTitle,
          source: 'ai',
          is_public: true
        });
      } catch (_) { /* logger gave up; nothing else we can do */ }
    }

    // Only populate the cache when both writes landed — otherwise a future
    // cache hit would replay a slug whose row doesn't fully exist.
    if (completionOk) cache.set(cacheKey, cachePayload);
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
