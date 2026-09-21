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
import { buildDescription } from '../../_indexable.js';

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
    /*
     * The CDN holds it for a day; the browser revalidates every time.
     *
     * This was `max-age=86400, immutable`, and `immutable` means a browser will
     * not even ASK -- so a visitor who loaded a page before a deploy kept the
     * old one for a full day with no way to know. That cost real confusion on
     * 20 September: a fix shipped, the live HTML was verifiably correct, and
     * the page on screen went on showing the old behaviour.
     *
     * The generated CONTENT is immutable. This wrapper is not -- its markup,
     * its meta tags and the scripts it loads all change when we deploy. So the
     * CDN keeps a day's copy and is purged on deploy, while the browser spends
     * a conditional request and usually gets a 304.
       */
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=86400, stale-while-revalidate=3600');
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

  // OG image = this page's own stored thumbnail, served from /api/thumb.
  //
  // This was a live api.microlink.io screenshot of the share URL. That is a
  // third-party proxy on a free daily quota, and when the quota ran out on
  // 20 September every shared link on the site lost its social card at the
  // same moment the gallery lost its thumbnails -- one dependency, two
  // failures, neither visible from inside the site.
  //
  // Absolute, because a crawler has no base to resolve against. And when the
  // page has no render yet, this falls back to the site's static social card
  // rather than to /api/thumb's placeholder: that placeholder is an SVG, and
  // Facebook, Twitter and iMessage all reject SVG for og:image. A generic but
  // valid card beats a specific but rejected one.
  const hasRender = !!(doc && doc.thumbnail_at);
  const ogImageUrl = hasRender
    ? 'https://ainetscape.com/api/thumb/' + encodeURIComponent(slug)
    : 'https://ainetscape.com/og-image.png';
  const safeImg = escapeAttr(ogImageUrl);
  // The two images are not the same shape and the tags have to say so. The
  // static card is 1200x630; a rendered thumbnail is 1200x800, the 3:2 the
  // gallery and the renderer both use. This declared 630 for both, so every
  // page that HAD a thumbnail advertised a crop it does not have, and a
  // scraper that trusts the tags over the bytes lays out the wrong box.
  const ogImageHeight = hasRender ? '800' : '630';
  /*
   * A description drawn from what the page says, and a canonical.
   *
   * Neither existed. Every /p/ page shipped og:* tags and no
   * <meta name="description"> at all, so a search result showed whatever
   * Google chose to scrape -- which, before the text version below, was the
   * Netscape menu bar.
   */
  const metaDescription = buildDescription(html, pageTitle);
  const ogTags =
    '<meta name="description" content="' + escapeAttr(metaDescription) + '">' +
    '<link rel="canonical" href="' + escapeAttr(shareUrl) + '">' +
    '<meta property="og:type" content="website">' +
    '<meta property="og:url" content="' + escapeAttr(shareUrl) + '">' +
    '<meta property="og:title" content="' + safeTitle + '">' +
    '<meta property="og:description" content="' + escapeAttr(metaDescription) + '">' +
    '<meta property="og:image" content="' + safeImg + '">' +
    '<meta property="og:image:width" content="1200">' +
    '<meta property="og:image:height" content="' + ogImageHeight + '">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="' + safeTitle + '">' +
    '<meta name="twitter:description" content="Made with AI Netscape.">' +
    '<meta name="twitter:image" content="' + safeImg + '">' +
    '<script src="https://ainetscape.com/ga.js" defer></script>';

  const isArtifact = !!(doc && doc.source === 'ai' && doc.is_public !== false);

  // Generated document -> sandboxed iframe. allow-scripts keeps the page's own
  // JS alive (smooth-scroll, CTA handlers); allow-popups +
  // allow-top-navigation-by-user-activation let a page's ordinary links open; NO
  // allow-same-origin, so the iframe is an opaque origin isolated from the chrome.
  // Mail launches never happen from inside the frame: prepareDocument routes a
  // legacy page's mailto: link or location assignment through the CTA dispatcher.
  const iframe =
    '<iframe class="page-frame" title="' + safeTitle + '" ' +
    'sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation allow-forms allow-modals" ' +
    /*
     * A real URL, not srcdoc.
     *
     * srcdoc has no address, so the document inside it could not be crawled --
     * that is the whole reason /p/<slug>/raw exists. The sandbox is unchanged
     * and still omits allow-same-origin, and `raw` sends a CSP sandbox header
     * so the isolation holds even if someone opens the URL directly.
     */
    'src="/p/' + encodeURIComponent(slug) + '/raw"></iframe>';

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

// Render-time preparation of the stored document:
//  1. a defensive style so no image can force horizontal overflow inside the
//     bounded ~780px frame (neutralizes e.g. the oversized below-fold image on
//     MX2AloZw0B);
//  2. legacy mail launches are routed through the CTA dispatcher. Pages generated
//     before the dispatcher existed either link to mailto: or assign
//     window.location.href = 'mailto:...'. Navigating a sandboxed frame to an
//     external scheme is handled inconsistently by browsers and drags the
//     visitor into their mail client; the dispatcher posts the same subject and
//     body to /api/cta instead. The assignment is redirected to __aiLoc.href
//     (a head stub parks any early value; cta-dispatch.js takes over on load),
//     and the dispatcher tag is added when the stored document lacks it.
const CTA_DISPATCH_SRC = 'https://ainetscape.com/cta-dispatch.js';
const LOC_STUB = '<script>window.__aiLoc={set href(v){if(/^\\s*mailto:/i.test(String(v))){'
  + '(window.__aiMailQueue=window.__aiMailQueue||[]).push(String(v));}else{window.location.href=v;}},'
  + 'get href(){return window.location.href;}};</script>';
