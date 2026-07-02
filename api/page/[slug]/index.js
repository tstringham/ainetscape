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
function decorate(html, slug, doc) {
  const shareUrl = 'https://ainetscape.com/p/' + slug;
  const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
  const pageTitle = (titleMatch && titleMatch[1].trim()) || 'A page made on AI Netscape';
  const safeTitle = escapeAttr(pageTitle.slice(0, 120));

  // OG image = a live screenshot of THIS share URL via Microlink's
  // screenshot proxy. Social crawlers (Twitter, iMessage, Slack, etc.)
  // follow the link, get a PNG, cache it for ~7 days. First crawl
  // takes 3-5s while Microlink generates fresh; subsequent shares
  // hit their CDN cache. Anonymous free tier covers low traffic;
  // swap to a registered API key (or self-host Playwright) if usage
  // outgrows it.
  const ogImageUrl = 'https://api.microlink.io/'
    + '?url=' + encodeURIComponent(shareUrl)
    + '&screenshot=true'
    + '&meta=false'
    + '&embed=screenshot.url'
    + '&viewport.width=1200'
    + '&viewport.height=630';
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
    '<meta name="twitter:image" content="' + safeImg + '">';

  // Two distinct chrome treatments:
  //   - Artifact cluster (AI public pages): leans into the artifact
  //     framing — left says "Generated by AI Netscape · Top Sites",
  //     right surfaces engagement (Upvote / Votes / Hits / Share /
  //     Report) so visitors can act on the work in front of them
  //     rather than navigate to platform pages.
  //   - Platform cluster (else): standard nav cluster (Gallery ·
  //     Terms · Privacy · Copyright · FAQ) bottom-left, no right
  //     side. WYSIWYG hand-edited pages and any non-public AI
  //     pages fall here.
  const isArtifact = !!(doc && doc.source === 'ai' && doc.is_public !== false);
  const badge = isArtifact
    ? renderArtifactCluster(slug)
    : renderPlatformCluster();

  // GA4 page_view tracking for /p/[slug]. ga.js is built at deploy time:
  // a real bootstrap when GA_MEASUREMENT_ID is set, or a `window.gtag`
  // no-op stub when it isn't. Loaded with defer so it executes before
  // artifact-cluster.js (document order is execution order under defer),
  // which lets the cluster's share / upvote / report events actually
  // reach GA instead of being swallowed by its try/catch.
  const gaScript = '<script src="https://ainetscape.com/ga.js" defer></script>';
  const tail = gaScript + badge;

  let out = html;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, ogTags + '</head>');
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, m => m + ogTags);
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, tail + '</body>');
  } else {
    out += tail;
  }
  return out;
}

