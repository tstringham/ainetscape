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
// Fallback chain (per brief):
//   Pexels result   → use it
//   429 / empty     → Lorem Picsum (https://picsum.photos/seed/{q}/{w}/{h})
//   Picsum unusable → in-character text placeholder block
//
// No cache by design — pooled random-pick is what produces variety across
// sites. If Pexels ever returns near-identical top sets per query (variety
// fails the smoke test), the brief reserves the right to reinstate a
// per-query pool cache (~24h, still random-pick per site). The code below
// is shaped so wrapping resolveQuery() in a cache helper is a 5-line edit.
//
// Attribution: per brief, "Photos via Pexels" lives in the Copyright footer
// page (already added to content/copyright.md). We don't clutter generated
// pages with inline photographer credits — Pexels' license is permissive.
//
// Files prefixed with "_" are not routed as endpoints by Vercel.

import crypto from 'crypto';

const PEXELS_API_BASE = 'https://api.pexels.com/v1';
const PEXELS_PER_PAGE = 15;        // pool size for random pick
const PICSUM_W = 1200;             // default fallback image dimensions
const PICSUM_H = 800;

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

  // Parallel resolve. Individual failures degrade to per-query fallbacks;
  // a single bad query never poisons the rest of the page.
  const queryList = [...queries];
  const settled = await Promise.allSettled(queryList.map(resolveQuery));
  const photoByQuery = new Map();
  queryList.forEach((q, i) => {
    photoByQuery.set(q, settled[i].status === 'fulfilled' ? settled[i].value : null);
  });

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
// Resolver — Pexels primary, Picsum fallback, null on total miss.
// ============================================================
async function resolveQuery(rawQuery) {
  const query = String(rawQuery || '').trim();
  if (!query) return null;

  // Pexels primary.
  const pex = await fetchFromPexels(query);
  if (pex) return pex;

  // Picsum fallback — seeded by a stable hash of the query so the same
  // missed query always falls back to the same Picsum photo (helps with
  // re-generation idempotency and OG-card consistency).
  const seed = sha256Hex(query).slice(0, 10);
  return {
    url: `https://picsum.photos/seed/${seed}/${PICSUM_W}/${PICSUM_H}`,
    avgColor: null,
    source: 'picsum'
  };
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

  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        // Pexels does NOT use the Bearer prefix — the key is the value verbatim.
        'Authorization': key
      }
    });
  } catch (err) {
    console.error('[pexels] search request failed for',
      JSON.stringify(query), '— err:', err && err.message);
    return null;
  }

  if (resp.status === 429) {
    // Rate-limited. Logged so we can correlate against traffic spikes
    // and trip the Unsplash-primary failover at the right moment.
    const retryAfter = resp.headers.get('retry-after');
    console.error('[pexels] 429 rate-limited; query=', JSON.stringify(query),
      'retry-after=', retryAfter);
    return null;
  }
  if (!resp.ok) {
    console.error('[pexels] search returned', resp.status, 'for', JSON.stringify(query));
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
function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

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

// In-character fallback for the rare case where both Pexels AND Picsum fail.
// Deterministic gradient from the query hash so the empty state reads as
// "intentional placeholder" rather than randomised glitch.
function buildFallbackBlock(alt, query) {
  const hash = crypto.createHash('sha256').update(String(query || alt || '')).digest();
  const hue  = Math.floor(hash[0] * 360 / 256);
  const hue2 = (hue + 40) % 360;
  const label = escapeHtml(alt || query || '');
  const ariaLabel = escapeAttr(alt || query || 'image');
  return (
    `<figure class="pexels-image pexels-image--fallback" style="margin:0;">` +
      `<div role="img" aria-label="${ariaLabel}" ` +
        `style="width:100%;max-width:600px;aspect-ratio:3/2;` +
              `background:linear-gradient(135deg,hsl(${hue},45%,55%),hsl(${hue2},45%,40%));` +
              `display:flex;align-items:center;justify-content:center;` +
              `color:#fff;font-family:Georgia,serif;font-style:italic;` +
              `padding:1em;text-align:center;box-sizing:border-box;">` +
        `${label}` +
      `</div>` +
    `</figure>`
  );
}
