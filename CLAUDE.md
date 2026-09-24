# ainetscape.com — CLAUDE.md

A faithful recreation of Netscape Composer (1997) with one anachronistic twist: an **AI Composer™** button that generates complete modern websites from a one-line prompt. Live at https://ainetscape.com. Solo-operated by Thomas Stringham (`tstringham` on GitHub, `webmaster@ainetscape.com` for in-character correspondence).

## The brand-voice rule — non-negotiable

**Never break the fourth wall in user-facing copy.** Every visible string speaks as a slightly menacing 1997 customer-service rep who has accidentally become powerful: confident, cold-corporate-cheerful, specific, never apologetic, never winks. No mention of "parody," "AI model," "Claude," "xAI," "2026," or any real provider name. Anachronism humor (1997 chrome × impossibly modern capability) is the product and is encouraged — but anywhere a year appears on a user-facing surface, it must read **1997** unless the line is deliberately about time travel ("1997 chrome. 2026 AI." in OG/Twitter cards is the one approved exception).

Apply the sniff test before shipping any copy: would a 1997 webmaster say this? If no, rewrite.

## The house bug: working and broken look identical

Nearly every "X is broken" report on this site has turned out to be something
**in front of** X, not X. The underlying system was fine; a cache, a cap, or an
editor mode made it look dead. Check the seam before the mechanism.

Confirmed instances, all real reports:

| Reported | Actually |
|---|---|
| Visitor counter reset to 1042 | Counter fine at 1898. `01042` is BOTH the markup placeholder and `HOMEPAGE_SEED`, so a failed fetch and a fresh DB render identically |
| Hit counter stuck at 2 | `recordHit()` deduped per IP per 24h; the loads were never counted |
| Gallery counts frozen | Gallery HTML cached 60s in browser AND edge |
| Thumbnail never generated | Rendered 3m17s after publish; the *pending* SVG was cached 10 min |
| Contact form dead | `designMode='on'` in the editor turns a submit click into a caret |
| Resend "must be unset" | It was set. A 4-day-old local `.env` pull was mistaken for production |

**Checks, in order:**

1. **Query the source of truth first.** Mongo, or the endpoint with `curl`. If
   the number is right there, the bug is in the display path.
2. **Read the `Cache-Control` on everything in the chain** — page, endpoint,
   *and image*. A `no-store` page can still show a cached image.
3. **Never cache a "not ready yet" answer** longer than the thing it waits for.
   Negative/pending responses get `no-store`; only the finished artifact gets a
   long TTL.
4. **Never diagnose config from a local `.env` pull.** It is a snapshot, not
   the deployment. Use `GET /api/admin/health` with `x-admin-token` — it
   reports presence and length for every env var, never a value.
5. **Test the surface the user is on.** Editor ≠ Preview ≠ published. Controls
   are inert in the editor by design (see below); Preview and `/p/<slug>` run
   them for real.

**When adding anything user-visible, make its failure distinguishable from its
success.** `/api/cta` returns 200 whether or not mail sends — deliberately, so
a visitor always gets their confirmation — which is exactly why submissions are
now persisted *before* delivery and the backlog is readable from
`/api/admin/health`. A silent failure you cannot query is a bug you will debug
twice.

### Editor vs Preview vs published

Generated pages mount in an iframe with `designMode='on'` so they can be
edited. That also means **clicking a button places a caret instead of firing
it** — forms and CTAs are inert in the editor, on purpose: a live submit would
mail the webmaster on every stray click while laying out a page. Clicking a
control sets a status-bar line saying so. **Preview** opens the document at a
`blob:` URL (not `document.write`, where `defer` scripts never run at all), so
`cta-dispatch.js` executes and controls work for real. That is the place to
test a form.

## Architecture in 60 seconds

Static homepage (`public/index.html`) ships the whole 1997 chrome + WYSIWYG editor (`document.execCommand`-based, ~3000 lines) as one HTML file. The **AI Composer** button POSTs to `/api/generate`, which streams a generated HTML document back. After streaming, the server post-processes images, persists the row, and the client mounts the result in a sandboxed iframe.

