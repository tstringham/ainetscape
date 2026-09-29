# HTML entities render literally in site titles

**Branch:** `fix/title-entity-decoding` (from `main` @ `9c06505`, clean tree, nothing unpushed)
**Reported:** gallery card reads `BEAD &amp; BONE — The Unauthorised History`

---

## 1. Diagnosis

### The code path

`api/generate.js:496-500`, at the end of a completed generation:

```js
let pageTitle = null;
if (event === 'ai_generation_completed') {
  const m = /<title>([\s\S]*?)<\/title>/i.exec(finalBody || '');
  if (m) pageTitle = m[1].trim().slice(0, 200);
}
```

The model emits valid HTML, so an ampersand inside `<title>` is correctly
written as `&amp;`. This regex lifts the **raw source text** of the element,
not its rendered value, so the entity is stored verbatim. `page_title` is
therefore HTML-encoded in the database while every consumer treats it as plain
text — and then escapes it again on output, so `&amp;` is displayed as the
five literal characters `&amp;`.

The second capture point, `api/admin/edit-page.js` → `updatePageBody()`, takes
`page_title` straight from the request body with the same assumption.

### Confirmed against production

```
rows whose stored page_title contains an entity: 2   (of 180 titled rows)
  qlR3e6NvtJ   pub=true   "Silk &amp; Shadow"
  SHWWAHwUqN   pub=true   "BEAD &amp; BONE — The Unauthorised History"
entities present: { "&amp;": 2 }
```

Both are public. Only `&amp;` occurs today, but the fix must handle named,
decimal and hex forms because the model can emit any of them.

---

## 2. Every surface that displays a title

| # | Surface | Location | Fix |
|---|---|---|---|
| 1 | **Capture** — `<title>` extraction | `api/generate.js:496` | decode at capture |
| 2 | **Capture** — operator retrofit | `api/admin/edit-page.js` → `_db.js:updatePageBody` | decode at capture |
| 3 | **Gallery card** (Recent / Week / All Time — one renderer) | `api/gallery.js:230` | decode at display |
| 4 | **Site of the Week** box | `api/gallery.js:163` | decode at display |
| 5 | **/p/:id wrapper `<title>`** | `api/page/[slug]/index.js:118` → `_chrome.js:79` | decode, escape once |
| 6 | **og:title / twitter:title** | `api/page/[slug]/index.js:159,165` | decode, escape once |
| 7 | **iframe `title=` (a11y)** | `api/page/[slug]/index.js:179` | decode, escape once |
| 8 | **Status bar** `Document: <title>` | `api/page/[slug]/index.js:199` | decode, escape once |
| 9 | **meta description fallback** | `api/_indexable.js:buildDescription(html, pageTitle)` | decoded input |
| 10 | **Contact-form email** subject + body | `api/contact-form.js:108,118,136` | decode at display |
| 11 | **Editor `<title>` extraction** (File > Open) | `public/index.html:1932` | decode client-side |
| 12 | **Admin gallery JSON** | `api/admin/gallery.js` | decoded at source (3/4 share `_db.js`) |

Not affected: `api/sitemap.xml.js` (no titles), `public/share-dialog.js`
(reads `document.title`, which the browser has already decoded).

---

## 3. Fix

One shared helper, `api/_title.js`, exporting `cleanTitle()`.

**Order is strip-then-decode, and it matters.** Tags are removed from the raw
input first, then entities are decoded. Doing it the other way round would turn
`&lt;script&gt;` into a real `<script>` tag and then delete it, losing the text.
This way it survives as the literal characters `<script>`, and output escaping
turns it back into `&lt;script&gt;` in the HTML — visible, inert.

**Single-pass decode, deliberately.** `&amp;amp;` decodes to `&amp;`, not `&`.
Decoding repeatedly would corrupt a title that legitimately contains the text
`&amp;`, and would re-introduce the possibility of manufacturing a `<` from
`&amp;lt;`. One pass is also what makes the helper idempotent-safe in practice:
a clean title containing a bare `&` has nothing matching the entity pattern and
comes back untouched.

