// /api/generate.js
//
// AI Composer build endpoint. Triage now lives in /api/triage.js; this
// endpoint assumes the caller already classified the brief as buildable
// (or is forcing through with forceBuild=true after a triage warning).
//
// Streams the Anthropic SSE response straight through to the client as
// raw text. The client uses byte count for a real progress bar.

import {
  getCallerIp, parseBody, rateLimit, rateLimitMessage,
  makeCache, logEvent
} from './_shared.js';

const MODEL                    = 'claude-sonnet-4-6';
const MAX_TOKENS               = 8000;
const MIN_BRIEF_LENGTH         = 3;
const MAX_BRIEF_LENGTH         = 6000;
const RATE_LIMIT_PER_MIN       = 5;
const GLOBAL_RATE_LIMIT_PER_HR = 200;

// ============================================================
// System prompt — assembled server-side. Never sent to the browser.
// ============================================================
const DESIGN_RULES = `You are an elite frontend designer producing a single-file HTML page in 2026 for a viewer who works at Andreessen Horowitz. Your output will be judged ruthlessly on aesthetic taste and execution quality.

OUTPUT RULES:
- Return ONLY raw HTML starting with <!DOCTYPE html>. No markdown, no code fences, no preamble, no commentary, nothing before or after.
- Single self-contained file: all CSS in <style>, all JS in <script>, no external libraries except Google Fonts via <link>.
- Mobile-first responsive. Test mentally at 375px, 768px, 1440px.

DESIGN RULES — these are non-negotiable:
- Commit to a strong aesthetic direction within the first paragraph of CSS. Options include: editorial magazine, refined Swiss minimalism, neo-brutalism, art-deco luxury, terminal/monospace, neo-grotesque maximalism, organic/painterly. Pick ONE and execute it with conviction.
- Typography is the first impression. Pair a distinctive display face with a refined body face from Google Fonts. NEVER use Inter, Roboto, Arial, or system-ui as the primary face. Strong pairings: Fraunces + Inter Tight; Instrument Serif + a refined sans; Space Grotesk + IBM Plex Mono; PP Editorial-style serifs; Bricolage Grotesque.
- Color: commit to a dominant palette. No purple-to-pink gradients on white. No "AI startup" sapphire-on-cloud. If you want a single accent color against a neutral base, lean into it.
- Layout: avoid hero-features-CTA cookie-cutter structure unless the brief explicitly demands it. Use asymmetry, generous negative space, deliberate overlap, type as visual element. Grid-breaking is welcome.
- Real content: write actual copy that fits the brief. No "Lorem ipsum." No "Your Company Here." Invent plausible names, quotes, product details, prices.
- Subtle motion: one tasteful page-load reveal, hover states on interactive elements. No carousels, no parallax scroll-jacking.

WHAT TO AVOID (these are tell-tale signs of generic AI output):
- Three-column feature card grids with identical SVG icons
- Purple/pink/sapphire gradients
- "Built for modern teams" copy
- Centered hero with "Get Started" CTA
- Stock-looking testimonial blocks with placeholder names
- Excessive emoji
- "Loved by 10,000+ teams" social proof bars
- Tailwind-default rounded-2xl cards with subtle shadows

The page must feel like it was made by a human designer with strong opinions. If you find yourself reaching for a generic pattern, stop and choose something more interesting.`;

const RETRO_BRANCH = `SPECIAL CASE — RETRO BUILD:
If the brief is clearly asking for a 1997-style web artifact (animated GIF tribute, flaming logo, hit counter shrine, webring, "Under Construction" page, Geocities homage, marquee madness), DO build it — but build it with full 2026 craftsmanship while preserving the 1997 aesthetic intent.

Use CSS animations to recreate the look of animated GIFs. Use SVG for the "flames" — actual procedural fire animation, not static. Use modern web techniques to nail the period look with surgical precision. The output should be:
- Aesthetically 1997 (color palette, typography, layout cliche)
- Technically 2026 (CSS keyframes, SVG, performant, responsive)

A 1997 idea executed with 2026 craft. Examples:
- Flaming logo: SVG logotype with realistic CSS-animated flame layered behind. Hot-orange-to-yellow gradient. Subtle ember particles.
- Hit counter shrine: a homepage celebrating that you have had 00042 visitors, with a giant pixelated counter, sunburst background, period-correct serif headlines.
- "Under Construction": a real construction-zone vibe with an animated SVG construction-worker stand-in, hazard tape, "Pardon Our Dust" headline.

Even for a retro build, still output ONLY raw HTML starting with <!DOCTYPE html>.`;

const TRY_ANYWAY_ADDENDUM = `The user has been warned this request exceeds the scope of a single HTML page and has chosen to proceed anyway. Attempt the brief earnestly within the constraints of a single self-contained HTML file. If the result is necessarily incomplete (e.g., "scales to a million users" cannot be tested), make the demo charming and self-aware about its limitations. A single line of CSS commentary or a small UI element acknowledging the constraint is welcome but not required.`;

