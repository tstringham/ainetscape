// /api/premises.js
//
// GET /api/premises — the AI Composer chip catalogue.
//
// The list used to live only in public/index.html, which meant every wording
// change was a deploy. It lives in Mongo now and this serves it.
//
// **index.html still ships the whole catalogue as a fallback, on purpose.** The
// homepage is a static file on a CDN and the chips have to be there the instant
// the dialog opens; a composer showing nothing because a database was slow is
// worse than one showing a slightly stale list. So this is an upgrade path, not
// a dependency — the client renders from the baked list immediately and swaps
// in whatever this returns, if it returns.
//
// Consequence worth stating: a premise deleted from the database keeps
// appearing until the next deploy rebuilds the fallback. Retiring one for real
// means setting `retired: true` AND removing it from index.html. Two places,
// which is the price of the list being available before the network is.

import { listComposerPremises } from './_db.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('Allow', 'GET, HEAD');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  // Anyone may read this: it is the same text the homepage already ships.
  res.setHeader('Access-Control-Allow-Origin', '*');

  let rows = [];
  try {
    rows = await listComposerPremises();
  } catch (err) {
    // An empty list is a valid answer here. The client keeps its baked-in
    // catalogue and the visitor never learns the database had a moment.
    console.error('[premises] query failed:', err && err.message);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ premises: [] });
  }

  // Fifteen minutes at the CDN. Long enough that this costs nothing at any
  // plausible traffic level, short enough that an edit shows up while the
  // person who made it is still looking at the page.
  res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=900, stale-while-revalidate=3600');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method === 'HEAD') return res.status(200).end();
  return res.status(200).json({ premises: rows });
}
