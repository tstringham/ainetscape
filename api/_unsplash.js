// /api/_unsplash.js
//
// Server-side post-processor for [UNSPLASH:query] placeholders emitted
// by the LLM. The model writes <img src="[UNSPLASH:wet vancouver street
// at night]" alt="..."> and this module turns each one into a real
// <figure> block with a hotlinked photo + UTM-tagged photographer credit.
//
// Compliance contract (Unsplash API guidelines, Production tier):
//   - Hotlink only via urls.regular (never download + rehost)
//   - Fire download_location tracking ping per photo use
//   - Per-photo attribution: "Photo by <name> on Unsplash" with UTM
//     params on both anchor hrefs
//   - Access key is server-side only (UNSPLASH_ACCESS_KEY env var)
//
// Files prefixed with "_" are not routed as endpoints by Vercel.

import crypto from 'crypto';

const UNSPLASH_API_BASE = 'https://api.unsplash.com';
const UTM_QS = '?utm_source=ainetscape&utm_medium=referral';

// Canonical form the prompt teaches the model. Captures pre-src attrs,
// the quote character, the query, and post-src attrs so we can extract
// alt text from either side of the src= attribute.
const IMG_PLACEHOLDER_RE =
  /<img\s+([^>]*?)src=(["'])\[UNSPLASH:([^\]"']+)\]\2([^>]*?)\s*\/?>/gi;

// Belt-and-braces: bare [UNSPLASH:...] tokens that escaped the canonical
// pattern (CSS url(), srcset, javascript-built img). We still resolve
// them to a real photo URL so the client never sees the raw placeholder.
const BARE_PLACEHOLDER_RE = /\[UNSPLASH:([^\]]+)\]/g;

// Entry point. Returns the HTML with every placeholder replaced. Safe
// to call on HTML with no placeholders — short-circuits without I/O.
export async function postProcessUnsplash(html) {
  if (!html || !html.includes('[UNSPLASH:')) return html;

  const queries = new Set();
  for (const m of html.matchAll(IMG_PLACEHOLDER_RE)) queries.add(m[3].trim());
  for (const m of html.matchAll(BARE_PLACEHOLDER_RE)) queries.add(m[1].trim());
  if (queries.size === 0) return html;

  const queryList = [...queries];
  const settled = await Promise.allSettled(queryList.map(resolveQuery));
  const photoByQuery = new Map();
  queryList.forEach((q, i) => {
    photoByQuery.set(q, settled[i].status === 'fulfilled' ? settled[i].value : null);
  });

  // Pass 1: structured <img> placeholders → <figure> + <figcaption>.
  let out = html.replace(IMG_PLACEHOLDER_RE, (_match, pre, _quote, query, post) => {
    const q = query.trim();
    const photo = photoByQuery.get(q);
    const alt = extractAttr(pre + ' ' + post, 'alt') || q;
    if (!photo) return buildFallbackBlock(alt, q);
    firePingTracker(photo.downloadLocation);
    return buildFigureBlock(photo, alt);
  });

  // Pass 2: bare placeholders in attribute values, JS strings, CSS url().
  // Collapse to the bare image URL (or a harmless '#' if no result).
  out = out.replace(BARE_PLACEHOLDER_RE, (_match, query) => {
    const q = query.trim();
    const photo = photoByQuery.get(q);
    if (!photo) return '#';
    firePingTracker(photo.downloadLocation);
    return photo.url;
  });

  return out;
}

// ---- helpers ----

function extractAttr(attrStr, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, 'i');
  const m = attrStr.match(re);
  return m ? m[1] : '';
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

function buildFigureBlock(photo, alt) {
  const safeAlt  = escapeAttr(alt);
  const safeName = escapeHtml(photo.photographerName);
  const profile  = escapeAttr(photo.photographerProfile + UTM_QS);
  const imgUrl   = escapeAttr(photo.url);
  // Styles inlined: the generated page's <style> block can name-collide
  // with anything we put in a stylesheet, so we keep attribution layout
  // robust by living entirely on the elements themselves.
  return (
    `<figure class="unsplash-image" style="margin:0;">` +
      `<img src="${imgUrl}" alt="${safeAlt}" loading="lazy" ` +
        `style="display:block;max-width:100%;height:auto;">` +
      `<figcaption style="font-size:11px;font-style:italic;color:#555;` +
        `margin-top:6px;font-family:Georgia,serif;">` +
        `Photo by <a href="${profile}" target="_blank" rel="noopener" ` +
          `style="color:inherit;text-decoration:underline;">${safeName}</a> ` +
        `on <a href="https://unsplash.com/${UTM_QS}" target="_blank" rel="noopener" ` +
          `style="color:inherit;text-decoration:underline;">Unsplash</a>` +
      `</figcaption>` +
    `</figure>`
  );
}

// Deterministic gradient from a hash of the query, so the same missing
// query always renders the same fallback block. Keeps the empty state
// feeling intentional rather than randomised.
function buildFallbackBlock(alt, query) {
  const hash = crypto.createHash('sha256').update(String(query || alt || '')).digest();
  const hue = Math.floor(hash[0] * 360 / 256);
  const hue2 = (hue + 40) % 360;
  const label = escapeHtml(alt || query || '');
  const ariaLabel = escapeAttr(alt || query || 'image');
  return (
    `<figure class="unsplash-image unsplash-image--fallback" style="margin:0;">` +
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

async function resolveQuery(rawQuery) {
  const query = String(rawQuery || '').trim().toLowerCase();
  if (!query) return null;
  const key = sha256Hex(query);

  // Mongo cache — 24h TTL on the cachedAt field via index in _db.js.
  try {
    const { getUnsplashCacheEntry } = await import('./_db.js');
    const cached = await getUnsplashCacheEntry(key);
    if (cached) return cached;
  } catch (err) {
    console.error('[unsplash] cache read failed; falling through to API:',
      err && err.message);
  }

  const fresh = await fetchFromUnsplash(query);
  if (!fresh) return null;

  // Best-effort write — a cache miss that fails to write is still served
  // to the client; the next request just re-pays the API call.
  try {
    const { putUnsplashCacheEntry } = await import('./_db.js');
    await putUnsplashCacheEntry(key, fresh);
  } catch (err) {
    console.error('[unsplash] cache write failed (ignored):',
      err && err.message);
  }
  return fresh;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

async function fetchFromUnsplash(query) {
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) {
    console.error('[unsplash] UNSPLASH_ACCESS_KEY not set — substitution disabled');
    return null;
  }
  const url = `${UNSPLASH_API_BASE}/search/photos` +
    `?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        'Authorization': `Client-ID ${key}`,
        'Accept-Version': 'v1'
      }
    });
  } catch (err) {
    console.error('[unsplash] search request failed for',
      JSON.stringify(query), '— err:', err && err.message);
    return null;
  }
  if (!resp.ok) {
    console.error('[unsplash] search returned', resp.status, 'for', JSON.stringify(query));
    return null;
  }
  let body;
  try { body = await resp.json(); } catch (_) { return null; }
  const photo = body && body.results && body.results[0];
  if (!photo) return null;

  return {
    url: (photo.urls && photo.urls.regular) || null,
    photographerName: (photo.user && photo.user.name) || 'Unsplash photographer',
    photographerProfile: (photo.user && photo.user.links && photo.user.links.html)
      || 'https://unsplash.com',
    photoId: photo.id || null,
    downloadLocation: (photo.links && photo.links.download_location) || null
  };
}

// Required by Unsplash API guidelines — without these pings, photographers
// can't see their usage stats and the app gets rejected for Production
// tier. Fire-and-forget: latency on the user's request matters more than
// confirming the ping landed.
function firePingTracker(downloadLocation) {
  if (!downloadLocation) return;
  const key = process.env.UNSPLASH_ACCESS_KEY;
  if (!key) return;
  fetch(downloadLocation, {
    headers: { 'Authorization': `Client-ID ${key}` }
  }).catch(err => {
    console.error('[unsplash] download tracking ping failed (ignored):',
      err && err.message);
  });
}
