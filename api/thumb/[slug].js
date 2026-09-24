// /api/thumb/[slug].js
//
// GET /api/thumb/<slug> — the page's preview image, rendered by us and served
// from our own database.
//
// This replaces api.microlink.io, which was called fresh by the gallery (two
// call sites) and by every page's og:image and twitter:image. That service is
// a third-party screenshot proxy on a free daily quota; when the quota ran out
// on 20 September the gallery filled with "Preview unavailable" AND every
// shared link lost its social card, at the same moment, from one cause nobody
// could see from inside the site.
//
// Two responses, and the distinction is the point:
//
//   - A stored PNG, served immutable. A page's appearance does not change
//     after it is generated, so the cache lifetime is a year and the URL never
//     needs a buster.
//   - A placeholder SVG when no render exists yet, served with a SHORT cache so
//     the real thumbnail replaces it as soon as one is made. Rendering one here
//     on demand would mean a headless browser inside a request a visitor is
//     waiting on, twelve at a time when the gallery loads.
//
// The placeholder is drawn rather than fetched: no browser, no network, no
// dependency, and it cannot itself fail.

import { getThumbnail } from '../_db.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

// A year. Immutable because a generated page is fixed at publish: nothing
// edits body_html afterwards except the admin retrofit tool, and that is rare
// enough to be worth a manual re-render rather than a shorter cache on
// every card in the gallery for ever.
const STORED_CACHE = 'public, max-age=31536000, immutable';

// no-store. This is the "not ready yet" answer, and a not-ready answer must
// never outlive the thing it is standing in for.
//
// It was `public, max-age=600` with the reasoning "short enough that a page
// which gets its render five minutes from now stops showing this" — but the
// render lands about three minutes after publish, so ten minutes was longer
// than the wait it was meant to cover. A visitor who opened the gallery in
// that window cached the placeholder and kept seeing "Preview being
// developed" for ten more minutes after the real PNG existed. The thumbnail
// pipeline was working; the card was showing a stale answer about it.
//
// Caching belongs on the stored PNG (STORED_CACHE, a year, immutable) — that
// one never changes. This one changes the moment the render lands, which is
// exactly why it cannot be cached. Serving it costs one indexed findOne.
const PLACEHOLDER_CACHE = 'no-store';

/**
 * The stand-in, in the house style.
 *
 * Netscape-grey plate, inset Motif border, and a line a 1997 webmaster would
 * actually write. Deterministic: no timestamps, no randomness, so a CDN and a
 * browser cache never disagree about what this is.
 */
function placeholderSvg(width, height) {
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + width + '" height="' + height + '" ' +
    'viewBox="0 0 ' + width + ' ' + height + '" role="img" aria-label="Preview being developed">' +
    '<rect width="100%" height="100%" fill="#c0c0c0"/>' +
    // Motif inset: light top/left, dark bottom/right. Same 1px chrome the
    // editor window uses, so the empty card still belongs to the product.
    '<path d="M0 0h' + width + 'v2H0z" fill="#808080"/>' +
    '<path d="M0 0h2v' + height + 'H0z" fill="#808080"/>' +
    '<path d="M0 ' + (height - 2) + 'h' + width + 'v2H0z" fill="#ffffff"/>' +
    '<path d="M' + (width - 2) + ' 0h2v' + height + 'h-2z" fill="#ffffff"/>' +
    '<rect x="16" y="16" width="' + (width - 32) + '" height="' + (height - 32) + '" ' +
      'fill="none" stroke="#9a9a9a" stroke-width="1" stroke-dasharray="4 4"/>' +
    '<text x="50%" y="48%" text-anchor="middle" ' +
      'font-family="Georgia, \'Times New Roman\', serif" font-size="' + Math.round(height / 14) + '" ' +
      'fill="#000000">Preview being developed</text>' +
    '<text x="50%" y="60%" text-anchor="middle" ' +
      'font-family="Georgia, \'Times New Roman\', serif" font-size="' + Math.round(height / 22) + '" ' +
      'fill="#404040">Check back shortly.</text>' +
    '</svg>';
}

function sendPlaceholder(res, width, height) {
  res.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
  res.setHeader('Cache-Control', PLACEHOLDER_CACHE);
  // Tells a caller this is the stand-in without making them parse the body.
  res.setHeader('X-Thumb-State', 'pending');
  return res.status(200).send(placeholderSvg(width, height));
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // 3:2, matching the gallery card and the old Microlink viewport, so swapping
  // the source does not reflow a single row.
  const width = 1200;
  const height = 800;

  const slug = String((req.query && req.query.slug) || '').trim();
  if (!VALID_SLUG.test(slug)) return sendPlaceholder(res, width, height);

  let row = null;
  try {
    row = await getThumbnail(slug);
  } catch (err) {
    // A database that is down must not take the gallery's images with it. The
    // placeholder is a correct answer to "we have no bytes for you", whatever
    // the reason, and this is the one path where being quiet is right.
    console.error('[thumb] lookup failed for', slug, err && err.message);
    return sendPlaceholder(res, width, height);
  }

  if (!row || !row.png) return sendPlaceholder(res, width, height);

  // The driver hands back BSON Binary; `.buffer` is the Node Buffer under it.
  const png = row.png.buffer ? Buffer.from(row.png.buffer) : Buffer.from(row.png);

  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', STORED_CACHE);
  res.setHeader('Content-Length', String(png.length));
  res.setHeader('X-Thumb-State', 'stored');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(png);
}
