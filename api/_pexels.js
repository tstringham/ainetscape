// /api/_pexels.js
//
// Server-side post-processor for the Pexels image pipeline.
//
// The system prompt teaches the model to emit:
//   <img data-pexels="2-4 word photographic query" alt="..." width="..." height="...">
// This module:
//   1. Collects every unique data-pexels query from the page
//   2. Resolves each via the Pexels search API (per_page=15, orientation=landscape)
//   3. Picks a RANDOM photo from photos[] for that query — drives variety across
//      sites built from the same brief without paying for a cache
//   4. Rewrites each <img> with the chosen photo's src.large (or src.landscape
//      for hero-class queries), optionally tinting the background to avg_color
//      so the area doesn't flash white during image load
//   5. Removes the data-pexels attribute so the rendered page has no trace
//      of the placeholder
//
// Fallback chain:
//   Pexels result        → use it
//   503 / 429 (throttle) → RETRY with exponential backoff (most recover)
//   genuine miss/empty   → IN-CHARACTER 1997 placeholder (beveled "still loading
//                          over 28.8k" tile). NEVER a random photo — a random
//                          substitute was the old Picsum bug that put mismatched
//                          stock shots on pages.
//
// Throttle resilience: resolves at most PEXELS_CONCURRENCY queries at once (so a
// page's images don't burst the shared key into 503s) and caches SUCCESSFUL
// query→photo results for PEXELS_CACHE_TTL_MS on the warm instance to cut repeat
// calls. Misses are never cached, so a transient throttle can't stick a query to
// the placeholder. The random pick from the 15-result pool still drives variety.
//
// Attribution: per brief, "Photos via Pexels" lives in the Copyright footer
// page (already added to content/copyright.md). We don't clutter generated
// pages with inline photographer credits — Pexels' license is permissive.
//
// Files prefixed with "_" are not routed as endpoints by Vercel.

const PEXELS_API_BASE = 'https://api.pexels.com/v1';
const PEXELS_PER_PAGE = 15;        // pool size for random pick

// Throttle-resilience (fixes throttle-induced mismatched images): retry transient
// 503/429 before giving up, cap per-page concurrency so a page's images don't
// burst the shared key, and cache resolved queries briefly on the warm instance.
const PEXELS_MAX_RETRIES   = 3;               // extra attempts on 503/429
const PEXELS_RETRY_BASE_MS = 400;             // backoff: 400ms, 800ms, 1600ms
const PEXELS_CONCURRENCY   = 3;               // max simultaneous Pexels calls per page
const PEXELS_CACHE_TTL_MS  = 10 * 60 * 1000;  // per-query SUCCESS cache (warm instance)
const _pexelsCache = new Map();               // query -> { photo, at }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (attempt) => PEXELS_RETRY_BASE_MS * Math.pow(2, attempt);

// Run fn over items with at most `limit` in flight; preserves input order. A
// throwing fn degrades that slot to null (-> the in-character placeholder).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i]); } catch (_) { out[i] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}