- **Compute**: Vercel serverless Node functions (every `api/*.js` is an endpoint; files prefixed `_` are NOT routed).
- **DB**: MongoDB Atlas — cluster `ainetscape-production`, db `ainetscape`. Collections: `generations` (pages), `siteStats` (homepage counter), `thumbnails` (PNGs, keyed by `_id` = slug — NOT a `slug` field), `submissions` (contact/CTA, stored before delivery), `premises`, `unsplashCache`. Two-stage write (placeholder → complete) gates the share link, see `api/_db.js`.
- **KV / rate-limit**: Upstash Redis (in-memory fallback for dev). All rate-limiters + the vote-dedup + the per-IP/day visit-counter dedup go through it.
- **AI providers** (multi-provider waterfall): **xAI Grok 4** primary (`api.x.ai/v1`, OpenAI-compatible), **Anthropic Claude Sonnet** as fallback. Gemini + OpenAI under evaluation. Free-token arbitrage is part of the rationale — never expose provider names in chrome.
- **Images**: Unsplash via `api/_unsplash.js` is the current shipping pipeline. The brief is moving to **Pexels primary / Unsplash failover** (see `feedback_*.md` / project memory) — neither cut over yet.
- **Thumbnails**: rendered by us, never a third party. `api/_render_thumb.js` drives
  headless Chromium **inside the Vercel function** (puppeteer-core + @sparticuz/chromium)
  on publish, stores the PNG in the `thumbnails` collection keyed by `_id` = slug (NOT a
  `slug` field — that mistake cost a session a wrong "no thumbnail" diagnosis), and
  `/api/thumb/<slug>` serves it. Backstop is **Vercel Cron every 5 minutes**
  (`api/cron/thumbnails.js`, `*/5 * * * *` in `vercel.json`), rendering only slugs with no
  PNG; `.github/workflows/thumbnails.yml` + `scripts/build_thumbs.mjs` remain a third leg.
  Publish → thumbnail is **~3 minutes**; hard cap 25s per render. Needs
  `GITHUB_DISPATCH_TOKEN` in Vercel (classic, `public_repo` — **verified sufficient 20
  September**, despite GitHub's docs naming `repo`) and `MONGODB_URI` as a GitHub Actions
  secret. This replaced api.microlink.io, a metered screenshot proxy whose free quota took
  out every gallery card AND every shared link's og:image at once.
  - Gallery cards point at `/images/gallery/<slug>.png` FIRST (a committed file that
    exists for almost nothing) and fall back to `/api/thumb/<slug>` via `onerror`.
    "Preview being developed" is the pending SVG — now `no-store`, because it was cached
    for 10 minutes against a 3-minute render and outlived the PNG it stood in for.
  - `putThumbnail()` clears `thumb_error`/`thumb_error_at`: a stored PNG proves the last
    attempt worked, and a stale failure marker sends the next person after a dead problem.
- **Cron**: weekly Site-of-the-Week picker (`api/cron/site-of-the-week.js`, schedule `0 0 * * 1` in `vercel.json`).
- **Email**: Resend, **live and verified 20 September 1997**. `RESEND_API_KEY` is set in
  Vercel Production and domain authentication is published in public DNS — SPF on the
  apex, DKIM at `resend._domainkey.ainetscape.com`, `send.ainetscape.com` with an
  Amazon SES MX for bounces, DMARC at `p=quarantine`. This line previously read "key in
  hand, DNS auth pending", which was wrong in both halves and cost a session an hour
  hunting a delivery fault that did not exist. `webmaster@ainetscape.com` is the only
  address ever exposed to users — never the real inbox. **Re-confirmed set 24 September**
  via `GET /api/admin/health`; a stale local `.env` pull once made it look unset and sent a
  session down a wrong path. Do not diagnose config from `.env.production.local`.
- **Contact forms**: every generated page's form is actionless; `public/cta-dispatch.js`
  (injected by `generate.js`, retrofitted at render by `api/page/[slug]/index.js`)
  intercepts the submit and POSTs to `/api/cta`, which mails
  **`webmaster@ainetscape.com`** for every page. `/api/cta` returns HTTP 200 whether or not
  the mail sends, so the visitor always gets their confirmation — which means **a working
  form and a broken one look identical from the outside.** Two places now say which:
  every submission is written to the `submissions` collection *before* delivery is
  attempted (with `delivered` / `delivery_error`), so a config gap is an outage and not
  data loss; and `GET /api/admin/health` reports the undelivered backlog. The function log
  still prints one of `RESEND_API_KEY not set`, `Resend rejected: <status>`,
  `Resend network failure`.

## Repo map

```
api/
  _db.js              Mongo singleton + ALL collection queries
  _shared.js          IP extraction, rate-limit (Upstash + in-mem fallback), Mongo write retry harness
  _unsplash.js        Image post-processor: [UNSPLASH:query] → real <figure>
  generate.js         POST /api/generate — streams xAI/Anthropic, post-processes, persists
  gallery.js          GET /gallery — server-rendered grid + sort + pagination
  vote.js             POST /api/vote — upvote with IP dedupe
  event.js            POST /api/event — telemetry beacon (cancel/timeout)
  site-stats/homepage.js  GET — homepage visit counter
  page/[slug]/        GET /p/[slug] (cached HTML) + /p/[slug]/stats (live counts)
  admin/edit-page.js  POST — ADMIN_EDIT_TOKEN-gated body_html overwrite (retrofit tool)
  admin/health.js     GET — is this actually configured? env presence + undelivered count
  cron/site-of-the-week.js  Weekly winner picker (Mon 00:00 UTC)

public/
  index.html          Homepage + WYSIWYG editor + all dialogs (~3000 lines)
  404.html            6 in-character 404 variants, random pick per load
  last-updated.js     Stamps "Last updated" + visit counter at load
  artifact-cluster.js Wiring for /p/[slug] engagement actions (vote/share/report/stats)
  share-dialog.js     Share-dialog module, shared with homepage Share toolbar
  {terms,privacy,copyright,faq}.html  GENERATED by build_pages.mjs — do not hand-edit
  images/             HAND-UPLOADED assets (not part of AI pipeline; see "Open questions" below)

scripts/
  build_pages.mjs     content/*.md → public/{slug}.html via scripts/templates/page.html
  build_lastupdated.mjs / build_ga.mjs / build_og.mjs   Run from `vercel-build` npm script
  update-page-body.mjs  CLI client for api/admin/edit-page (retrofit tool)

content/{terms,privacy,copyright,faq}.md   Sources of truth for the legal/FAQ pages
```

## How to run / deploy

- **No local dev server** is reliable for AI generation — the streaming + provider calls + Mongo all need prod env. Use `vercel --prod` to deploy.
- **Never** use the Vercel dashboard "Redeploy" button — Hobby plan blocks redeploys by a non-author git user. Always `vercel --prod` from CLI.
- Syntax-check before push: `node --check api/<file>.js`, parse `public/index.html` inline script with `new Function(...)` (see prior sessions for the one-liner).
- The four legal/FAQ pages are GENERATED — edit `content/*.md`, then re-run `node scripts/build_pages.mjs`.

## Things to never do

- Break the 4th wall in any user-facing surface (chrome, dialogs, generated-page badges, error pages, OG tags except the approved tagline).
- Expose Thomas's real inbox or any real email other than `webmaster@ainetscape.com` in repo, site, or copy.
- Push to `main` without explicit go-ahead — work goes on a WIP branch first.
- Skip `vercel --prod` and try the dashboard Redeploy button.
- Add backend-dependent UI (contact form POSTing somewhere) without confirming the backend is wired.
- Iterate expensively on AI-generation bugs — stop after 2 failed paid smoke tests and do a comprehensive failure analysis before the next change (Thomas's burn rate is real money).

## AI generation: notes for editing

- The system prompt lives in `api/generate.js` as `SYSTEM_PROMPT` (template literal — escape backticks inside it). It instructs the model to use `[UNSPLASH:query]` placeholders; the post-processor in `api/_unsplash.js` resolves them. **If you ever swap to Pexels-primary, you swap the placeholder syntax in this file AND build the matching resolver.** Don't half-cut.
- The two-stage write in `api/_db.js` (insertPagePlaceholder → completePageRow) is load-bearing: the share-slug HTTP header is only emitted after the placeholder write lands, which is how the recurring `/p/:slug` 404 was finally killed (commit `b50b9a7`). Don't break this contract.
- Per-IP daily caps: 40/day (gen), 400/day (vote), 3000/day (site-stats). Tune via the `rateLimit()` opts at each handler.
- `rateLimit()`'s `perHour` is a **global** ceiling across ALL callers, not per-IP. It belongs on `/api/generate`, where a call spends real money. It was copy-pasted onto four cheap endpoints where it could only ever turn a busy day into an outage; those now pass `skipGlobal: true` and gate the *write* while always serving the *read*. **Deny the write, never the read.** Before adding `perHour` anywhere, ask who pays when it fires: per-IP costs one caller, global costs every visitor.

## Open questions (not for Claude to decide)

- `public/images/{blon,lisa-penz}/` are hand-uploaded folders. Purpose unclear — possibly retrofit targets for the admin edit tool. Ask Thomas before touching.
- The Pexels migration (per brief) is planned but un-merged. See the WIP branch `wip/build-brief-2026-06-20` and project memory `project_ai_waterfall.md`.

## In-flight on `wip/build-brief-2026-06-20`

These pieces are merged on the WIP branch but await their counterpart UX/system-prompt work before they can flip to "live":

- **B2 Pexels pipeline** (`api/_pexels.js`, SYSTEM_PROMPT IMAGERY DIRECTIVE) — needs `PEXELS_API_KEY` env var set in Vercel before deploy. Unsplash post-processor retained for legacy `[UNSPLASH:...]` pages and as a one-line failover flip if Pexels rate-limits cascade.

- **B5 contact-form backend** (`api/contact-form.js`, `api/page/[slug]/set-contact-email.js`, `getContactRecipient`/`setContactRecipient` in `api/_db.js`) — ENDPOINTS ARE LIVE but currently unreachable from the flow because:
  1. SYSTEM_PROMPT still tells the model "use `mailto:` only — NOT a backend form." Flipping this to allow `<form action="/api/contact-form">` is the trigger.
  2. No client-side "Where should contact form submissions go?" dialog yet. Without it, `recipient_email` is never set and submissions return 409 ("not configured").
  3. Requires `RESEND_API_KEY` env var + completed DNS auth (SPF/DKIM for `webmaster@ainetscape.com` via Resend dashboard). **Both are done as of 20 September** — see the Email note above.
  Ship plan: build the recipient-email dialog → flip the SYSTEM_PROMPT → confirm DNS → deploy. All four steps need to land in the same release or the model will emit forms that 409 every submission.

- **A10 Spelling modal** — shipped. Typo.js + Hunspell en_US vendored to `public/spell/` (~600KB, served with 30-day immutable Cache-Control). Lazy-loaded on first Spelling open; subsequent opens hit the HTTP cache. `public/spell/spell-check.js` carries the modal logic; the modal HTML is `#dlg-spell` in `public/index.html`. Ignored words persist in `sessionStorage` ("Ignore All"); custom additions persist in `localStorage` ("Add to Dictionary"). Toolbar `case 'spell'` + Tools > Check Spelling… both route to `openSpellingDialog()`.

## Helpful prior sessions

Prior turn summaries + project notes live in `/Users/eljefe/.claude/projects/-Users-eljefe-Projects-ainetscape/memory/`. Read those before assuming anything about Thomas's preferences (terse output, parallel housekeeping streams, careful with expensive iteration, etc.).