**Applied at capture and at display.** Capture fixes new records; display fixes
the two existing ones with no migration required. Both call the same function.

**Output is always text.** No `innerHTML`, no `dangerouslySetInnerHTML`. Where a
title enters server-built HTML it is escaped exactly once, by the existing
`escapeHtml` / `escapeAttr` in `_chrome.js`.

---

## 4. Backfill

`scripts/backfill_titles.mjs` — **written, not run.**

Dry-run by default: prints `before` / `after` for every affected row plus a
count, and changes nothing. Requires an explicit `--apply` to write, and even
then only touches rows whose decoded title differs from the stored one.

---

## 5. Tests

`tests/title.test.mjs`, run with `node --test`:

- `&amp;` → `&`
- `&#39;` → `'`
- `&#x27;` → `'`
- `&quot;` → `"`
- `&lt;script&gt;` → literal `<script>` (and confirmed inert once escaped)
- `&amp;amp;` → `&amp;` (single pass)
- clean title with a raw em dash → unchanged
- idempotence: `cleanTitle(cleanTitle(x)) === cleanTitle(x)` across all cases

---

## 6. Verification

On the Vercel preview, using `SHWWAHwUqN` (`BEAD &amp; BONE`):
gallery card, `/p/:id` tab title, and `og:title` must all show a plain `&`.
Branch pushed; **not deployed**.

---

# IMPLEMENTATION NOTES — what changed from the plan

Two things the tests forced, both worth recording.

## The helper had to split in two

The plan called for one `cleanTitle()` applied at capture and at display. The
idempotence test failed on `&lt;script&gt;`:

```
cleanTitle('&lt;script&gt;')  ->  '<script>'     correct, literal text
cleanTitle('<script>')        ->  ''             second pass sees real markup
```

Since display-time cleaning runs on titles capture already cleaned, that is a
live data-loss path. Stripping at display is also unnecessary: of 180 stored
titles, **zero** contain `<`, and one is `RACHEL > MONICA • 1997` — a reminder
that angle brackets belong in real titles and that output escaping, not
deletion, is what makes them safe.

So: **`cleanTitle()` strips and decodes (capture); `displayTitle()` only
decodes (display).**

## Known limit: nested encoding decodes twice

A browser renders `<title>A &amp;amp; B</title>` as `A &amp; B`, so the correct
plain text keeps one level of encoding. Capture gets that right. But display
decodes what capture stored and cannot distinguish a legacy raw entity from a
legitimately-stored one, so the pair yields `A & B`.

Accepted deliberately. Fixing it needs a per-row "already cleaned" flag threaded
through every projection and every surface, to correct a case that requires the
model to emit a double-encoded entity inside a `<title>`. Zero of 180 stored
titles do. Covered by an explicit test named `KNOWN LIMIT` so the next person
finds the decision rather than the surprise.

---

# RESULTS

**Tests:** 17/17 pass (`node --test tests/title.test.mjs`).

**Before and after**, same record, `SHWWAHwUqN`:

| | source | rendered |
|---|---|---|
| production (old) | `BEAD &amp;amp; BONE` | `BEAD &amp; BONE` |
| this branch | `BEAD &amp; BONE` | `BEAD & BONE` |

Escaped exactly once, and verified in WebKit rather than by reading the source
— `document.title`, `og:title` and the gallery card all return a plain `&`.

**Backfill dry run** (`scripts/backfill_titles.mjs`, nothing written):

```
DRY RUN — scanned 180 titled rows
  qlR3e6NvtJ   "Silk &amp; Shadow"                        -> "Silk & Shadow"
  SHWWAHwUqN   "BEAD &amp; BONE — The Unauthorised..."    -> "BEAD & BONE — ..."
2 rows would change.
```

**Not done:** not deployed, backfill not run.