// ============================================================
// Artifact cluster — shown on public AI-generated /p/[slug] pages.
// Left attributes the page back to AI Netscape and invites to Top
// Sites (the same /gallery, framed for a visitor-from-share);
// right surfaces upvote / votes / hits / share / report so the
// visitor can engage with the artifact in front of them.
//
// Right cluster is rendered as a SKELETON — vote/hit counts and the
// SOTW flag aren't in the cached HTML body. artifact-cluster.js
// hydrates them on load via GET /api/page/[slug]/stats, so the body
// stays immutable (24h edge cache) while counts and the SOTW state
// stay fresh on every view. Interaction wiring also lives in
// artifact-cluster.js (upvote / share / report); share dialog
// delegates to the shared /share-dialog.js module (single source of
// truth with the homepage editor's Share toolbar).
// ============================================================
function renderArtifactCluster(slug) {
  // Container background pill — same period treatment as the
  // platform cluster (white wash, thin grey border).
  const pillBase =
    'position:fixed; bottom:12px; z-index:2147483647; ' +
    'font:11px \'MS Sans Serif\',Tahoma,sans-serif; ' +
    'background:rgba(255,255,255,0.92); padding:5px 10px; ' +
    'border:1px solid #888; display:flex; align-items:center; gap:8px;';

  // Left cluster is now just the attribution link — Top Sites moves
  // to the right cluster so the engagement and navigation actions
  // all live in one place visitors can scan.
  const left =
    '<div style="' + pillBase + ' left:12px;">' +
      '<a href="https://ainetscape.com/?ref=share" ' +
        'style="color:#000080;text-decoration:underline;">&#129302; AI Netscape</a>' +
    '</div>';

  const upvoteBtnCss =
    'font:11px \'MS Sans Serif\',Tahoma,sans-serif; color:#000; ' +
    'background:#c0c0c0; border:2px solid; ' +
    'border-color:#fff #404040 #404040 #fff; ' +
    'padding:1px 9px 2px; cursor:pointer; line-height:1.2;';
  const linkCss = 'color:#000080;text-decoration:underline;cursor:pointer;background:none;border:none;padding:0;font:inherit;';
  // SOTW skeleton is hidden by default; the stats fetch reveals it
  // when the row currently holds the site_of_the_week field.
  const sotwSkeleton =
    '<span data-sotw hidden>' +
      '<span style="color:#000080; font-weight:bold; letter-spacing:0.03em;">' +
        '&#9733; Site of the Week</span>' +
      '<span style="color:#666; margin-left:8px;">&middot;</span>' +
    '</span>';
  const right =
    '<div data-artifact-cluster data-slug="' + escapeAttr(slug) + '" ' +
      'style="' + pillBase + ' right:12px;">' +
      sotwSkeleton +
      '<button type="button" data-action="upvote" ' +
        'style="' + upvoteBtnCss + '" title="Cool vote">&#9650; Upvote</button>' +
      '<span style="color:#333;">Votes: <span data-vote-count>&mdash;</span></span>' +
      '<span style="color:#333;">Hits: <span data-hit-count>&mdash;</span></span>' +
      '<button type="button" data-action="share" style="' + linkCss + '">Share</button>' +
      '<button type="button" data-action="report" style="' + linkCss + '">Report</button>' +
      '<a href="https://ainetscape.com/gallery" ' +
        'style="color:#000080;text-decoration:underline;">Top Sites</a>' +
    '</div>';

  // share-dialog.js must load before artifact-cluster.js so
  // window.AINetscape.shareDialog is defined when the Share handler
  // runs. `defer` preserves document order, so the source order
  // here is the load order.
  const scripts =
    '<script src="https://ainetscape.com/share-dialog.js" defer></script>' +
    '<script src="https://ainetscape.com/artifact-cluster.js" defer></script>';

  return left + right + scripts;
}

// ============================================================
// Platform cluster — the standard AI Netscape nav, all left-side.
// Shown on /p/[slug] for WYSIWYG hand-edited pages and any
// non-public AI pages. AI Netscape's own surfaces (homepage,
// /gallery, /terms, /privacy, /copyright, /faq, 404) have their
// own status-bar nav inside the window chrome and don't go
// through this code path.
// ============================================================
function renderPlatformCluster() {
  return '<div style="position:fixed; bottom:12px; left:12px; z-index:2147483647; ' +
    'font:10px \'MS Sans Serif\',Tahoma,sans-serif; line-height:1.5; ' +
    'background:rgba(255,255,255,0.9); padding:4px 10px; ' +
    'border:1px solid #888;">' +
      '<a href="https://ainetscape.com/gallery"   style="color:#000080;text-decoration:underline;">Top Sites</a>' +
      '<span style="color:#666;margin:0 7px;">·</span>' +
      '<a href="https://ainetscape.com/terms"     style="color:#000080;text-decoration:underline;">Terms</a>' +
      '<span style="color:#666;margin:0 7px;">·</span>' +
      '<a href="https://ainetscape.com/privacy"   style="color:#000080;text-decoration:underline;">Privacy</a>' +
      '<span style="color:#666;margin:0 7px;">·</span>' +
      '<a href="https://ainetscape.com/copyright" style="color:#000080;text-decoration:underline;">Copyright</a>' +
      '<span style="color:#666;margin:0 7px;">·</span>' +
      '<a href="https://ainetscape.com/faq"       style="color:#000080;text-decoration:underline;">FAQ</a>' +
    '</div>';
}

function escapeAttr(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

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
