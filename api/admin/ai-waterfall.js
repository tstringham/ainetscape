// /api/admin/ai-waterfall.js
//
// Admin-only read/write of the AI provider waterfall (settings.aiWaterfall in
// Mongo). Config edits ONLY — this endpoint can reorder / swap / enable the
// provider rungs and nothing else. It does NOT (and must not) trigger shells,
// deploys, or generation.
//
// Auth: the same shared-secret header as api/admin/edit-page.js. Set
// ADMIN_EDIT_TOKEN in Vercel env; the endpoint refuses if it is unset so a
// misconfigured deploy can't accept any token.
//
// GET  /api/admin/ai-waterfall
//   → { order:[{provider,model,enabled,knownProvider,knownModel,keyPresent}],
//       providers:[{id,label,models,keyPresent}], usingDefault:bool }
//   (API key VALUES are never returned — only presence booleans.)
//
// POST /api/admin/ai-waterfall   Body: { order:[{provider,model,enabled}] }
//   → validates every rung against the provider/model allow-list, persists,
//     and returns the re-annotated state. 400 on an unknown provider/model.

import {
  PROVIDERS, DEFAULT_WATERFALL,
  annotateWaterfall, validateWaterfall
} from '../_ai_providers.js';
import { getAiWaterfall, setAiWaterfall } from '../_db.js';

// Provider catalog for the admin UI — id, admin-only label, the model
// allow-list, and whether a key is present. No secret values.
function providerCatalog() {
  return Object.values(PROVIDERS).map((p) => ({
    id: p.id,
    label: p.label,
    models: p.models,
    keyPresent: p.envKeys.some((k) => !!process.env[k])
  }));
}

export default async function handler(req, res) {
  const expected = process.env.ADMIN_EDIT_TOKEN;
  const provided = req.headers['x-admin-token'];
  if (!expected || !provided || provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!process.env.MONGODB_URI) {
    return res.status(503).json({ error: 'settings_store_unavailable' });
  }

  if (req.method === 'GET') {
    try {
      const stored = await getAiWaterfall();
      const order = (Array.isArray(stored) && stored.length) ? stored : DEFAULT_WATERFALL;
      return res.status(200).json({
        usingDefault: !(Array.isArray(stored) && stored.length),
        order: annotateWaterfall(order),
        providers: providerCatalog()
      });
    } catch (err) {
      console.error('[admin/ai-waterfall] GET failed:', err);
      return res.status(500).json({ error: 'read_failed', detail: String((err && err.message) || err) });
    }
  }

  if (req.method === 'POST') {
    const order = req.body && req.body.order;
    const v = validateWaterfall(order);
    if (!v.ok) {
      return res.status(400).json({ error: 'invalid_order', detail: v.error });
    }
    try {
      await setAiWaterfall(v.normalized);
      return res.status(200).json({
        ok: true,
        order: annotateWaterfall(v.normalized),
        providers: providerCatalog()
      });
    } catch (err) {
      console.error('[admin/ai-waterfall] POST failed:', err);
      return res.status(500).json({ error: 'write_failed', detail: String((err && err.message) || err) });
    }
  }

  res.setHeader('Allow', 'GET, POST');
  return res.status(405).json({ error: 'method_not_allowed' });
}