function buildSystemMessage(forceBuild) {
  if (forceBuild) {
    return TRY_ANYWAY_ADDENDUM + '\n\n----\n\n' + DESIGN_RULES + '\n\n' + RETRO_BRANCH;
  }
  return DESIGN_RULES + '\n\n' + RETRO_BRANCH;
}

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

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error('Missing ANTHROPIC_API_KEY env var');
    return res.status(500).json({ error: 'The service is not configured correctly.' });
  }

  const ip = getCallerIp(req);
  const body = parseBody(req);

  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  const forceBuild = body.forceBuild === true;
  const ref = typeof body.ref === 'string' ? body.ref.slice(0, 40) : null;

  if (brief.length < MIN_BRIEF_LENGTH) {
    return res.status(400).json({ error: 'Please provide a brief.' });
  }
  if (brief.length > MAX_BRIEF_LENGTH) {
    return res.status(400).json({ error: `Brief too long (maximum ${MAX_BRIEF_LENGTH} characters).` });
  }

  // Rate limit BEFORE the cache, so repeated identical briefs still trip it.
  const rl = await rateLimit(ip, 'gen', {
    perMin: RATE_LIMIT_PER_MIN,
    perHour: GLOBAL_RATE_LIMIT_PER_HR
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: rateLimitMessage(rl.scope) });
  }

  // Response cache. Cached entries are stored as the assembled text payload
  // and served back as a single chunk over the streaming protocol.
  const cacheKey = (forceBuild ? 'F:' : 'N:') + brief;
  const cached = cache.get(cacheKey);
  if (cached) {
    const cachedText = ((cached.content) || [])
      .filter(b => b && b.type === 'text')
      .map(b => b.text)
      .join('');
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.status(200);
    res.write(cachedText);
    res.end();
    return;
  }

  const startedAt = Date.now();
  let streamingStarted = false;

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
        stream: true,
        // Array form + cache_control: the large system prompt is identical
        // across requests, so Anthropic prompt caching cuts repeat cost.
        system: [{
          type: 'text',
          text: buildSystemMessage(forceBuild),
          cache_control: { type: 'ephemeral' }
        }],
        messages: [{ role: 'user', content: 'Brief:\n\n' + brief }]
      })
    });

    if (!upstream.ok) {
      let errBody = null;
      try { errBody = await upstream.json(); } catch (_) {}
      console.error('Anthropic API error:', upstream.status, errBody && errBody.error);
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({
        error: (errBody && errBody.error && errBody.error.message) || 'The generation service returned an error.'
      });
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');
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

        if (parsed.type === 'content_block_delta'
            && parsed.delta && parsed.delta.type === 'text_delta') {
          const t = parsed.delta.text || '';
          if (t) {
            accumulated += t;
            res.write(t);
          }
        } else if (parsed.type === 'message_delta' && parsed.delta) {
          if (parsed.delta.stop_reason) stopReason = parsed.delta.stop_reason;
          if (parsed.usage) usage = parsed.usage;
        } else if (parsed.type === 'error' && parsed.error) {
          console.error('Anthropic streaming error:', parsed.error);
        }
      }
    }

    // Truncation handling. Two cases:
    //   1. No text emitted (context filled before any output) — emit the
    //      bandwidth-exceeded triage line so the client routes to the modal.
    //   2. Text emitted but truncated mid-page — append a sentinel comment
    //      the client picks up post-stream to overlay the warning modal.
    if (stopReason === 'max_tokens') {
      if (!accumulated.trim()) {
        const sentinel = 'TRIAGE::warn_bandwidth_exceeded';
        res.write(sentinel);
        accumulated = sentinel;
      } else {
        res.write('\n<!--TRIAGE_TRAILER:warn_bandwidth_exceeded-->');
      }
    }

    res.end();

    // Cache + log. Mid-page truncation is cached as the warning so repeat
    // requests don't replay the broken page.
    const cachePayload = {
      content: [{ type: 'text', text: accumulated }],
      stop_reason: stopReason,
      model: MODEL,
      usage
    };
    if (stopReason === 'max_tokens') {
      cachePayload.content = [{ type: 'text', text: 'TRIAGE::warn_bandwidth_exceeded' }];
    }
    cache.set(cacheKey, cachePayload);

    logEvent({
      ip, kind: 'generate', brief, data: cachePayload, ref, forceBuild,
      duration_ms: Date.now() - startedAt,
      referrer: req.headers.referer || req.headers.referrer || null,
      user_agent: req.headers['user-agent'] || null
    });
  } catch (err) {
    console.error('Handler error:', err);
    if (streamingStarted) {
      try { res.end(); } catch (_) {}
    } else {
      return res.status(500).json({ error: 'The generation request could not be completed.' });
    }
  }
}