/*
 * Keep typed text visible.
 *
 * "THE LOST FLAVOURS" shipped with `input, textarea { background:
 * transparent; color: var(--cream) }` on a page whose background IS
 * --cream. Typing worked perfectly and painted every character in the
 * colour of the paper, so the form read as completely broken. The model
 * had written a dark-page palette and then used it on a light page.
 *
 * This is a whole class of failure, not one page: the model picks the
 * field colour and the page colour independently, and nothing checks that
 * they differ. A visitor cannot report it usefully either -- "typing does
 * nothing" is what it looks like from the outside.
 *
 * So the check happens in the browser, where the real computed colours
 * are known. For each field: find the nearest ancestor with an actual
 * background, and compare it to the text colour by WCAG contrast ratio.
 * Below 1.6 the text is invisible or nearly so, and the field gets #111
 * or #fff -- whichever contrasts better with what is behind it.
 *
 * 1.6 is deliberately low. Ordinary body text is 4.5 or more and a
 * deliberately soft field might be 2.5; this only rescues text that
 * cannot be read at all, and leaves every design decision above that
 * line alone. Buttons, checkboxes and hidden inputs are skipped -- they
 * have no typed text to lose.
 *
 * Runs at render, so it reaches every page already published.
 */
const LEGIBLE_FIELDS = `<script>/*__aiLegibleFields*/(function(){
function p(s){var m=/rgba?\\(([^)]+)\\)/.exec(s||'');if(!m)return null;
var v=m[1].split(',').map(parseFloat);return{r:v[0],g:v[1],b:v[2],a:v.length>3?v[3]:1};}
function L(c){function f(v){v/=255;return v<=0.03928?v/12.92:Math.pow((v+0.055)/1.055,2.4);}
return 0.2126*f(c.r)+0.7152*f(c.g)+0.0722*f(c.b);}
function R(a,b){var x=L(a),y=L(b);return x<y?(y+0.05)/(x+0.05):(x+0.05)/(y+0.05);}
function bg(e){for(var n=e;n&&n.nodeType===1;n=n.parentElement){
var c=p(getComputedStyle(n).backgroundColor);if(c&&c.a>0.1)return c;}
return{r:255,g:255,b:255,a:1};}
function fix(e){var s=getComputedStyle(e),f=p(s.webkitTextFillColor)||p(s.color);if(!f)return;
var b=bg(e);if(f.a>0.1&&R(f,b)>=1.6)return;
var c=R({r:17,g:17,b:17},b)>=R({r:255,g:255,b:255},b)?'#111':'#fff';
e.style.setProperty('color',c,'important');
e.style.setProperty('-webkit-text-fill-color',c,'important');
e.style.setProperty('caret-color',c,'important');}
function run(){var q=document.querySelectorAll('input,textarea,select'),i,t;
for(i=0;i<q.length;i++){t=(q[i].type||'').toLowerCase();
if(t==='hidden'||t==='checkbox'||t==='radio'||t==='range'||t==='color'||t==='file'
||t==='submit'||t==='button'||t==='reset'||t==='image')continue;fix(q[i]);}}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run);else run();
window.addEventListener('load',run);})();</scr`+`ipt>`;

export function prepareDocument(html, slug) {
  let out = String(html == null ? '' : html);
  out = out.replace(/window\.location\.href(\s*)=(?!=)/g, '__aiLoc.href$1=');

  /*
   * Strip the model's own form handlers.
   *
   * The system prompt is explicit that a form gets named fields and a submit
   * button and NOTHING else -- no action, no method, no handler -- because the
   * host intercepts every submit, delivers the fields to the webmaster and
   * shows the in-page confirmation. The model ignores this on nearly every
   * page, writing things like:
   *
   *   onsubmit="event.preventDefault(); alert('Your reflection has been noted.
   *             The page will remember this privately.');"
   *
   * Two problems, and the second is the serious one. It throws a native browser
   * alert, which looks nothing like a 1997 page and breaks the illusion the
   * whole site is built on. And it asserts something FALSE: nothing remembers
   * anything privately. A visitor is told their message was kept when the only
   * thing that happened was whatever `cta-dispatch.js` managed on its own.
   *
   * cta-dispatch binds on the CAPTURE phase so it always runs first and the
   * delivery does happen -- but `preventDefault` does not stop the inline
   * handler, so the model's lie fires immediately afterwards and is what the
   * visitor actually sees.
   *
   * So the attribute goes. Removing it leaves the host's own confirmation as
   * the only thing that speaks, which is what the prompt asked for. Applied at
   * render, so it fixes every page already published as well as the next one.
   *
   * Deliberately narrow: `onsubmit` on `<form>` only. Generated pages use
   * onclick for calculators and toggles that are real content -- those stay.
   */
  out = out.replace(/(<form\b[^>]*?)\son(?:submit|reset)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '$1');
  const head = '<style>img,svg,video,canvas{max-width:100%!important;height:auto;}</style>' + LOC_STUB;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + head);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => m + head);
  else out = head + out;
  if (!out.includes(CTA_DISPATCH_SRC)) {
    const tag = '<script src="' + CTA_DISPATCH_SRC + '" data-cta-page="https://ainetscape.com/p/'
      + encodeURIComponent(String(slug || '')) + '" defer></script>';
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => tag + '</body>');
    else if (/<\/html>/i.test(out)) out = out.replace(/<\/html>/i, () => tag + '</html>');
    else out = out + tag;
  }
  if (!out.includes('__aiLegibleFields')) {
    if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, () => LEGIBLE_FIELDS + '</body>');
    else if (/<\/html>/i.test(out)) out = out.replace(/<\/html>/i, () => LEGIBLE_FIELDS + '</html>');
    else out = out + LEGIBLE_FIELDS;
  }
  return out;
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
