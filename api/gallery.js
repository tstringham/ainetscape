// /api/gallery.js
//
// Server-rendered AI Composer Gallery. Reads from Mongo at request time,
// returns full HTML inside the AI Netscape chrome. Edge-cached for 60s so
// burst traffic doesn't hammer Atlas.
//
// vercel.json rewrites /gallery → /api/gallery, so /gallery?page=2&sort=upvotes
// arrives here with req.query populated.
//
// Phase 2 of the gallery build (per CLAUDE_CODE_GALLERY_PROMPT.md):
//   - 3-col × variable rows, max 800px, cards ~240px × 3:2 thumb + meta
//   - Tablet 2-col, mobile 1-col
//   - 24 per page, numbered pagination with Previous / Next
//   - Two sort modes: Recent (default) / Upvotes
//   - Status bar reads "Document: AI Composer Gallery"
//   - Briefs are NEVER shown — title / upvotes / hits / date only
//   - Date displayed as "May DD, 1997" (always 1997 per the conceit)
//
// Site of the Week feature box, Upvote / Hit / Report UI all live in
// later phases (4 / 3 / 6 / 7). This file shows the grid; the action
// cluster gets added in phase 7.
//
// Thumbnails: Phase 2 stand-in uses the Microlink screenshot proxy
// pointed at /p/<slug> (same approach as the OG card in
// api/page/[slug].js). Phase 4-ish: real thumbnails via client-side
// html2canvas at share time, uploaded to Vercel Blob, URL stored in
// the `thumbnail_url` field.

import { renderChrome, escapeHtml, escapeAttr } from './_chrome.js';

const PAGE_SIZE = 24;
const SITE_ORIGIN = 'https://ainetscape.com';

