// /api/sitemap.xml.js
//
// GET /sitemap.xml — every page worth finding.
//
// Generated rather than committed, because the set changes every time somebody
// presses AI Composer and a file on disk would be stale by the next page. The
// rewrite in vercel.json maps /sitemap.xml here so the URL is the one crawlers
// look for rather than an API path nobody would guess.
//
// What goes in, and what deliberately does not:
//
//   - The homepage, the gallery, and the four legal/FAQ pages. Fixed, curated,
//     and the surfaces worth ranking for the site's own name.
//   - Every public AI page, newest first. These carry the content -- about 225
//     words of prose each, ~17,000 across the corpus -- and until 20 September
//     none of it was visible to a crawler at all.
//
//   - NOT the /p/:slug/stats endpoints, the API, or anything behind the admin
//     token. A sitemap is a statement that a URL is worth indexing, and an
//     endpoint that answers JSON is not.
//   - NOT pages an author has made private. `is_public: false` means it stays
//     out of the gallery, and a sitemap that contradicted that would leak a
//     page the author withdrew.
//
// `lastmod` comes from the row's own completion time. It is a claim a crawler
// can check against the document, so it must be true rather than "now".

import { findGalleryPages } from './_db.js';

const ORIGIN = 'https://ainetscape.com';

// A sitemap may hold 50,000 URLs; this cap is about response time and memory on
// a 10-second function, not the protocol. If the gallery ever approaches it the
// answer is a sitemap index, not a bigger number here.
const MAX_PAGES = 5000;

// Escaping for XML text. Five characters, and `&` first or the others get
// double-escaped -- the ampersand in an already-escaped entity would be caught
// by a later pass.
function xmlEscape(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function urlEntry({ loc, lastmod, changefreq, priority }) {
  return '<url>' +
    '<loc>' + xmlEscape(loc) + '</loc>' +
    (lastmod ? '<lastmod>' + xmlEscape(lastmod) + '</lastmod>' : '') +
    (changefreq ? '<changefreq>' + changefreq + '</changefreq>' : '') +
    (priority ? '<priority>' + priority + '</priority>' : '') +
    '</url>';
}

/** W3C datetime, date-only. A generated page does not change after publish, so
 *  the hour would be noise a crawler might treat as churn. */
function isoDate(d) {
  const t = d instanceof Date ? d : new Date(d);
  return Number.isNaN(t.getTime()) ? null : t.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const entries = [
    { loc: ORIGIN + '/', changefreq: 'daily', priority: '1.0' },
    { loc: ORIGIN + '/gallery', changefreq: 'daily', priority: '0.9' },
    { loc: ORIGIN + '/faq', changefreq: 'monthly', priority: '0.5' },
    { loc: ORIGIN + '/terms', changefreq: 'yearly', priority: '0.3' },
    { loc: ORIGIN + '/privacy', changefreq: 'yearly', priority: '0.3' },
    { loc: ORIGIN + '/copyright', changefreq: 'yearly', priority: '0.3' }
  ];

  try {
    const pages = await findGalleryPages({ sort: 'recent', skip: 0, limit: MAX_PAGES });
    for (const p of pages) {
      const slug = p.share_slug;
      if (!slug) continue;
      entries.push({
        loc: ORIGIN + '/p/' + slug,
        lastmod: isoDate(p.completed_at || p.ts),
        // A published page's content is fixed. Saying otherwise invites a
        // crawler to keep coming back for a document that will never differ.
        changefreq: 'yearly',
        priority: '0.7'
      });
    }
  } catch (err) {
    // A sitemap listing only the curated pages is a correct, smaller sitemap.
    // Returning a 500 would tell a crawler the whole file is broken and can
    // cost the six URLs that always work.
    console.error('[sitemap] gallery query failed:', err && err.message);
  }

  const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">' +
    entries.map(urlEntry).join('') +
    '</urlset>';

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  // An hour. New pages should appear without a deploy, and a crawler that
  // fetches this twice in a morning should not pay for a Mongo query each time.
  res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=3600');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(xml);
}
