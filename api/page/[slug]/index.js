// /api/page/[slug].js
//
// Public page-serving endpoint for the share feature. The /p/:slug URL
// (vercel.json rewrite) lands here, looks up the generation in Mongo by
// the share_slug index, and serves the raw HTML page with:
//   - period-correct OG / Twitter meta tags injected into <head>
//   - a small "Made with AI Netscape" badge linking back with ?ref=share
//     (the viral-multiplier funnel)
//
// Gracefully 503s if MONGODB_URI isn't configured yet so a half-deployed
// state surfaces a useful message instead of a stack trace.

import { getCallerIp, rateLimit } from '../../_shared.js';
import { renderChrome, escapeAttr } from '../../_chrome.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).send('Method not allowed.');
  }

  if (!process.env.MONGODB_URI) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(503).send(unavailableHtml());
  }

  const slug = String(req.query.slug || '');
  if (!VALID_SLUG.test(slug)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(400).send(notFoundHtml(slug));
  }

  // Cheap per-IP brake on the public endpoint so a single viewer can't
  // saturate Mongo reads if a page goes viral. Separate bucket from gen/tri.
  const ip = getCallerIp(req);
  const rl = await rateLimit(ip, 'page', {
    perMin: 60, perHour: 1000, ipPerHour: 400, ipPerDay: 2000
  });
  if (!rl.allowed) {
    res.setHeader('Retry-After', String(rl.retryAfter));
    return res.status(429).send('Too many requests — please slow down.');
  }

  try {
    const { findBySlug } = await import('../../_db.js');
    const doc = await findBySlug(slug);
    // is_public:false is a takedown — the row stays in the DB (recoverable) but
    // the direct URL 404s, same as a missing body. A takedown is now a single
    // flag flip (no need to blank body_html), and hidden rows stay off both the
    // gallery feed AND their own /p/<slug> URL.
    if (!doc || !doc.body_html || doc.is_public === false) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.status(404).send(notFoundHtml(slug));
    }

    const html = decorate(doc.body_html, slug, doc);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Generated pages are immutable — once a slug points at content, that
    // content doesn't change. Cache aggressively at the edge.
    res.setHeader('Cache-Control', 'public, max-age=86400, s-maxage=86400, immutable');
    return res.status(200).send(html);
  } catch (err) {
    console.error('Page lookup failed:', err);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(500).send(notFoundHtml(slug));
  }
}

// ============================================================
// HTML transformation: inject OG meta tags into <head>, attach the
// "Made with AI Netscape" badge before </body>. Defensive against
// model outputs that may be missing one or the other.
// ============================================================
// Wrap the generated page in the full Netscape Composer frame (shared
// renderChrome), with the model's document rendered inside a SANDBOXED
// <iframe srcdoc> filling .edit-frame — the same isolation the homepage
// editor uses for AI results, so the page's own global CSS can't fight the
// chrome. Engagement actions + mute + nav move onto the status bar. OG tags
// go on the OUTER document head so social crawlers still get a card.
// ============================================================
export function decorate(html, slug, doc) {
  const shareUrl = 'https://ainetscape.com/p/' + slug;
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const pageTitle = (doc && doc.page_title) || (titleMatch && titleMatch[1].trim()) || 'A page made on AI Netscape';
  const safeTitle = escapeAttr(pageTitle.slice(0, 120));

  // OG image = a live Microlink screenshot of THIS share URL (now the framed
  // page). Social crawlers read these outer-document tags for the card.
  const ogImageUrl = 'https://api.microlink.io/'
    + '?url=' + encodeURIComponent(shareUrl)
    + '&screenshot=true&meta=false&embed=screenshot.url'
    + '&viewport.width=1200&viewport.height=630';
  const safeImg = escapeAttr(ogImageUrl);
  const ogTags =
    '<meta property="og:type" content="website">' +
    '<meta property="og:url" content="' + escapeAttr(shareUrl) + '">' +
    '<meta property="og:title" content="' + safeTitle + '">' +
    '<meta property="og:description" content="Made with AI Netscape — a 1997 HTML editor with one anachronistic button.">' +
    '<meta property="og:image" content="' + safeImg + '">' +
    '<meta property="og:image:width" content="1200">' +
    '<meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="' + safeTitle + '">' +
    '<meta name="twitter:description" content="Made with AI Netscape.">' +
    '<meta name="twitter:image" content="' + safeImg + '">' +
    '<script src="https://ainetscape.com/ga.js" defer></script>';

  const isArtifact = !!(doc && doc.source === 'ai' && doc.is_public !== false);

  // Generated document -> sandboxed iframe. allow-scripts keeps the page's own
  // JS alive (smooth-scroll, mailto CTA handlers); allow-popups +
  // allow-top-navigation-by-user-activation let the mailto: fire on click; NO
  // allow-same-origin, so the iframe is an opaque origin isolated from the chrome.
  const iframe =
    '<iframe class="page-frame" title="' + safeTitle + '" ' +
    'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-forms allow-modals" ' +
    'srcdoc="' + srcdocEscape(injectDefensiveStyle(html)) + '"></iframe>';

  const statusExtra = isArtifact ? artifactStatus(slug) : platformStatus();
  const scripts = isArtifact
    ? '<script src="https://ainetscape.com/share-dialog.js" defer></script>' +
      '<script src="https://ainetscape.com/artifact-cluster.js" defer></script>' + MUTE_SCRIPT
    : MUTE_SCRIPT;

  return renderChrome({
    title: pageTitle,
    statusText: 'Document: ' + pageTitle,
    headExtra: ogTags,
    styleExtra: PAGE_STYLE,
    editFrameInner: iframe,
    statusExtra: statusExtra,
    bodyScript: scripts
  });
}

