# Mobile layout bug in AI Composer output

**Branch:** `fix/mobile-responsive-composer` (from `main` @ `fe1e1bc`, clean tree)
**Status:** Step 1 complete — diagnosis only. No fix applied.
**Repro case:** `/p/jaGCbbjgv3` — "I'll Be Missing You"

---

## 1. Measurements

WebKit (Playwright, iPhone 13 profile) — the engine that matters, since the report
is iOS Safari. Installed for this work; Chromium alone would not be evidence.

| surface @ 375px | clientWidth | scrollWidth | overflow |
|---|---|---|---|
| `/p/jaGCbbjgv3/raw` standalone | 375 | **1124** | 749px |
| `/p/jaGCbbjgv3` outer page | 375 | 375 | **0** |
| `/p/jaGCbbjgv3` inner doc | 351 | **1124** | 773px |

The document overflows by ~750px **on its own**, before any host is involved.

---

## 2. Root cause

A single declaration inflates the whole document. The chain, measured:

```
div.timeline             min-width: 1100px          <- ORIGIN
  parent: div.timeline-container   max-width:1100px; overflow-x:auto   -> rendered 1100px
    parent: div.hero-content       min-width: auto  <- FLEX ITEM, cannot shrink
      parent: header.hero          display:flex; flex-wrap:nowrap; width 375; scrollWidth 1124
        parent: body               overflow-x: hidden
```

`.hero-content` is a flex item of `header.hero`. Flex items default to
`min-width: auto`, so they cannot shrink below their min-content contribution.
The timeline's `min-width: 1100px` propagates up through `.timeline-container`
(its `overflow-x:auto` does **not** isolate it in this nesting) and pins
`.hero-content` at 1100px.

Everything inside then obeys that 1100px parent:

- `h1` and `.hero-subtitle` render 1100px wide and are centered in a 1100px box
  inside a 375px viewport -> **hero clipped on the right**.
- `.timeline` sits at 1100px, centered -> **timeline clipped on the left**.
- `body { overflow-x: hidden }` clips rather than scrolls -> **no scroll**.

All three reported symptoms come from one rule plus one flex default.

### Secondary contributors

| rule | effect |
|---|---|
| `.hero h1 { font-size: clamp(3.2rem, 8vw, 6.5rem) }` | At 375px, `8vw`=30px so the **floor** 3.2rem (51.2px) wins. "MISSING YOU" ~349px vs ~342px available. Would clip even with the timeline fixed. |
| `.nav-inner { display:flex; gap:2rem }` | No `flex-wrap`. Sticky nav, independent overflow source. |
| `.hero { display:flex }` | No `flex-wrap`, and the reason `.hero-content` gets `min-width:auto`. |
| `body { overflow-x:hidden }` (not `html`) | Turns overflow into a clip with no scroll — the "does not scroll" half of the report. |

### Ruled out

- **Viewport meta** — present and correct: `width=device-width, initial-scale=1.0`.
- **`white-space: nowrap`** — zero occurrences.
- **Fixed-px widths** — none. The four `1100px` values are all `max-width`
  (an earlier regex pass misread them as `width`; corrected by dumping computed style).
- **Fixed-px grid columns** — none. Templates are `1fr 1fr` and
  `repeat(auto-fit, minmax(280px,1fr))`, both fluid.
- **`100vw`** — not used. The only `vw` is inside the hero `clamp()`.
- **`box-sizing`** — already `border-box` globally.
- **letter-spacing** — present (`-0.04em` on h1) but not a material contributor.

The page *does* ship `@media (max-width: 768px)`, containing exactly one rule:
`.grid { grid-template-columns: 1fr }`. The model wrote a breakpoint and then
used it for almost nothing — it never touches `.timeline`, `.hero h1` or `.nav-inner`.

---

## 3. Host analysis — NOT the cause

Both surfaces wrap the document in an iframe:

| surface | markup | CSS |
|---|---|---|
| `/p/<slug>` | `<iframe class="page-frame" src="/p/<slug>/raw" sandbox=...>` | `.page-frame { width:100%; height:100%; border:0; display:block }` |
| editor canvas | `<iframe class="editor-iframe" srcdoc=... sandbox="allow-scripts allow-same-origin">` + `designMode='on'` | `.editor-iframe { width:100%; height:100% }` |

