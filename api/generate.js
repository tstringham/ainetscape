// /api/generate.js
//
// Single AI Composer endpoint. Every submission goes straight to the
// active provider's model — no pre-classifier — and the model's own
// contextual judgment handles refusals via a single-line response
// `REFUSED::reason` that the client detects on the first chunk (fails
// fast in ~1s instead of burning a full generation cycle).
//
// ============================================================
// Multi-provider AI waterfall
// ============================================================
// The provider REGISTRY (adapters, env keys, model allow-lists) lives in
// api/_ai_providers.js. The ORDER of rungs is config-driven: read at request
// time from Mongo (settings.aiWaterfall), edited from the admin panel without
// a redeploy, and falling back to DEFAULT_WATERFALL when absent. All three
// providers (xAI, Gemini, Anthropic) are wired; a rung whose API key is
// missing from env is skipped gracefully.
//
// Fall-through triggers: transport error, timeout, or an empty body. A
// deliberate REFUSED:: body is terminal — we never shop a refusal to another
// provider. Provider names live here and in engineering docs — never in
// user-facing chrome. Mirror order/policy changes in
// `/memory/project_ai_waterfall.md`.
// ============================================================

import {
  getCallerIp, parseBody, rateLimit, rateLimitMessage,
  makeCache, logEvent, makeShareSlug,
  makeAuthorToken, hashAuthorToken,
  insertPagePlaceholder, completePageRow,
  getAiWaterfall, findByContentHash
} from './_shared.js';
import { postProcessPexels } from './_pexels.js';
// Unsplash post-processor is retained as the standby failover. The
// system prompt no longer teaches [UNSPLASH:...] so it usually does
// nothing — but pages built before the Pexels cutover may still ship
// with legacy placeholders, and we may temporarily flip back if Pexels
// rate-limits cascade. Cheap insurance: the module short-circuits when
// no [UNSPLASH:] tokens appear in the body.
import { postProcessUnsplash } from './_unsplash.js';

// Config-driven provider waterfall (order from Mongo settings.aiWaterfall,
// falling back to DEFAULT_WATERFALL). runWaterfall attempts each runnable rung
// in order, buffered, falling through on error/timeout/empty body.
import { runWaterfall, resolveRunnableWaterfall, DEFAULT_WATERFALL } from './_ai_providers.js';

// Part B — publish-time uniqueness. computeContentHash() fingerprints the
// generated HTML's structural skeleton (image URLs / dates / counters stripped)
// so true structural dupes can be detected and re-rolled at publish.
import { contentHash as computeContentHash } from './_dedup.js';