// srcdoc lives in a double-quoted attribute: escape & and " only (the parser
// decodes once, so existing entities survive). < and > are legal inside an
// attribute value and must stay intact for the iframe document to parse.
function srcdocEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Inject a defensive style into the generated document so no image can force
// horizontal overflow inside the bounded ~780px frame (neutralizes e.g. the
// oversized below-fold image on MX2AloZw0B).
function injectDefensiveStyle(html) {
  const style = '<style>img,svg,video,canvas{max-width:100%!important;height:auto;}</style>';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + style);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html[^>]*>/i, (m) => m + style);
  return style + html;
}

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true">' +
    '<polygon class="spk-body" points="3,9 3,15 7,15 12,19 12,5 7,9"/>' +
    '<path class="spk-wave" d="M15 9.5a3.5 3.5 0 0 1 0 5"/>' +
    '<path class="spk-wave" d="M17.5 7a7 7 0 0 1 0 10"/>' +
    '<line class="spk-slash" x1="3" y1="4" x2="21" y2="20"/>' +
  '</svg>';

const MUTE_BTN =
  '<button class="status-sound" id="sound-toggle" type="button" ' +
  'title="Sound on (click to mute)" aria-pressed="false" aria-label="Toggle sound">' +
  SPEAKER_SVG + '</button>';

// Status-bar cluster for public AI pages: mute + engagement skeleton (hydrated
// by artifact-cluster.js, which queries the SAME data-attributes wherever they
// live) + nav. Counts/SOTW arrive from /stats on load.
function artifactStatus(slug) {
  return MUTE_BTN +
    '<div class="status-pane pcluster" data-artifact-cluster data-slug="' + escapeAttr(slug) + '">' +
      '<span data-sotw hidden class="p-sotw">&#9733; SOTW</span>' +
      '<button type="button" class="p-btn" data-action="upvote" title="Cool vote">&#9650; Upvote</button>' +
      '<span>Votes: <span data-vote-count>&mdash;</span></span>' +
      '<span>Hits: <span data-hit-count>&mdash;</span></span>' +
      '<button type="button" class="p-link" data-action="share">Share</button>' +
      '<button type="button" class="p-link" data-action="report">Report</button>' +
    '</div>' +
    NAV_LINKS;
}

// Non-public / hand-edited pages: mute + plain nav (no engagement).
function platformStatus() {
  return MUTE_BTN + NAV_LINKS;
}

const NAV_LINKS =
  '<div class="status-pane status-links">' +
    '<a href="/gallery">Top Sites</a><span class="sep">·</span>' +
    '<a href="/terms">Terms</a><span class="sep">·</span>' +
    '<a href="/privacy">Privacy</a><span class="sep">·</span>' +
    '<a href="/copyright">Copyright</a><span class="sep">·</span>' +
    '<a href="/faq">FAQ</a>' +
  '</div>';

