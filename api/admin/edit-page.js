// /api/admin/edit-page.js
//
// Admin-only endpoint to overwrite the body_html on an existing share row.
// Used to retrofit pages built before image support landed.
//
// Auth: shared-secret header. Set ADMIN_EDIT_TOKEN in Vercel env. The
// endpoint refuses if the env var is unset, so a misconfigured production
// can't accidentally accept any token (including "").
//
// POST /api/admin/edit-page
// Header:  x-admin-token: <ADMIN_EDIT_TOKEN>
// Body:    { "slug": "...", "body_html": "...", "page_title"?: "..." }

import { updatePageBody } from '../_db.js';

export const config = {
  api: {
    bodyParser: { sizeLimit: '2mb' }  // pages can run ~50-200KB; 2mb leaves headroom
  }
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'method_not_allowed' });
  }

  const expected = process.env.ADMIN_EDIT_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  const { slug, body_html, page_title } = req.body || {};
  if (!slug || !body_html) {
    return res.status(400).json({ error: 'slug_and_body_html_required' });
  }

  try {
    const matched = await updatePageBody({ slug, body_html, page_title });
    if (!matched) {
      return res.status(404).json({ error: 'slug_not_found', slug });
    }
    return res.status(200).json({
      ok: true,
      slug,
      bytes: String(body_html).length,
      page_title: page_title || null
    });
  } catch (err) {
    console.error('[admin/edit-page] failed:', err);
    return res.status(500).json({
      error: 'update_failed',
      detail: String((err && err.message) || err)
    });
  }
}