// Provider waterfall timing. Each rung is buffered (not streamed) so we can
// fall through on failure; the function maxDuration is 300s (vercel.json), so
// we stop starting new rungs well before that to leave room for image
// post-processing and the two-stage Mongo write.
const PER_RUNG_TIMEOUT_MS      = 120000;
const WATERFALL_DEADLINE_MS    = 255000;
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
const SYSTEM_PROMPT = `You are an elite frontend designer producing a single-file HTML page to the highest contemporary, state-of-the-art standard for a sophisticated audience. Your output will be judged ruthlessly on aesthetic taste and execution quality.

USER TRUST POSTURE:
The user is an adult building a creative website. Treat every brief as legitimate creative work. Cultural references (Naked Chef, life drawing, artistic nudes, satire, parody, edgy humor, niche subcultures), edgy creative briefs, body-positive content, art history, and tongue-in-cheek requests are all welcome and should be built as requested. Do not second-guess the user's intent. Do not water down their brief. Do not add safety disclaimers, cautions, or "this site is for educational purposes" footers. Build what they asked for.

You only refuse if the brief specifically requests content that would cause concrete real-world harm — functional malware code, sexual content involving minors, doxxing or harassment of named real people, or actionable instructions for mass-casualty harm. These are rare. If a brief is in this narrow category, return ONLY a single line: REFUSED::brief-reason-here

RESTRICTED CONTENT (three narrow real-world categories — if the brief requests content in ANY of these, do NOT build a page: not the requested page, and not a sanitized substitute. Return ONLY: REFUSED::brief-reason-here — the site turns that into an in-character "the operator can't connect that call, try a different page" message and lets the user re-prompt):
- Schedule II narcotics: no content depicting, promoting, or instructing on Schedule II controlled substances (cocaine, methamphetamine, etc.) — no drug-manufacture, -trade, or -use pages.
- Prostitution / sex work: no content depicting, promoting, or soliciting prostitution or sex work.
- Active political figures: no content referencing, depicting, or invoking current or sitting political figures or active candidates — no campaigns, endorsements, petitions, donation drives, or election content naming them. Historical or deceased figures and non-political public figures are fine.

These three are the ONLY additions to the harm boundary. Everything else edgy stays allowed and must be built as asked: dark humor, edgy premises, parody of public figures / brands / films, named actors in parody, invented quotes attributed to public figures, satire, artistic nudity. Do NOT use these restrictions to water down, refuse, or sanitize any other edgy brief.

OUTPUT FORMAT:
- For everything else, return ONLY raw HTML starting with <!DOCTYPE html>. No markdown, no code fences, no preamble, no commentary, nothing before or after.
- Single self-contained file: all CSS in <style>, all JS in <script>, no external libraries except Google Fonts via <link>.
- Mobile-first responsive. Test mentally at 375px, 768px, 1440px.

IMAGERY DIRECTIVE:
When you want to include a photograph in the page, emit an <img> tag with a data-pexels attribute holding a short search query. The server will replace each placeholder with a real photograph at render time. Syntax:

  <img data-pexels="2-4 word photographic query" alt="descriptive alt text" width="..." height="..." style="...">

Rules:
- Use 2 to 4 words per query. Specific beats generic — "cozy ramen bar interior" beats "ramen", "minimal designer workspace morning light" beats "office".
- 2 to 5 images maximum per page. Each <img> consumes a backend API call; one or two well-chosen photos beats five thin ones.
- Always include alt text describing what the photo shows. Reuse this in the data-pexels query OR write a more specific query — both work.
- You MAY include width, height, class, style, or other layout attrs alongside data-pexels. They will be preserved on the rendered <img>.
- Do NOT write the src= attribute. Do NOT write a photo credit. Both are added by the server.

Examples:
- <img data-pexels="vancouver street rain night" alt="Wet Vancouver street at night" style="width:100%;aspect-ratio:3/2;object-fit:cover;">
- <img data-pexels="luxury cosmetics flatlay marble" alt="Cosmetics product flatlay" width="800" height="533">
- <img data-pexels="cozy ramen bar interior" alt="Atmospheric ramen bar at night" class="hero-image">

Do NOT emit URLs for any other image service (picsum.photos, placeholder.com, source.unsplash.com, [UNSPLASH:...] tokens, AI-generated image services, etc.) — they return wrong/dead images or have been retired. The data-pexels syntax above is the ONLY supported way to include a photograph.

For non-photographic visuals (icons, decorative elements, color blocks, abstract patterns, dividers), continue using CSS, SVG, and typography. Reserve data-pexels for actual photographs.

INTERACTIVE ELEMENTS (non-negotiable):
- Every clickable element MUST work without a backend. Use only:
  (a) in-page anchor links that jump to a section on the same page (e.g. <a href="#features">Features</a> targeting <section id="features">), or
  (b) external links to genuine, well-known URLs (e.g. https://example.com).
- NEVER emit a <button> with no behavior, NEVER use href="#" or href="javascript:void(0)" stubs, NEVER write "Get Started" or "Sign Up" buttons that go nowhere.
- For navigation menus, use anchor links to sections you actually build on the page. If you write a "Pricing" link in the nav, you MUST include a <section id="pricing"> further down.
- For CTAs in pitch/SaaS/portfolio pages: prefer an anchor to an on-page contact section (with form OR a mailto: link OR a phone number) over a dead "Start Free Trial" button.

CONTACT (when the brief implies one):
- Contact affordances must be a working mailto: link, and the address MUST be EXACTLY webmaster@ainetscape.com — e.g. <a href="mailto:webmaster@ainetscape.com?subject=Reservation">Reserve</a>. NEVER invent or use any other email address (no chef@gmail.com, no studio@<brand>.com, no hello@<brand>.com). webmaster@ainetscape.com is the ONLY email permitted anywhere on the page, even when it doesn't match the fictional brand. You MAY customize ?subject= and ?body=. Do NOT build a contact form that submits to a backend.
- If the brief explicitly asks for a "contact form", build the form's UI but point the submit at webmaster@ainetscape.com — an <a href="mailto:webmaster@ainetscape.com?..."> button OR window.location.href = 'mailto:webmaster@ainetscape.com?...' with the form fields encoded into the body. The address is always webmaster@ainetscape.com — never a brand-specific one.
- If the brief does NOT imply a contact need, do NOT add a contact affordance just to fill space.

INTERACTIVITY (non-negotiable) — every page ships FULLY WIRED. No dead controls, anywhere.
- Never emit href="#", href="javascript:void(0)", or any button/link with no action — this INCLUDES logos and "back to top" controls. A logo or back-to-top must smooth-scroll to the top of the page via a click handler; NEVER href="#".
- On-page nav/anchors stay WITHIN this single generated page (these are single-file 1997-style pages): link to real section IDs you actually build, with smooth scroll.
- Single-CTA actions (Order, Buy, Subscribe, Contact, Register, Book, Donate, Apply): wire an inline click handler that (1) fires a PRE-FILLED mailto to webmaster@ainetscape.com, then (2) ALWAYS shows the in-page confirmation "Your message has been dispatched to the webmaster." without navigating away. The confirmation is MANDATORY here, identical to the form path — not optional, not forms-only.
- Contact/order FORMS: real named fields + a submit button; on submit, an inline handler composes the mailto from the field values (fields → body), fires it, and shows the same in-page confirmation. No external backend, ever.
- SUBJECT — for EVERY mailto, single-CTA actions AND forms alike: exactly \${pageTitle} · via AI Netscape (encoded; fallback "A web page" if the page has no <title>; if the title exceeds 60 characters, truncate it and append "..."). Do NOT freelance an in-voice subject — this exact form is required so the site's attribution stays consistent.
- BODY: the user's entered fields/message FIRST, then a blank line, a separator, and this link-back (consistent with the site's own Share→Email copy):
    Sent from "\${pageTitle}", a website built in under a minute at AI Netscape.
    Build your own — no signup, no payment, modem sounds included: https://ainetscape.com
- Build the mailto by encoding subject and body with encodeURIComponent, matching the existing share-dialog.js pattern (this correctly encodes ampersands &, em-dashes —, and emoji). Do NOT use URLSearchParams.

LAYOUT (non-negotiable) — the page must render cleanly at ANY width, from full-screen down to a bounded ~780px editor frame and mobile:
- Hero and section images must NEVER overlap or clip the headline, nav, or body text. A hero image belongs BEHIND the text (as a background with the copy layered over it) or in its OWN column/row beside or below the heading — NEVER absolutely/fixed positioned on top of the heading so it covers the words. If in doubt, stack image and text vertically.
- Use fluid, responsive layout: max-width containers, flex/grid that wraps, and every <img> constrained with max-width:100%; height:auto. Include at least one @media breakpoint so multi-column sections stack on narrow screens. No fixed pixel widths or oversized images that force horizontal scrolling.
- The page is shown inside a ~780px-wide framed viewport AND full-width — it must look correct in both. Nothing overflows sideways; nothing overlaps.

COPYRIGHT + DATES (in-character):
- If the page includes a footer copyright line, the year MUST be 1997 (e.g. "© 1997 Whiskers Esq. Law").
- If the page includes any "Last updated", "Founded in", or "Established" date, the year MUST be 1997 unless the brief explicitly asks otherwise.
- DATE GUARD (applies to ALL output, not just copyright/footer lines): the generated page must NEVER contain any year, date, or reference later than 1997 — not in the <title>, headings, body copy, captions, image alt text, prices, event dates, or any filename/slug you invent. Post-1997 years are forbidden everywhere: a title like "BRAND — 2026" or "BRAND • 15.03.26" must instead drop the year or use a 1997 date. Treat 1997 as the present — "modern", "as of <year>", version years, and any real-world date after 1997 do not exist on this site.
- This is non-negotiable — the site lives in 1997 forever.

DESIGN RULES (non-negotiable):
- Commit to a strong aesthetic direction within the first paragraph of CSS. Options include: editorial magazine, refined Swiss minimalism, neo-brutalism, art-deco luxury, terminal/monospace, neo-grotesque maximalism, organic/painterly. Pick ONE and execute it with conviction.
- Typography is the first impression. Pair a distinctive display face with a refined body face from Google Fonts. Never use Inter, Roboto, Arial, or system-ui as the primary face. Strong pairings: Fraunces + Inter Tight; Instrument Serif + a refined sans; Space Grotesk + IBM Plex Mono; PP Editorial-style serifs; Bricolage Grotesque.
- Color: commit to a dominant palette. No purple-to-pink gradients on white. No "AI startup" sapphire-on-cloud.
- Layout: avoid hero-features-CTA cookie-cutter structure unless the brief explicitly demands it. Use asymmetry, generous negative space, deliberate overlap, type as visual element.
- Real content: write actual copy that fits the brief. No "Lorem ipsum." Invent plausible names, quotes, details, prices.
- Subtle motion: one tasteful page-load reveal, hover states on interactive elements. No carousels.

CONTENT DEPTH (register-aware — make pages feel complete):
- Build a SUBSTANTIAL page, not a hero + one paragraph + CTA. Most briefs deserve a fully developed treatment: a strong hero PLUS several distinct sections that actually explore the subject, with real, specific body copy (multiple paragraphs where it fits), supporting detail, examples, lists, quotes, and a real closing. Aim for a page a reader scrolls and feels is COMPLETE — as thorough as an obsessive enthusiast's site on that exact topic — not a landing-page stub.
- Develop fully when the format carries argument or narrative: academic paper, keynote, documentary (true-crime / nature), press release, manifesto, civic pamphlet, guide, blog. Invent the specifics — findings, exhibits, a timeline, feature deep-dives, FAQs, numbered steps, catalogue lore — rather than gesturing at them.
- BUT keep formats where brevity IS the craft spare and devastating: a fragrance / luxury ad, a eulogy, a minimalist luxury-auction lot, a one-line keynote punchline. Do NOT pad these with filler sections — restraint is the joke. Depth means the RIGHT amount for the format, never bloat.
- Substance is not filler: more sections of REAL, specific, on-brief content — never the AVOID-list patterns below, never repetition or padding. Generous negative space and depth coexist: well-spaced, substantial content.

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

  // Resolve the provider waterfall: Mongo settings doc if present, else the
  // hardcoded default. Then keep only rungs that are enabled AND whose API key
  // is in env — a keyless rung is skipped, never a hard failure. If nothing is
  // runnable, fail fast before writing a placeholder row.
  let waterfallOrder = DEFAULT_WATERFALL;
  if (sharingEnabled) {
    try {
      const cfg = await getAiWaterfall();
      if (Array.isArray(cfg) && cfg.length) waterfallOrder = cfg;
    } catch (err) {
      console.error('[waterfall] settings read failed; using default order —',
        err && err.message);
    }
  }
  const runnable = resolveRunnableWaterfall(waterfallOrder);
  if (!runnable.length) {
    console.error('[waterfall] no runnable providers — missing API keys for',
      waterfallOrder.map(r => r.provider).join(', '));
    return res.status(500).json({ error: 'The service is not configured correctly.' });
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

  // Detect client disconnect so we can log ai_disconnected. The in-flight
  // provider request still runs to completion (it's cheap to let finish), but
  // the waterfall won't start a new rung once the client is gone.
  req.on('close', () => { clientGone = true; });

  try {
    // ---- Provider waterfall ----
    // Attempt each runnable rung in order, BUFFERED server-side: the whole
    // HTML must exist before any of it ships, because the image post-processor
    // rewrites <img data-pexels="…"> placeholders in place. On transport
    // error / timeout / empty body we fall through to the next rung; a
    // deliberate REFUSED:: body is terminal (we never shop a refusal to
    // another provider). Rungs with no API key were already filtered out.
    let accumulated = '';
    let stopReason  = null;
    let usage       = null;
    let usedModel   = null;

    // ---- Generate, with publish-time uniqueness re-roll (Part B) ----
    // Generation stays free; uniqueness is enforced at PUBLISH only, and only
    // when we're actually publishing (sharing on + placeholder landed). On a
    // structural-duplicate collision we silently re-roll the WHOLE generation,
    // bounded to 3 attempts; a 4th is surfaced regardless so the user never
    // sees an error or a duplicate. The collision check hits Mongo, so it's a
    // no-op on preview (no Mongo) — generation simply publishes once.
    let event, finalBody, wasRefusal = false, contentHash = null;
    const dedupActive = sharingEnabled && placeholderOk;
    const MAX_DEDUP_ATTEMPTS = 3;

    for (let attempt = 1; attempt <= MAX_DEDUP_ATTEMPTS + 1; attempt++) {
      const wf = await runWaterfall({
        order: runnable,
        systemPrompt: SYSTEM_PROMPT,
        userContent: 'Brief:\n\n' + brief,
        maxTokens: MAX_TOKENS,
        perRungTimeoutMs: PER_RUNG_TIMEOUT_MS,
        deadlineMs: WATERFALL_DEADLINE_MS,
        isClientGone: () => clientGone,
        log: (m) => console.log('[waterfall]', m)
      });

      accumulated = wf.text || '';
      stopReason  = wf.stopReason || null;
      usage       = wf.usage || null;
      usedModel   = wf.model || null;

      if (!accumulated) {
        // Every runnable rung errored, timed out, or returned nothing usable.
        console.error('[waterfall] all rungs exhausted —', JSON.stringify(wf.attempts));
        try {
          await logEvent({
            ip, event: 'ai_generation_failed', brief, ref,
            duration_ms: Date.now() - startedAt,
            referrer: req.headers.referer || null,
            user_agent: req.headers['user-agent'] || null
          });
        } catch (_) { /* logger gave up; 502 still goes out */ }
        return res.status(502).json({
          error: 'The generation service is temporarily unavailable. Please try again.'
        });
      }

      // Classify before sending — drives both the response body and the event.
      wasRefusal = accumulated.startsWith('REFUSED::');
      event = clientGone ? 'ai_disconnected'
            : wasRefusal  ? 'ai_refused'
            :               'ai_generation_completed';

      // Image substitution runs ONLY on successful HTML output. Pexels primary,
      // Unsplash legacy failover (short-circuits when no [UNSPLASH:] tokens).
      // On a throw, keep the unsubstituted HTML rather than losing the page.
      finalBody = accumulated;
      if (event === 'ai_generation_completed') {
        try {
          finalBody = await postProcessPexels(finalBody);
        } catch (err) {
          console.error('[pexels] post-processing threw — keeping the page',
            'unsubstituted rather than losing the generation:', err && err.message);
        }
        if (finalBody.includes('[UNSPLASH:')) {
          try {
            finalBody = await postProcessUnsplash(finalBody);
          } catch (err) {
            console.error('[unsplash] legacy post-processing threw — leaving the',
              'remaining placeholders inline:', err && err.message);
          }
        }
      }

      // Uniqueness gate — only for real, publishable pages, only with Mongo.
      // Refusals/disconnects are never deduped.
      if (event !== 'ai_generation_completed' || !dedupActive) break;
      contentHash = computeContentHash(finalBody);
      let collision = false;
      try {
        collision = !!(await findByContentHash(contentHash));
      } catch (err) {
        console.error('[dedup] pre-write hash check failed — publishing without',
          're-roll:', err && err.message);
      }
      if (!collision) break;                            // unique → publish
      if (attempt > MAX_DEDUP_ATTEMPTS) {               // exhausted → surface
        console.warn('[dedup] re-roll exhausted after', MAX_DEDUP_ATTEMPTS,
          'structural-duplicate collisions — surfacing attempt', attempt);
        break;
      }
      console.log('[dedup] structural duplicate on attempt', attempt, '— re-rolling');
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
      model: usedModel,
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
          contentHash,
          verdict: wasRefusal ? accumulated.slice('REFUSED::'.length).trim().slice(0, 200) : null
        });
        completionOk = true;
      } catch (err) {
        // Duplicate-key error = a concurrent publish claimed this exact
        // contentHash between our pre-write check and this write (the partial
        // unique index firing). The body is already sent, so we can't re-roll;
        // re-save the row WITHOUT the hash so the page still publishes rather
        // than 404-ing on its share link. The pre-write check + bounded re-roll
        // covers the common case; this only catches the rare simultaneous race.
        const msg = (err && err.message || '') + ' ' + (err && err.cause && err.cause.message || '');
        const dup = /E11000|duplicate key/i.test(msg);
        if (dup) {
          console.warn('[dedup] contentHash race on /p/' + shareSlug,
            '— re-saving without hash so the page still publishes:', err.message);
          try {
            await completePageRow({
              share_slug: shareSlug, event, body_html: finalBody || null,
              page_title: pageTitle, data: cachePayload,
              duration_ms: Date.now() - startedAt,
              verdict: wasRefusal ? accumulated.slice('REFUSED::'.length).trim().slice(0, 200) : null
            });
            completionOk = true;
          } catch (err2) {
            console.error('[CRITICAL] /p/' + shareSlug + ' — hash-less completion',
              'retry also failed:', err2 && err2.message);
          }
        } else {
          console.error('[CRITICAL] /p/' + shareSlug + ' — completion update',
            'failed; row will stay ai_generation_pending and /p/:slug will',
            '404 via the in-character page:', err.message);
        }
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