// /p/-specific chrome CSS: the framed iframe fills .edit-frame, the status bar
// grows/wraps to hold the cluster, and the mute speaker matches the homepage.
const PAGE_STYLE = `
  .page-frame { width:100%; height:100%; border:0; display:block; background:#fff; }
  .statusbar { height:auto; min-height:20px; flex-wrap:wrap; row-gap:2px; }
  .status-sound { background:var(--face); border:1px solid; border-color:var(--sh) var(--hi) var(--hi) var(--sh); cursor:pointer; user-select:none; padding:0 5px; height:16px; display:flex; align-items:center; }
  .status-sound:hover { background:var(--face-lt); }
  .status-sound:active { border-color:var(--hi) var(--sh) var(--sh) var(--hi); }
  .status-sound svg { display:block; width:14px; height:14px; color:var(--text); }
  .status-sound .spk-body { fill:currentColor; }
  .status-sound .spk-wave { fill:none; stroke:currentColor; stroke-width:1.6; stroke-linecap:round; }
  .status-sound .spk-slash { fill:none; stroke:#c00000; stroke-width:2; stroke-linecap:round; display:none; }
  .status-sound.muted .spk-wave { display:none; }
  .status-sound.muted .spk-slash { display:block; }
  .pcluster { display:flex; align-items:center; gap:6px; font-size:10px; color:#333; white-space:nowrap; }
  .pcluster .p-sotw { color:#000080; font-weight:bold; letter-spacing:0.03em; }
  .pcluster .p-btn { font-family:"MS Sans Serif",Tahoma,sans-serif; font-size:10px; color:#000; background:var(--face); border:2px solid; border-color:var(--hi) var(--sh-dk) var(--sh-dk) var(--hi); padding:0 6px; height:16px; cursor:pointer; line-height:12px; }
  .pcluster .p-btn:active, .pcluster .p-btn.voted { border-color:var(--sh-dk) var(--hi) var(--hi) var(--sh-dk); }
  .pcluster .p-btn.voted { color:#555; cursor:default; }
  .pcluster .p-link { color:var(--select); text-decoration:underline; cursor:pointer; background:none; border:0; padding:0; font:inherit; }
  @media (max-width: 600px) { .pcluster span:not(.p-sotw) { display:none; } }
`;

// Light mute toggle for /p/ — persists the shared 'ainetscape-sound-muted'
// preference (so it carries to the homepage's modem sounds) and flips the icon.
// There is no audio to control here; the toggle is for chrome consistency.
const MUTE_SCRIPT = `<script>
(function(){
  var KEY='ainetscape-sound-muted';
  function isMuted(){ try{ var s=localStorage.getItem(KEY); if(s==='1')return true; if(s==='0')return false; }catch(e){}
    try{ return window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches; }catch(e){ return false; } }
  var btn=document.getElementById('sound-toggle');
  function paint(m){ if(!btn)return; btn.classList.toggle('muted',m); btn.setAttribute('aria-pressed',m?'true':'false'); btn.title=m?'Sound off (click to unmute)':'Sound on (click to mute)'; }
  paint(isMuted());
  if(btn) btn.addEventListener('click',function(){ var m=!isMuted(); try{localStorage.setItem(KEY,m?'1':'0');}catch(e){} paint(m); });
})();
</script>`;

function notFoundHtml(slug) {
  const safe = escapeAttr(slug || '').slice(0, 40);
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Page Not Found — AI Netscape</title>
<style>
  body { font-family: "MS Sans Serif", Tahoma, sans-serif; background: #008080;
         color: #c8c8c8; text-align: center; padding: 80px 20px; margin: 0; }
  .frame { background: #c0c0c0; color: #000; max-width: 480px; margin: 0 auto;
           padding: 24px; border: 2px solid #fff; border-right-color: #404040;
           border-bottom-color: #404040; }
  h1 { margin: 0 0 12px; font-size: 14px; }
  p { font-size: 11px; margin: 8px 0; }
  a { color: #0000c0; }
  code { background: #fff; padding: 1px 4px; border: 1px solid #808080; font-size: 10px; }
</style>
</head><body>
<div class="frame">
  <h1>404 — Page Not Found</h1>
  <p>The page <code>/p/${safe}</code> could not be located on our switchboard.</p>
  <p>The link may have been mistyped, or the page may have been disconnected.</p>
  <p><a href="https://ainetscape.com">Return to AI Netscape</a></p>
</div>
</body></html>`;
}

function unavailableHtml() {
  return `<!doctype html>
<html><head>
<meta charset="utf-8">
<title>Sharing Unavailable — AI Netscape</title>
<style>
  body { font-family: "MS Sans Serif", Tahoma, sans-serif; background: #008080;
         color: #c8c8c8; text-align: center; padding: 80px 20px; margin: 0; }
  .frame { background: #c0c0c0; color: #000; max-width: 480px; margin: 0 auto;
           padding: 24px; border: 2px solid #fff; border-right-color: #404040;
           border-bottom-color: #404040; }
  h1 { margin: 0 0 12px; font-size: 14px; }
  p { font-size: 11px; margin: 8px 0; }
  a { color: #0000c0; }
</style>
</head><body>
<div class="frame">
  <h1>Sharing Service Temporarily Unavailable</h1>
  <p>The archive server is currently being provisioned.</p>
  <p>Please try again later, or <a href="https://ainetscape.com">return to AI Netscape</a>.</p>
</div>
</body></html>`;
}
