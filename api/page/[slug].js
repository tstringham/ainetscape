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

import { getCallerIp, rateLimit } from '../_shared.js';

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
    const { findBySlug } = await import('../_db.js');
    const doc = await findBySlug(slug);
    if (!doc || !doc.body_html) {
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

  const ogTags =
    '<meta property="og:type" content="website">' +
    '<meta property="og:url" content="' + escapeAttr(shareUrl) + '">' +
    '<meta property="og:title" content="' + safeTitle + '">' +
    '<meta property="og:description" content="Made with AI Netscape — a 1997 HTML editor with one anachronistic button.">' +
    '<meta property="og:image" content="https://ainetscape.com/og-image.png">' +
    '<meta property="og:image:width" content="1200">' +
    '<meta property="og:image:height" content="630">' +
    '<meta name="twitter:card" content="summary_large_image">' +
    '<meta name="twitter:title" content="' + safeTitle + '">' +
    '<meta name="twitter:description" content="Made with AI Netscape.">' +
    '<meta name="twitter:image" content="https://ainetscape.com/og-image.png">';

  const badge =
    '<a href="https://ainetscape.com?ref=share" target="_blank" rel="noopener noreferrer" ' +
    'style="position:fixed; bottom:12px; right:12px; padding:6px 12px; ' +
    'background:linear-gradient(180deg,#ff44ff 0%,#cc00ff 50%,#00ccff 100%); ' +
    'color:#000; font:bold 11px \'MS Sans Serif\',Tahoma,sans-serif; ' +
    'text-decoration:none; border:2px solid; ' +
    'border-color:#ffff00 #ff00ff #ff00ff #ffff00; ' +
    'box-shadow:2px 2px 0 rgba(0,0,0,0.4); z-index:2147483647; ' +
    'letter-spacing:0.02em;">' +
    'Made with AI Netscape ✦</a>';

  let out = html;
  if (/<\/head>/i.test(out)) {
    out = out.replace(/<\/head>/i, ogTags + '</head>');
  } else if (/<head[^>]*>/i.test(out)) {
    out = out.replace(/<head[^>]*>/i, m => m + ogTags);
  }
  if (/<\/body>/i.test(out)) {
    out = out.replace(/<\/body>/i, badge + '</body>');
  } else {
    out += badge;
  }
  return out;
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
