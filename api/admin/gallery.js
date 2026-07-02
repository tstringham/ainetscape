// /api/admin/gallery.js
//
// Admin-only gallery management: LIST the public (or hidden) gallery rows and
// HIDE / RESTORE a row by flipping is_public. This is a HIDE-only control — it
// never hard-deletes; the row stays in Mongo and can be restored. Hiding sets
// is_public:false, which the page handler already 404s on and which drops the
// row from the gallery feed.
//
// Auth: the same shared-secret header as the other admin surfaces
// (x-admin-token === ADMIN_EDIT_TOKEN). Refuses if the token is unset so a
// misconfigured deploy can't accept any token.
//
// GET  /api/admin/gallery?page=N&hidden=0|1
//   → { rows:[{share_slug,page_title,upvotes,hits,ts,is_public}], page, hasMore, hidden }
//   Bounded reads: fetches PAGE_SIZE+1 to detect hasMore (no full-collection count).
//
// POST /api/admin/gallery   Body: { slug, action: 'hide' | 'restore' }
//   → { ok, slug, is_public }.  No 'delete' action exists.

import { listGalleryRowsAdmin, setPagePublic } from '../_db.js';

const PAGE_SIZE = 50;

export default async function handler(req, res) {
  const expected = process.env.ADMIN_EDIT_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'store_unavailable' });
  }

  if (req.method === 'GET') {
    const hidden = String(req.query.hidden || '') === '1';
    let page = parseInt(req.query.page, 10);
    if (!Number.isFinite(page) || page < 0) page = 0;
    try {
      const rows = await listGalleryRowsAdmin({ hidden, skip: page * PAGE_SIZE, limit: PAGE_SIZE + 1 });
      const hasMore = rows.length > PAGE_SIZE;
      return res.status(200).json({ rows: rows.slice(0, PAGE_SIZE), page, hasMore, hidden });
    } catch (err) {
      console.error('[admin/gallery] GET failed:', err);
      return res.status(500).json({ error: 'read_failed', detail: String((err && err.message) || err) });
    }
  }

  if (req.method === 'POST') {
    const slug = req.body && req.body.slug;
    const action = req.body && req.body.action;
    if (!slug || (action !== 'hide' && action !== 'restore')) {
      return res.status(400).json({ error: 'slug_and_action_required', hint: "action must be 'hide' or 'restore'" });
    }
    try {
      const isPublic = action === 'restore';
      const r = await setPagePublic(slug, isPublic);
      if (!r.matched) return res.status(404).json({ error: 'slug_not_found', slug });
      return res.status(200).json({ ok: true, slug, is_public: isPublic });
    } catch (err) {
      console.error('[admin/gallery] POST failed:', err);
      return res.status(500).json({ error: 'write_failed', detail: String((err && err.message) || err) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}