// Structured placeholder: <img ... data-pexels="query" ...>.
// Captures pre-attrs, the quote character, the query, and post-attrs so we
// can preserve any width/height/class/style the model emitted alongside it.
const IMG_PEXELS_RE =
  /<img\s+([^>]*?)data-pexels=(["'])([^"']+)\2([^>]*?)\s*\/?>/gi;

// Belt-and-braces: bare [PEXELS:query] tokens that escaped the canonical
// pattern (CSS url(), JS-built img, srcset). Resolve to the bare image
// URL so the client never sees the raw placeholder string.
const BARE_PEXELS_RE = /\[PEXELS:([^\]]+)\]/g;

// Entry point. Returns the HTML with every placeholder replaced. Safe to
// call on HTML that contains no placeholders — short-circuits with zero I/O.
export async function postProcessPexels(html) {
  if (!html || (!html.includes('data-pexels=') && !html.includes('[PEXELS:'))) {
    return html;
  }

  const queries = new Set();
  for (const m of html.matchAll(IMG_PEXELS_RE))  queries.add(m[3].trim());
  for (const m of html.matchAll(BARE_PEXELS_RE)) queries.add(m[1].trim());
  if (queries.size === 0) return html;

  // Resolve with BOUNDED concurrency (was all-parallel) so a single page's images
  // don't burst the shared key into 503s. A failed query degrades to the
  // in-character placeholder; it never poisons the rest of the page.
  const queryList = [...queries];
  const results = await mapLimit(queryList, PEXELS_CONCURRENCY, resolveQuery);
  const photoByQuery = new Map();
  queryList.forEach((q, i) => photoByQuery.set(q, results[i]));

  // Pass 1: structured <img data-pexels="..."> → real <img> with preserved attrs.
  let out = html.replace(IMG_PEXELS_RE, (_match, pre, _quote, query, post) => {
    const q = query.trim();
    const photo = photoByQuery.get(q);
    const alt = extractAttr(pre + ' ' + post, 'alt') || q;

    if (!photo) return buildFallbackBlock(alt, q);

    // Reassemble surviving attrs from pre + post, dropping any stray data-pexels
    // (already consumed) and any src= the model accidentally emitted alongside it.
    const survivingAttrs = stripAttrs(pre + ' ' + post, ['data-pexels', 'src']).trim();
    const styleHint = photo.avgColor
      ? `style="background:${escapeAttr(photo.avgColor)};"`
      : '';
    return `<img src="${escapeAttr(photo.url)}" ` +
           (survivingAttrs ? survivingAttrs + ' ' : '') +
           `loading="lazy" ${styleHint}>`;
  });

  // Pass 2: bare [PEXELS:...] in attribute values, JS strings, CSS url().
  // Collapse to the chosen image URL (or a harmless '#' if no result).
  out = out.replace(BARE_PEXELS_RE, (_match, query) => {
    const q = query.trim();
    const photo = photoByQuery.get(q);
    return photo ? photo.url : '#';
  });

  return out;
}

// ============================================================
// Resolver — Pexels only. On a genuine miss (after retries) returns null and the
// caller renders an IN-CHARACTER period placeholder. It NEVER substitutes a
// random photo — that was the Picsum bug where a throttle miss became a
// mismatched modern stock shot.
// ============================================================
async function resolveQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) return null;

  // Warm-instance SUCCESS cache: skip the API for a repeat query (shaves calls
  // off the shared key). Misses are NOT cached, so a transient throttle can't
  // stick a query to the placeholder — the next attempt retries it fresh.
  const cached = _pexelsCache.get(query);
  if (cached && (Date.now() - cached.at) < PEXELS_CACHE_TTL_MS) return cached.photo;

  const pex = await fetchFromPexels(query);   // retries 503/429 internally
  if (pex) {
    _pexelsCache.set(query, { photo: pex, at: Date.now() });
    return pex;
  }
  return null;   // genuine miss -> caller renders the in-character placeholder
}