**The iOS iframe auto-expansion hypothesis is wrong here — measured, not assumed.**
On `/p/` at 375px the iframe computes to `351px` and the outer page has zero
overflow. Neither iframe uses the `width:1px; min-width:100%` workaround, and
neither needs it: the host is correctly constraining the frame. The document
overflows *inside* a correctly-sized container.

Consequence for the fix: **a host-side container change would fix nothing.** The
guard has to act on the document.

---

## 4. Plan

### 4A. Render-time guard

Two injection seams, both already exist and already inject CSS:

1. **`prepareDocument()`** — `api/page/[slug]/index.js:280`, called by
   `api/page/[slug]/raw.js:63`. Serve-time, so it covers **every already-published
   page with no regeneration**. Today it injects
   `img,svg,video,canvas{max-width:100%!important;height:auto}` — the guard extends this.
2. **`generate.js:431`** — beside `injectCtaDispatch(finalBody, shareSlug)`. Covers
   the streamed document the **editor canvas** mounts, and what gets stored.

Shared helper `api/_responsive_guard.js`, mirroring `injectCtaDispatch`'s shape
(never throws; a failed inject ships the page unchanged).

Contents:

- viewport meta if absent (present on this page; not universal)
- `html, body { max-width:100%; overflow-x:hidden }` — note `html` too, since this
  page sets it on `body` alone
- `box-sizing: border-box`
- `img, video, iframe, table, svg, canvas { max-width: 100% }`
- `overflow-wrap` on headings and text blocks
- `@media (max-width: 600px)`: stack flex/grid rows, neutralise oversized
  `min-width`, clamp display type

**The mobile block must include `min-width: 0` on flex/grid children and
`flex-wrap: wrap` on flex containers**, or it will not fix this page. `min-width:0`
alone is insufficient: `.timeline-event` is `flex:1; min-width:180px`, so six of
them in a nowrap row still total ~1080px. Both rules are required.

### 4B. Generation directive

**Discrepancy with the brief:** there is no MongoDB-driven prompt config.
`SYSTEM_PROMPT` is a template literal at `api/generate.js:74`. The `settings`
collection is Mongo-driven but holds only `aiWaterfall` (`_db.js:584-605`).

Options:
- **(a) Edit `SYSTEM_PROMPT` in `generate.js`** — recommended. The directive lives
  with the prompt it modifies, is version-controlled and reviewable in the diff.
- **(b) Build Mongo-backed prompt overrides** — matches the brief's stated intent
  and allows prompt edits without a deploy, but it is a new feature with real risk:
  an unreviewed row silently changing every generation.

Proceeding on (a) unless told otherwise. Directive to be scoped as a hard
constraint on layout only, so it does not undercut the existing "expand"/ambition
directives: reflow to 360px, no fixed-px container wider than the viewport, flex and
grid rows wrap or stack under 600px, display type uses `clamp()` with a floor that
fits 360px, no `nowrap` on headlines.

### Desktop-regression risks to watch

- `height:auto` on `iframe`/`canvas` can collapse elements with no intrinsic
  ratio. Current injected rule already applies it to `canvas`; the guard will
  **not** widen `height:auto` beyond `img`/`video`.
- `overflow-wrap: anywhere` changes min-content sizing and can force ugly
  mid-word breaks. Plan: `break-word` globally, `anywhere` only inside the
  mobile block.
- Everything else is scoped to `@media (max-width: 600px)`, so desktop is
  untouched by construction — to be confirmed empirically at 1280px.

---

## 5. Verification plan

At **375px** and **1280px**, in WebKit, on **`/raw`**, **`/p/`** and the **editor
canvas**: `jaGCbbjgv3`, TAMAGOTCHI SHRINE, Silicon Singles, NEURAL SYNTH,
Catalogue of Cats, LANDSCAPE FORGE.

Pass = `scrollWidth <= clientWidth + 2` at 375px, and at 1280px a
`scrollWidth`/offender set **identical to the pre-fix baseline** (recorded before
any change, so desktop no-op is proven against numbers rather than asserted).

Branch pushed for a Vercel **preview** only. No production deploy.
