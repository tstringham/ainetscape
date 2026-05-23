// /api/generate.js
//
// AI Composer proxy. The Anthropic key AND the system prompt both live
// here, server-side — the browser only ever sends a brief. That keeps the
// key safe and stops anyone from POSTing their own system prompt.
//
// Durable rate limiting via Upstash Redis (truly global across all
// serverless instances), with an in-memory fallback if Redis is absent.
// Optional anonymized logging via Mongo (gated on MONGODB_URI).

import { Redis } from '@upstash/redis';

const MODEL                     = 'claude-sonnet-4-6';
const MAX_TOKENS                = 4500;
const MIN_BRIEF_LENGTH          = 3;
const MAX_BRIEF_LENGTH          = 6000;
const RATE_LIMIT_PER_MIN        = 5;     // generations per minute, per IP
const GLOBAL_RATE_LIMIT_PER_HR  = 200;   // hard cap across all callers
const CACHE_TTL_MS              = 10 * 60 * 1000;
const CACHE_MAX_ENTRIES         = 200;

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

const TRIAGE_INSTRUCTION = `TRIAGE STEP — BEFORE ANY OTHER LOGIC:

Read the brief and decide which category it falls into. Your first response must be a single line in this exact format:

TRIAGE::<category>

Categories:
- "build" — reasonable single-HTML-page brief. Proceed to build it per the rules below.
- "warn_scope" — request is too large for a single HTML page (full SaaS, multi-page app, requires database/backend/auth/payment, "scales to a million users", etc.). The user CAN proceed if they insist.
- "warn_anachronism" — request explicitly assumes 2026 capabilities a single static page can't support (real-time multiplayer, mobile app, browser extension, AI agent, etc.). User can proceed if they insist.
- "warn_nonsense" — brief is empty, gibberish, fewer than 5 meaningful characters, or non-language.
- "refuse_abuse" — request is for malware, phishing, CSAM, harassment material, or content that would cause real harm. Hard refusal.
- "refuse_offtopic" — request is for something this tool clearly cannot do (homework, legal advice, medical diagnosis, financial advice). Hard refusal.

After the TRIAGE:: line, on a new line:
- If verdict is "build": continue with the full HTML output per the build rules below.
- If verdict is "warn_*" or "refuse_*": output nothing else. The client renders the response.

The triage line must be the FIRST line of your response.`;

const TRY_ANYWAY_ADDENDUM = `The user has been warned this request exceeds the scope of a single HTML page and has chosen to proceed anyway. Skip the TRIAGE step entirely — go straight to build. Attempt the brief earnestly within the constraints of a single self-contained HTML file. If the result is necessarily incomplete (e.g., "scales to a million users" cannot be tested), make the demo charming and self-aware about its limitations. A single line of CSS commentary or a small UI element acknowledging the constraint is welcome but not required.`;

function buildSystemMessage(forceBuild) {
  if (forceBuild) {
    return TRY_ANYWAY_ADDENDUM + '\n\n----\n\n' + DESIGN_RULES + '\n\n' + RETRO_BRANCH;
  }
  return TRIAGE_INSTRUCTION + '\n\n----\n\n' +
    'WHEN THE VERDICT IS "build", the line after TRIAGE::build must begin the HTML page (<!DOCTYPE html>). Follow these build rules exactly:\n\n' +
    DESIGN_RULES + '\n\n' + RETRO_BRANCH;
}

// ============================================================
// Rate limiting — durable (Upstash) with an in-memory fallback.
// ============================================================
let _redis;
function getRedis() {
  if (_redis !== undefined) return _redis;
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  _redis = (url && token) ? new Redis({ url, token }) : null;
  return _redis;
}

