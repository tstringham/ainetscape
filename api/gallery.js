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
  const sort = (String(req.query.sort || '').toLowerCase() === 'upvotes')
    ? 'upvotes' : 'recent';
  let page = parseInt(req.query.page, 10);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(page, 10000);     // sanity cap

  try {
    const { findGalleryPages, countGalleryPages } = await import('./_db.js');
    const [pages, total] = await Promise.all([
      findGalleryPages({ sort, skip: (page - 1) * PAGE_SIZE, limit: PAGE_SIZE }),
      countGalleryPages()
    ]);
    const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

    const html = renderChrome({
      title: 'AI Composer Gallery — AI Netscape',
      content: renderGalleryContent({ pages, page, totalPages, sort, total }),
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
function renderGalleryContent({ pages, page, totalPages, sort, total }) {
  const intro =
    '<h1><span class="red">AI Composer</span> <span class="blue">Gallery</span></h1>' +
    '<p style="font-size:13pt; margin:0 0 6px;">' +
      escapeHtml(total === 0
        ? 'No pages yet. Be the first.'
        : (total + ' published page' + (total === 1 ? '' : 's') + ' so far.')) +
    '</p>';

  const sortToggle =
    '<div class="gallery-toolbar">' +
      '<div class="gallery-sort">Sort by: ' +
        renderSortLink('Recent',  'recent',  sort) + ' | ' +
        renderSortLink('Upvotes', 'upvotes', sort) +
      '</div>' +
    '</div>';

  const grid = pages.length === 0
    ? '<p style="margin:40px 0; text-align:center; color:#666; font-style:italic;">' +
      'There is nothing here yet. Visit the <a href="/" style="color:#0000cc;">' +
      'AI Composer</a> and generate the first page.</p>'
    : '<div class="gallery-grid">' + pages.map(renderCard).join('') + '</div>';

  const pagination = total === 0 ? '' : renderPagination({ page, totalPages, sort });

  return intro + sortToggle + grid + pagination;
}

function renderSortLink(label, value, currentSort) {
  const active = (value === currentSort);
  const href = value === 'recent' ? '/gallery' : '/gallery?sort=' + value;
  return '<a href="' + escapeAttr(href) + '"' +
    (active ? ' class="active"' : '') + '>' +
    (active ? '[ ' + escapeHtml(label) + ' ]' : escapeHtml(label)) +
    '</a>';
}

function renderCard(p) {
  const slug = String(p.share_slug || '');
  const title = String(p.page_title || 'Untitled');
  const upvotes = formatCount(p.upvotes);
  const hits = formatCount(p.hits);
  const date = formatGalleryDate(p.ts);
  const href = '/p/' + slug;
  const thumb = microlinkThumbnailUrl(slug);

  return '<a class="gallery-card" href="' + escapeAttr(href) + '">' +
    '<div class="gallery-thumb">' +
      '<img src="' + escapeAttr(thumb) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' +
    '</div>' +
    '<div class="gallery-meta">' +
      '<div class="gallery-title">' + escapeHtml(title) + '</div>' +
      '<div class="gallery-stats">' +
        'Upvotes: ' + escapeHtml(upvotes) +
        ' &middot; Hits: ' + escapeHtml(hits) +
      '</div>' +
      '<div class="gallery-date">' + escapeHtml(date) + '</div>' +
    '</div>' +
  '</a>';
}

function renderPagination({ page, totalPages, sort }) {
  const sortParam = (sort === 'upvotes') ? '&sort=upvotes' : '';
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

function microlinkThumbnailUrl(slug) {
  // Same screenshot proxy as the OG card. 1200×800 viewport (3:2) for
  // detail; browsers downscale to the ~240px card width. Microlink caches
  // by URL so repeat visitors hit their CDN.
  return 'https://api.microlink.io/'
    + '?url=' + encodeURIComponent(SITE_ORIGIN + '/p/' + slug)
    + '&screenshot=true&meta=false&embed=screenshot.url'
    + '&viewport.width=1200&viewport.height=800';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function escapeAttr(s) { return escapeHtml(s); }

// ============================================================
// Chrome — inlined here because Vercel function bundles can't easily
// reach scripts/templates/page.html. Mirrors that template structure.
// If the chrome ever diverges between build-time pages and runtime
// pages, this is where the runtime side lives.
// ============================================================
function renderChrome({ title, content, statusText = 'Document: Done' }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=5">
<title>${escapeHtml(title)}</title>
<meta name="theme-color" content="#008080">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="icon" type="image/x-icon" href="/favicon.ico">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<script src="/ga.js" async></script>
<style>
  :root {
    --face:#c0c0c0; --face-lt:#dfdfdf; --hi:#ffffff;
    --sh:#808080; --sh-dk:#404040; --text:#000;
    --link:#0000ee; --vlink:#551a8b;
    --select:#000080; --select-fg:#fff;
    --title-active:#000080;
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0; min-height: 100%;
    background: #008080;
    font-family: "MS Sans Serif", "Geneva", "Tahoma", sans-serif;
    font-size: 11px; color: var(--text);
  }
  body { overflow-y: auto; overflow-x: hidden; }
  .window {
    width: 800px; max-width: 800px;
    height: calc(100vh - 24px); max-height: 720px;
    margin: 12px auto; background: var(--face);
    border: 2px solid;
    border-color: var(--hi) var(--sh-dk) var(--sh-dk) var(--hi);
    display: flex; flex-direction: column;
    box-shadow: 1px 1px 0 var(--sh-dk);
  }
  @media (min-height: 900px) { .window { max-height: 820px; } }
  @media (max-width: 820px) {
    .window {
      width: auto; max-width: none;
      height: calc(100vh - 12px); max-height: none; margin: 6px;
    }
    .toolbar { flex-wrap: wrap; }
    .tbtn { min-width: 44px; padding: 2px 3px; }
    .tbtn .lbl { font-size: 9px; }
    .titlebar .title { font-size: 10px; }
    .statusbar { font-size: 10px; }
  }
  @media (pointer: coarse) { .menu-item { padding: 4px 10px; } }
  .titlebar {
    height: 20px; background: var(--title-active); color: white;
    display: flex; align-items: center; padding: 0 2px 0 4px;
    font-weight: bold; font-size: 11px; user-select: none; flex-shrink: 0;
  }
  .titlebar .title { flex: 1; }
  .titlebar-btns { display: flex; gap: 2px; }
  .titlebar-btn {
    width: 16px; height: 14px; background: var(--face);
    border: 1px solid;
    border-color: var(--hi) var(--sh-dk) var(--sh-dk) var(--hi);
    color: black; font-size: 9px; font-weight: bold;
    line-height: 10px; text-align: center; cursor: default;
    font-family: "Marlett", "MS Sans Serif", sans-serif; padding: 0;
  }
  .titlebar-btn:active { border-color: var(--sh-dk) var(--hi) var(--hi) var(--sh-dk); }
  .menubar {
    display: flex; background: var(--face);
    border-bottom: 1px solid var(--sh);
    padding: 2px; flex-shrink: 0;
  }
  .menu-item { padding: 2px 8px; cursor: default; user-select: none; }
  .menu-item:hover { background: var(--select); color: var(--select-fg); }
  .menu-item .acc { text-decoration: underline; }
  .toolbar {
    display: flex; align-items: stretch; gap: 1px; padding: 3px;
    background: var(--face); border-bottom: 1px solid var(--sh);
    flex-shrink: 0; flex-wrap: wrap;
  }
  .tbtn {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    min-width: 48px; padding: 3px 5px 2px;
    background: var(--face); border: 2px solid transparent;
    cursor: default; user-select: none;
    font-size: 10px; color: black; line-height: 1;
  }
  .tbtn:hover { border-color: var(--hi) var(--sh-dk) var(--sh-dk) var(--hi); }
  .tbtn .icon { width: 24px; height: 24px; margin-bottom: 2px;
    display: flex; align-items: center; justify-content: center; }
  .tbtn .lbl { font-size: 10px; }
  .tb-sep { width: 1px; margin: 2px 3px; background: var(--sh); border-right: 1px solid var(--hi); }
  .tbtn.ai-btn {
    background: linear-gradient(180deg, #ff44ff 0%, #ff00cc 32%, #cc00ff 50%, #00ccff 68%, #22ffff 100%);
    color: black; border: 2px solid;
    border-color: #ffff00 #ff00ff #ff00ff #ffff00;
    transform-origin: center;
    animation: ai-breathe 2.4s ease-in-out infinite;
    cursor: pointer;
  }
  .tbtn.ai-btn .lbl {
    font-weight: bold; letter-spacing: 0.02em;
    text-shadow: 1px 1px 0 #fff, 0 0 6px rgba(255,255,255,0.55);
  }
  .tbtn.ai-btn:hover { border-color: #ffff00 #00ffff #00ffff #ffff00; animation-play-state: paused; }
  @keyframes ai-breathe {
    0%   { transform: scale(1.00); box-shadow: 0 0 2px 0 rgba(255,0,255,.30), 0 0 5px 1px rgba(0,255,255,.45); }
    50%  { transform: scale(1.04); box-shadow: 0 0 10px 3px rgba(255,0,255,.55), 0 0 16px 5px rgba(0,255,255,.75); }
    100% { transform: scale(1.00); box-shadow: 0 0 2px 0 rgba(255,0,255,.30), 0 0 5px 1px rgba(0,255,255,.45); }
  }
  @media (prefers-reduced-motion: reduce) {
    .tbtn.ai-btn { animation: none; transform: none;
      box-shadow: 0 0 10px 3px rgba(0,255,255,.85), 0 0 4px 1px rgba(255,0,255,.5); }
  }
  .workspace { flex: 1; background: var(--face); padding: 2px;
    overflow: hidden; display: flex; flex-direction: column; min-height: 0; }
  .edit-frame { flex: 1; background: white;
    border: 2px solid; border-color: var(--sh) var(--hi) var(--hi) var(--sh);
    overflow: auto; min-height: 0; }
  .doc-content {
    padding: 28px 28px 56px;
    font-family: "Times New Roman", Times, serif;
    font-size: 14pt; color: #000; background: white; line-height: 1.55;
  }
  .doc-content h1 {
    font-size: 2.2em; font-weight: bold;
    margin: 0 0 0.5em; line-height: 1.1;
    border-bottom: 2px solid #888; padding-bottom: 0.2em;
  }
  .doc-content h1 .red  { color: #cc0000; }
  .doc-content h1 .blue { color: #0000cc; }
  .doc-content a { color: #0000cc; text-decoration: underline; }
  .doc-content a:visited { color: #551a8b; }
  /* ---- Gallery-specific ---- */
  .gallery-toolbar {
    display: flex; justify-content: space-between; align-items: center;
    margin: 16px 0 24px; font-size: 12pt;
    font-family: "MS Sans Serif", sans-serif;
  }
  .gallery-sort a {
    color: #0000cc; text-decoration: underline;
    margin: 0 2px; font-size: 11pt;
  }
  .gallery-sort a.active {
    font-weight: bold; color: #000; text-decoration: underline;
  }
  .gallery-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 20px;
    margin: 0 0 24px;
  }
  @media (max-width: 819px) { .gallery-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 639px) { .gallery-grid { grid-template-columns: 1fr; } }
  .gallery-card {
    background: white;
    border: 1px solid;
    border-color: var(--hi) var(--sh-dk) var(--sh-dk) var(--hi);
    text-decoration: none;
    color: inherit;
    display: flex; flex-direction: column;
    transition: transform 0.12s;
  }
  .gallery-card:hover { border-color: #ff00cc #00ccff #00ccff #ff00cc; }
  .gallery-thumb {
    aspect-ratio: 3 / 2;
    background: #eee;
    border-bottom: 1px solid var(--sh);
    overflow: hidden;
  }
  .gallery-thumb img {
    width: 100%; height: 100%;
    object-fit: cover; object-position: top center;
    display: block;
  }
  .gallery-meta {
    padding: 10px 12px;
    font-family: "MS Sans Serif", "Geneva", Tahoma, sans-serif;
    font-size: 11px;
  }
  .gallery-title {
    font-family: "Times New Roman", Times, serif;
    font-weight: bold; font-size: 13pt;
    color: #000080;
    margin: 0 0 6px;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    text-overflow: ellipsis;
    min-height: 2.4em;
    line-height: 1.2;
  }
  .gallery-card:hover .gallery-title { color: #cc00cc; }
  .gallery-stats { font-size: 11px; color: #444; margin: 0 0 3px; }
  .gallery-date  { font-size: 10px; color: #777; font-style: italic; }
  .gallery-pagination {
    text-align: center; margin: 24px 0 8px;
    font-family: "MS Sans Serif", sans-serif; font-size: 11pt;
  }
  .gallery-pagination a {
    color: #0000cc; text-decoration: underline;
    margin: 0 12px;
  }
  .gallery-pagination .disabled { color: #999; margin: 0 12px; }
  .gallery-pagination .page-info { margin: 0 12px; color: #333; }
  /* ---- Status bar (mirrors index/404) ---- */
  .statusbar {
    height: 20px; background: var(--face);
    border-top: 1px solid var(--hi);
    display: flex; align-items: center;
    padding: 0 2px; font-size: 11px;
    flex-shrink: 0; gap: 2px;
  }
  .status-pane {
    border: 1px solid; border-color: var(--sh) var(--hi) var(--hi) var(--sh);
    padding: 1px 6px; height: 16px;
    display: flex; align-items: center;
  }
  .status-pane.flex { flex: 1; }
  .status-modem {
    background: var(--face); border: 1px solid;
    border-color: var(--sh) var(--hi) var(--hi) var(--sh);
    padding: 1px 6px; height: 16px;
    font-family: "MS Sans Serif", sans-serif; font-size: 11px;
    color: var(--text); white-space: nowrap;
  }
  .status-links {
    font-family: "MS Sans Serif", "Geneva", "Tahoma", sans-serif;
    font-size: 10px; white-space: nowrap;
  }
  .status-links a { color: var(--select); text-decoration: underline; }
  .status-links a:visited { color: var(--vlink); }
  .status-links .sep { color: #666; margin: 0 4px; }
  @media (max-width: 560px) { .status-links { display: none; } }
</style>
</head>
<body>
<div class="window">
  <div class="titlebar">
    <span class="title">AI Netscape: 1997's AI-Powered HTML Editor</span>
    <div class="titlebar-btns">
      <button class="titlebar-btn" title="Minimize">_</button>
      <button class="titlebar-btn" title="Maximize">▢</button>
      <button class="titlebar-btn" title="Close" onclick="window.location.href='/'">✕</button>
    </div>
  </div>
  <div class="menubar">
    <div class="menu-item"><span class="acc">F</span>ile</div>
    <div class="menu-item"><span class="acc">E</span>dit</div>
    <div class="menu-item"><span class="acc">V</span>iew</div>
    <div class="menu-item"><span class="acc">I</span>nsert</div>
    <div class="menu-item">F<span class="acc">o</span>rmat</div>
    <div class="menu-item"><span class="acc">T</span>ools</div>
    <div class="menu-item"><span class="acc">H</span>elp</div>
  </div>
  <div class="toolbar">
    <a href="/" style="text-decoration:none;color:inherit;display:flex;">
      <div class="tbtn ai-btn" title="Open AI Composer">
        <div class="icon">
          <svg width="22" height="22" viewBox="0 0 22 22">
            <path d="M11 2 l2 6 l6 2 l-6 2 l-2 6 l-2 -6 l-6 -2 l6 -2 z" fill="white" stroke="black" stroke-width="0.8"/>
            <circle cx="17" cy="5" r="1.5" fill="white" stroke="black" stroke-width="0.6"/>
            <circle cx="4" cy="18" r="1" fill="white" stroke="black" stroke-width="0.6"/>
          </svg>
        </div>
        <div class="lbl">AI Composer</div>
      </div>
    </a>
  </div>
  <div class="workspace">
    <div class="edit-frame">
      <div class="doc-content">${content}</div>
    </div>
  </div>
  <div class="statusbar">
    <div class="status-pane flex">${escapeHtml(statusText)}</div>
    <div class="status-pane status-links">
      <a href="/gallery">Gallery</a><span class="sep">·</span><a href="/terms">Terms</a><span class="sep">·</span><a href="/privacy">Privacy</a><span class="sep">·</span><a href="/copyright">Copyright</a><span class="sep">·</span><a href="/faq">FAQ</a>
    </div>
    <div class="status-modem" title="Connection speed"><span>28.8 kbps</span></div>
    <div class="status-pane" id="status-clock">--:--</div>
  </div>
</div>
<script>
  function tickClock() {
    const d = new Date();
    document.getElementById('status-clock').textContent =
      String(d.getHours()).padStart(2,'0') + ':' +
      String(d.getMinutes()).padStart(2,'0');
  }
  setInterval(tickClock, 1000); tickClock();
</script>
</body>
</html>`;
}

function serviceUnavailableHtml() {
  return renderChrome({
    title: 'Gallery Unavailable — AI Netscape',
    statusText: 'Document: Error 503',
    content:
      '<h1><span class="red">503</span> &mdash; <span class="blue">Gallery Unavailable</span></h1>' +
      '<p>The Gallery archive server is currently being provisioned.</p>' +
      '<p>Please try again later, or <a href="/">return to AI Netscape</a> ' +
      'and generate a page directly.</p>'
  });
}

function errorHtml(msg) {
  return renderChrome({
    title: 'Gallery Error — AI Netscape',
    statusText: 'Document: Error 500',
    content:
      '<h1><span class="red">500</span> &mdash; <span class="blue">Internal Error</span></h1>' +
      '<p>The Gallery could not be loaded.</p>' +
      (msg ? '<p style="font-family:monospace;font-size:11pt;color:#666;">' + escapeHtml(msg) + '</p>' : '') +
      '<p><a href="/">Return to AI Netscape</a>.</p>'
  });
}