async function fetchFromPexels(query) {
  const key = process.env.PEXELS_API_KEY;
  if (!key) {
    // Surface the misconfig in logs so a missing-key incident is
    // diagnosable. Don't throw — just degrade to fallback.
    console.error('[pexels] PEXELS_API_KEY not set — primary disabled');
    return null;
  }

  const url = `${PEXELS_API_BASE}/search` +
    `?query=${encodeURIComponent(query)}` +
    `&per_page=${PEXELS_PER_PAGE}` +
    `&orientation=landscape`;

  // Retry transient throttles (503/429) with short exponential backoff before
  // giving up — the probe showed most throttle misses recover on retry, which
  // keeps the in-character placeholder rare.
  let resp = null;
  for (let attempt = 0; attempt <= PEXELS_MAX_RETRIES; attempt++) {
    try {
      // Pexels does NOT use the Bearer prefix — the key is the value verbatim.
      resp = await fetch(url, { headers: { 'Authorization': key } });
    } catch (err) {
      if (attempt < PEXELS_MAX_RETRIES) { await sleep(backoffMs(attempt)); continue; }
      console.error('[pexels] request failed for', JSON.stringify(query), '—', err && err.message);
      return null;
    }
    if (resp.status === 503 || resp.status === 429) {
      if (attempt < PEXELS_MAX_RETRIES) {
        const ra = Number(resp.headers.get('retry-after'));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 3000) : backoffMs(attempt));
        continue;
      }
      console.error('[pexels]', resp.status, 'after', PEXELS_MAX_RETRIES, 'retries; query=', JSON.stringify(query));
      return null;   // exhausted -> caller renders the in-character placeholder
    }
    break;   // 2xx or a non-retryable status — stop retrying
  }

  if (!resp || !resp.ok) {
    if (resp) console.error('[pexels] search returned', resp.status, 'for', JSON.stringify(query));
    return null;
  }

  let body;
  try { body = await resp.json(); } catch (_) { return null; }
  const photos = body && Array.isArray(body.photos) ? body.photos : [];
  if (photos.length === 0) return null;

  // Random pick from the pool — drives variety across sites that share a query.
  const photo = photos[Math.floor(Math.random() * photos.length)];

  // src.landscape is the 1200x627 hero-friendly crop, src.large is 940x650.
  // For card-sized inline images src.medium (~350x250) would be lighter but
  // browsers downscale large fine — keep one variant for simplicity until
  // someone files a perf complaint.
  const src = photo.src || {};
  const chosen = src.landscape || src.large || src.medium || src.original;
  if (!chosen) return null;

  return {
    url: chosen,
    avgColor: photo.avg_color || null,
    source: 'pexels'
  };
}

// ============================================================
// Helpers — local to this module, no shared escape utility yet.
// ============================================================
function extractAttr(attrStr, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = attrStr.match(re);
  return m ? m[1] : '';
}

// Removes the named attributes from an HTML attribute string. Used to drop
// data-pexels (already consumed) and any stray src= the model emitted
// alongside it, while keeping width/height/alt/class/style intact.
function stripAttrs(attrStr, names) {
  let out = attrStr;
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${name}\\s*=\\s*["'][^"']*["']`, 'gi'), '');
  }
  return out;
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }

// In-character placeholder shown when Pexels genuinely misses (after retries).
// A period beveled "broken image / still coming in over the modem" tile — an
// obvious 1997 chrome element, NEVER a random modern photo. This is the core
// fix: a miss must never become a mismatched stock shot.
function buildFallbackBlock(alt, query) {
  const caption = escapeHtml(String(alt || query || 'Image').slice(0, 60));
  const ariaLabel = escapeAttr(alt || query || 'image');
  return (
    `<figure class="pexels-image pexels-image--fallback" style="margin:0;">` +
      `<div role="img" aria-label="${ariaLabel}" style="` +
        `width:100%;max-width:600px;aspect-ratio:3/2;box-sizing:border-box;` +
        `background:#c0c0c0;border:2px solid;border-color:#808080 #ffffff #ffffff #808080;` +
        `display:flex;flex-direction:column;align-items:center;justify-content:center;` +
        `gap:9px;padding:14px;text-align:center;` +
        `font-family:'MS Sans Serif','Geneva','Tahoma',sans-serif;color:#000080;">` +
        // period broken-image glyph: framed picture (sun + hills) with a red X
        `<svg width="44" height="38" viewBox="0 0 44 38" aria-hidden="true" style="display:block;flex:none;">` +
          `<rect x="1" y="1" width="42" height="36" fill="#ffffff" stroke="#000000"/>` +
          `<circle cx="13" cy="12" r="3.5" fill="#ffd633" stroke="#000000"/>` +
          `<path d="M2 31 L15 19 L23 25 L32 16 L43 27" fill="none" stroke="#1a7a1a" stroke-width="1.5"/>` +
          `<path d="M4 5 L15 17 M15 5 L4 17" stroke="#cc0000" stroke-width="2.5"/>` +
        `</svg>` +
        `<div style="font-size:11px;font-weight:bold;">Image loading over 28.8 kbps&hellip;</div>` +
        `<div style="font-size:10px;color:#404040;max-width:92%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${caption}</div>` +
      `</div>` +
    `</figure>`
  );
}