const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed.');
  }

  if (!process.env.MONGODB_URI) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send(serviceUnavailableHtml());
  }

  // Coerce query inputs. Sort defaults to recent. Page clamps to ≥ 1.
  // Three sort modes are supported; legacy ?sort=upvotes maps onto 'all'
  // so old shared URLs keep resolving.
  const rawSort = String(req.query.sort || '').toLowerCase();
  let sort = 'recent';
  if (rawSort === 'week') sort = 'week';
  else if (rawSort === 'all' || rawSort === 'upvotes') sort = 'all';
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, 10000);     // sanity cap

  try {
    const {
      findGalleryPages, countGalleryPages, findCurrentSiteOfTheWeek
    } = await import('./_db.js');
    const [pages, total, sotw] = await Promise.all([
      findGalleryPages({ sort, skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
      // countGalleryPages needs the sort too — 'week' has a time filter
      // that changes the total row count for pagination math.
      countGalleryPages(sort),
      // Only show the feature box on page 1 of any sort — flipping
      // through page 5 of an old archive shouldn't keep restating it.
      page === 1 ? findCurrentSiteOfTheWeek() : Promise.resolve(null)
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const html = renderChrome({
      title: 'AI Composer Gallery — AI Netscape',
      content: renderGalleryContent({ pages, page, totalPages, sort, total, sotw }),
      statusText: 'Document: AI Composer Gallery'
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Short edge cache — new generations appear within ~60s of write.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Gallery render failed:', err && (err.stack || err.message || err));
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(errorHtml(err && err.message));
  }
}

// ============================================================
// Gallery content (grid + sort toggle + pagination)
// ============================================================
function renderGalleryContent({ pages, page, totalPages, sort, total, sotw }) {
  // Quiet, period-correct heading: Times Roman ~h2, single deep blue,
  // matching the rest of the chrome's register rather than Geocities
  // rainbow. No heavy rule below — the subtitle separates it from the
  // sort row.
  const intro =
    '<h2 class="gallery-h">AI Composer Gallery</h2>' +
    '<p class="gallery-sub">The finest destinations on the Information Superhighway, as voted by netizens like you. Bookmark liberally. Tell a friend, or a webring.</p>';

  // Site of the Week feature box sits above the sort toggle, only when
  // a winner exists. Empty state is "render nothing" per spec — no
  // placeholder, no "last week's winner" fallback.
  const sotwBox = sotw ? renderSiteOfTheWeek(sotw) : '';

  const sortToggle =
    '<div class="gallery-toolbar">' +
      '<div class="gallery-sort-group" role="tablist" aria-label="Sort gallery">' +
        renderSortButton('Recent',                 'recent', sort) +
        renderSortButton('This Week’s Best',   'week',   sort) +
        renderSortButton('Best of All Time (so far)', 'all',  sort) +
      '</div>' +
    '</div>';

  const grid = pages.length === 0
    ? '<p style="margin:40px 0; text-align:center; color:#666; font-style:italic;">' +
      'There is nothing here yet. Visit the <a href="/" style="color:#0000cc;">' +
      'AI Composer</a> and generate the first page.</p>'
    : '<div class="gallery-grid">' + pages.map(renderCard).join('') + '</div>';

  const pagination = total === 0 ? '' : renderPagination({ page, totalPages, sort });

  return intro + sotwBox + sortToggle + grid + pagination;
}

function renderSiteOfTheWeek(p) {
  const slug = String(p.share_slug || '');
  const title = String(p.page_title || 'Untitled');
  const upvotes = formatCount(p.upvotes);
  const hits = formatCount(p.hits);
  const date = formatGalleryDate(p.ts);
  const href = '/p/' + slug;
  const thumb = microlinkThumbnailUrl(slug);

  return '<div class="sotw-box">' +
    '<div class="sotw-header">&#9733; SITE OF THE WEEK</div>' +
    '<div class="sotw-body">' +
      '<a class="sotw-thumb" href="' + escapeAttr(href) + '" tabindex="-1" aria-hidden="true">' +
        '<img src="' + escapeAttr(staticThumbUrl(slug)) + '" data-fallback="' + escapeAttr(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
          'onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute(\'data-fallback\');}else{this.parentNode.classList.add(\'thumb-failed\');}">' +
      '</a>' +
      '<div class="sotw-info">' +
        '<a class="sotw-title" href="' + escapeAttr(href) + '" title="' + escapeAttr(title) + '">' +
          escapeHtml(title) +
        '</a>' +
        '<div class="sotw-meta">Upvotes: ' + escapeHtml(upvotes) +
          ' &middot; Hits: ' + escapeHtml(hits) + '</div>' +
        '<div class="sotw-date">' + escapeHtml(date) + '</div>' +
        '<a class="sotw-cta" href="' + escapeAttr(href) + '">View page &rarr;</a>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderSortButton(label, value, currentSort) {
  const active = (value === currentSort);
  const href = value === 'recent' ? '/gallery' : '/gallery?sort=' + value;
  return '<a href="' + escapeAttr(href) + '" role="tab"' +
    ' aria-selected="' + (active ? 'true' : 'false') + '"' +
    ' class="gallery-sort-btn' + (active ? ' active' : '') + '">' +
    escapeHtml(label) +
    '</a>';
}

function renderCard(p) {
  const slug = String(p.share_slug || '');
  const title = String(p.page_title || 'Untitled');
  const upvotes = Number(p.upvotes) || 0;
  const hits = formatCount(p.hits);
  const date = formatGalleryDate(p.ts);
  const href = '/p/' + slug;
  const thumb = microlinkThumbnailUrl(slug);

  // Only the thumbnail and the title are links to /p/:slug. Everything
  // else in .gallery-stats is plain text. The upvote button POSTs to
  // /api/vote and refreshes its own count inline.
  return '<div class="gallery-card">' +
    '<a class="gallery-thumb" href="' + escapeAttr(href) + '" tabindex="-1" aria-hidden="true">' +
      '<img src="' + escapeAttr(staticThumbUrl(slug)) + '" data-fallback="' + escapeAttr(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer" ' +
        'onerror="if(this.dataset.fallback){this.src=this.dataset.fallback;this.removeAttribute(\'data-fallback\');}else{this.parentNode.classList.add(\'thumb-failed\');}">' +
    '</a>' +
    '<div class="gallery-meta">' +
      '<a class="gallery-title" href="' + escapeAttr(href) + '" title="' + escapeAttr(title) + '">' +
        escapeHtml(title) +
      '</a>' +
      '<div class="gallery-row">' +
        '<button type="button" class="upvote-btn" data-slug="' + escapeAttr(slug) + '" ' +
          'title="Cool vote">&#9650; Upvote</button>' +
        '<span class="gallery-stats">' +
          'Upvotes: <span class="vote-count" data-slug="' + escapeAttr(slug) + '">' +
            escapeHtml(formatCount(upvotes)) +
          '</span>' +
          ' &middot; Hits: ' + escapeHtml(hits) +
          ' &mdash; ' + escapeHtml(date) +
        '</span>' +
      '</div>' +
    '</div>' +
  '</div>';
}

function renderPagination({ page, totalPages, sort }) {
  // 'recent' is the default, no need to carry it. The other two stick.
  const sortParam = (sort === 'recent') ? '' : '&sort=' + sort;
  const prevUrl = page > 1 ? '/gallery?page=' + (page - 1) + sortParam : null;
  const nextUrl = page < totalPages ? '/gallery?page=' + (page + 1) + sortParam : null;

  return '<div class="gallery-pagination">' +
    (prevUrl
      ? '<a href="' + escapeAttr(prevUrl) + '">[ &larr; Previous ]</a>'
      : '<span class="disabled">[ &larr; Previous ]</span>') +
    '<span class="page-info">Page ' + page + ' of ' + totalPages + '</span>' +
    (nextUrl
      ? '<a href="' + escapeAttr(nextUrl) + '">[ Next &rarr; ]</a>'
      : '<span class="disabled">[ Next &rarr; ]</span>') +
    '</div>';
}

// ============================================================
// Format helpers
// ============================================================
function formatGalleryDate(ts) {
  // "May DD, 1997" — month + day from the real timestamp, year always 1997
  // to maintain the site conceit (per the FAQ).
  const d = (ts instanceof Date) ? ts : new Date(ts);
  if (isNaN(d.getTime())) return 'May 24, 1997';
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', 1997';
}

function formatCount(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  return v.toLocaleString('en-US');
}

// Static gallery thumbnail: a committed PNG at public/images/gallery/<slug>.png.
// Used as the PRIMARY <img> src. Most slugs have no static file (404), so the
// onerror handler falls back to the Microlink live screenshot below — reseeded
// pages get a fast, reliable committed thumb; every other card keeps the
// dynamic Microlink behavior unchanged.
function staticThumbUrl(slug) {
  return '/images/gallery/' + encodeURIComponent(slug) + '.png';
}

function microlinkThumbnailUrl(slug) {
  // Same screenshot proxy as the OG card. 1200×800 viewport (3:2) for
  // detail; browsers downscale to the ~240px card width. Microlink caches
  // by URL so repeat visitors hit their CDN.
  return 'https://api.microlink.io/'
    + '?url=' + encodeURIComponent(SITE_ORIGIN + '/p/' + slug)
    + '&screenshot=true&meta=false&embed=screenshot.url'
    + '&viewport.width=1200&viewport.height=800';
}

function serviceUnavailableHtml() {
  return renderChrome({
    title: 'Top Sites Unavailable — AI Netscape',
    statusText: 'Document: Error 503',
    content:
      '<h1><span class="red">503</span> &mdash; <span class="blue">Gallery Unavailable</span></h1>' +
      '<p>The Top Sites archive server is currently being provisioned.</p>' +
      '<p>Please try again later, or <a href="/">return to AI Netscape</a> ' +
      'and generate a page directly.</p>'
  });
}

function errorHtml(msg) {
  return renderChrome({
    title: 'Top Sites Error — AI Netscape',
    statusText: 'Document: Error 500',
    content:
      '<h1><span class="red">500</span> &mdash; <span class="blue">Internal Error</span></h1>' +
      '<p>Top Sites could not be loaded.</p>' +
      (msg ? '<p style="font-family:monospace;font-size:11pt;color:#666;">' + escapeHtml(msg) + '</p>' : '') +
      '<p><a href="/">Return to AI Netscape</a>.</p>'
  });
}