// In-memory fallback. Per-instance only — used for local dev or if Redis
// is unreachable. Real viral protection comes from Upstash.
const memIpBuckets = new Map();
let memGlobalBucket = [];
function memRateLimit(ip) {
  const now = Date.now();
  const minStart = now - 60 * 1000;
  const hrStart = now - 60 * 60 * 1000;

  memGlobalBucket = memGlobalBucket.filter(t => t > hrStart);
  if (memGlobalBucket.length >= GLOBAL_RATE_LIMIT_PER_HR) {
    return { allowed: false, scope: 'global', retryAfter: 3600 };
  }
  const bucket = (memIpBuckets.get(ip) || []).filter(t => t > minStart);
  if (bucket.length >= RATE_LIMIT_PER_MIN) {
    return { allowed: false, scope: 'ip', retryAfter: 60 };
  }
  bucket.push(now);
  memGlobalBucket.push(now);
  memIpBuckets.set(ip, bucket);
  if (memIpBuckets.size > 1000) {
    for (const [k, v] of memIpBuckets) {
      if (v[v.length - 1] < minStart) memIpBuckets.delete(k);
    }
  }
  return { allowed: true };
}

async function rateLimit(ip) {
  const redis = getRedis();
  if (!redis) return memRateLimit(ip);
  try {
    const now = Date.now();
    const ipKey = `rl:ip:${ip}:${Math.floor(now / 60000)}`;
    const globalKey = `rl:global:${Math.floor(now / 3600000)}`;

    const ipCount = await redis.incr(ipKey);
    if (ipCount === 1) await redis.expire(ipKey, 120);
    if (ipCount > RATE_LIMIT_PER_MIN) {
      return { allowed: false, scope: 'ip', retryAfter: 60 };
    }
    const globalCount = await redis.incr(globalKey);
    if (globalCount === 1) await redis.expire(globalKey, 7200);
    if (globalCount > GLOBAL_RATE_LIMIT_PER_HR) {
      return { allowed: false, scope: 'global', retryAfter: 3600 };
    }
    return { allowed: true };
  } catch (err) {
    console.error('Redis rate limiter failed — falling back to in-memory:', err);
    return memRateLimit(ip);
  }
}

// ============================================================
// Tiny in-memory response cache. A cache miss only costs one
// generation, so a per-instance cache is fine — it mainly absorbs
// bursts of identical example clicks.
// ============================================================
const cache = new Map();
function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return entry.data;
}
function cacheSet(key, data) {
  cache.set(key, { data, ts: Date.now() });
  if (cache.size > CACHE_MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// ============================================================
// Fire-and-forget anonymized logging (only if MONGODB_URI is set).
// Logger failures must never affect the user response.
// ============================================================
async function logGeneration(event) {
  try {
    const { logEvent } = await import('./_db.js');
    await logEvent(event);
  } catch (err) {
    console.error('Logger module failed:', err);
  }
}

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

  // Caller IP (Vercel sets x-forwarded-for).
  const ip = ((req.headers['x-forwarded-for'] || '').split(',')[0].trim())
    || req.headers['x-real-ip']
    || 'unknown';

  // Body — Vercel parses JSON, but tolerate a raw string too.
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
  body = body || {};

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
  const rl = await rateLimit(ip);
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).json({
      error: rl.scope === 'global'
        ? 'The exchange is at capacity. Please try again in an hour.'
        : 'The line is busy. Please wait a minute and try again.'
    });
  }

  // Response cache.
  const cacheKey = (forceBuild ? 'F:' : 'N:') + brief;
  const cached = cacheGet(cacheKey);
  if (cached) return res.status(200).json(cached);

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

    const data = await upstream.json();

    if (!upstream.ok) {
      console.error('Anthropic API error:', upstream.status, data && data.error);
      const status = upstream.status === 429 ? 429 : 502;
      return res.status(status).json({
        error: (data && data.error && data.error.message) || 'The generation service returned an error.'
      });
    }

    cacheSet(cacheKey, data);

    if (process.env.MONGODB_URI) {
      logGeneration({
        ip, brief, data, ref, forceBuild,
        duration_ms: Date.now() - startedAt,
        referrer: req.headers.referer || req.headers.referrer || null,
        user_agent: req.headers['user-agent'] || null
      }).catch(err => console.error('Log failed:', err));
    }

    return res.status(200).json(data);
  } catch (err) {
    console.error('Handler error:', err);
    return res.status(500).json({ error: 'The generation request could not be completed.' });
  }
}
