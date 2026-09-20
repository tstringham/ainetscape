// /api/page/[slug]/raw.js
//
// GET /p/<slug>/raw — the generated document itself, at a URL of its own.
//
// This exists to solve indexing without touching the design.
//
// The page used to go into the frame as `srcdoc`, and a srcdoc document has no
// URL: crawlers do not index iframe content as part of the parent, and there is
// nothing else for them to fetch. So every published page presented Google the
// same 88 words of Netscape chrome and nothing else.
//
// The first attempt at fixing that rendered a plain-text copy of the content
// below the window. It worked and it was ugly -- a second, unstyled version of
// the page stapled underneath the real one. The right answer is that the
// document should simply have an address. Give the iframe a real `src` and the
// content becomes an ordinary crawlable document; point a canonical from here
// back at /p/<slug> and the ranking consolidates onto the framed page a visitor
// should actually land on.
//
// **The sandbox is preserved by a header, not by luck.** Under srcdoc the
// document ran in an opaque origin because the iframe said so. At a real
// same-origin URL it would otherwise run AS ainetscape.com -- model-authored
// JavaScript with access to our cookies and storage, which is a security
// regression dressed up as an SEO win. `Content-Security-Policy: sandbox`
// restores the opaque origin for every route into this document, including a
// visitor who types the URL directly. Scripts still run, so the calculators and
// forms that make these pages worth reading still work.

import { findBySlug } from '../../_db.js';

const VALID_SLUG = /^[A-Za-z0-9]{6,20}$/;

// Same allowances the iframe grants, expressed as a header so they hold when
// the document is loaded on its own. Deliberately NO allow-same-origin: that
// single token is the difference between an isolated document and one with our
// origin's keys.
const SANDBOX = 'sandbox allow-scripts allow-forms allow-modals allow-popups ' +
  'allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const slug = String((req.query && req.query.slug) || '').trim();
  if (!VALID_SLUG.test(slug)) return res.status(404).send('Not found');

  let doc;
  try {
    doc = await findBySlug(slug);
  } catch (err) {
    console.error('[raw] lookup failed for', slug, err && err.message);
    return res.status(503).send('Temporarily unavailable');
  }

  if (!doc || !doc.body_html) return res.status(404).send('Not found');
  // A page its author withdrew must not remain reachable here just because this
  // route is newer than the switch that withdrew it.
  if (doc.is_public === false) return res.status(404).send('Not found');

  const { prepareDocument } = await import('./index.js');
  let html = prepareDocument(doc.body_html, slug);

  /*
   * Canonical, and it is the whole reason this is safe to expose.
   *
   * Without it Google would be free to rank /p/<slug>/raw -- the bare document,
   * no chrome, no gallery, no upvote -- ahead of the page a reader should land
   * on. With it, this URL is crawled, its content is attributed to /p/<slug>,
   * and a searcher arrives at the framed page.
   */
  const canonical = '<link rel="canonical" href="https://ainetscape.com/p/' +
    encodeURIComponent(slug) + '">';
  if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + canonical);
  else html = canonical + html;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Content-Security-Policy', SANDBOX);
  // A published page does not change. Same lifetime the framed page uses.
  res.setHeader('Cache-Control', 'public, max-age=86400');
  // Belt and braces: this document is meant to be framed by us and crawled,
  // never embedded elsewhere.
  res.setHeader('X-Robots-Tag', 'index, follow');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).send(html);
}
