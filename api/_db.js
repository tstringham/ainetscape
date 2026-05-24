// /api/_db.js
//
// Optional MongoDB logging helper. Imported lazily by generate.js, and
// only when MONGODB_URI is set — if it isn't, this module never loads.
// Files prefixed with "_" are not routed as endpoints by Vercel.
//
// Anonymized by design: the raw IP is never stored, only a salted hash.

import { MongoClient } from 'mongodb';
import crypto from 'crypto';

let client;
let db;

const IP_SALT = process.env.IP_HASH_SALT || 'ainetscape-default-salt-change-me';
const DB_NAME = process.env.MONGODB_DB || 'ainetscape';

async function getDb() {
  if (db) return db;
  client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 5 });
  await client.connect();
  db = client.db(DB_NAME);
  // Ensure the share_slug index exists for fast /p/:slug lookup.
  // Sparse so older rows without a slug aren't included.
  try {
    await db.collection('generations').createIndex(
      { share_slug: 1 },
      { sparse: true, name: 'share_slug_idx' }
    );
  } catch (_) { /* index may already exist; ignore */ }
  return db;
}

// Look up a generation by its share slug for /api/page/[slug] serving.
export async function findBySlug(slug) {
  if (!slug) return null;
  const d = await getDb();
  return d.collection('generations').findOne({ share_slug: slug });
}

// ============================================================
// Two-stage write helpers — fix for the recurring /p/:slug 404.
// ============================================================
// insertPagePlaceholder writes a minimal row at request start with the
// share_slug already populated. The /api/generate handler only sets the
// X-AINetscape-Share-Slug response header if THIS call succeeds, so a
// dead Mongo never produces a dead share link the client thinks is live.
//
// completePageRow updates that same row at stream end with body_html,
// page_title, the final event type, and the rest of the analytics fields.
// If THIS call fails, the row stays in 'ai_generation_pending' with
// no body, and /api/page/[slug] serves the in-character 404 page
// (its existing `if (!doc.body_html) → 404` check covers this).
// ============================================================

export async function insertPagePlaceholder({
  ip, share_slug, author_token_hash, brief, ref, referrer, user_agent
}) {
  const d = await getDb();
  const doc = {
    ts: new Date(),
    event: 'ai_generation_pending',     // upgraded by completePageRow
    kind: 'generate',
    ip_hash: hashIp(ip),
    share_slug: String(share_slug),
    author_token_hash: author_token_hash || null,
    source: 'ai',
    is_public: true,
    upvotes: 0,
    hits: 0,
    // Briefs stored eagerly so abuse review works even when the body
    // never arrives (placeholder-then-disconnect case).
    brief_length: brief ? brief.length : 0,
    brief_preview: brief ? brief.slice(0, 100) : '',
    brief_full: brief ? String(brief) : null,
    referrer: referrer ? String(referrer).slice(0, 200) : null,
    utm_ref: ref ? String(ref).slice(0, 40) : null,
    user_agent: user_agent ? String(user_agent).slice(0, 200) : null
  };
  await d.collection('generations').insertOne(doc);
}

export async function completePageRow({
  share_slug, event, body_html, page_title, data, duration_ms, verdict
}) {
  if (!share_slug) throw new Error('completePageRow requires share_slug');
  const d = await getDb();
  const setFields = {
    event: event || 'ai_generation_completed',
    completed_at: new Date()
  };
  if (body_html) {
    setFields.body_html = String(body_html);
    setFields.body_size_bytes = setFields.body_html.length;
  }
  if (page_title) setFields.page_title = String(page_title).slice(0, 200);
  if (data && data.model) setFields.model = data.model;
  if (data && data.usage) {
    setFields.input_tokens = data.usage.input_tokens || 0;
    setFields.output_tokens = data.usage.output_tokens || 0;
  }
  if (typeof duration_ms === 'number') setFields.duration_ms = duration_ms;
  if (verdict) setFields.verdict = String(verdict).slice(0, 200);
  await d.collection('generations').updateOne(
    { share_slug: String(share_slug) },
    { $set: setFields }
  );
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + String(ip)).digest('hex').slice(0, 16);
}

export async function logEvent({
  ip, event, kind, brief, data, ref, forceBuild, duration_ms,
  referrer, user_agent, verdict, body_html, share_slug,
  // Gallery fields — additive, backwards-compat. Older rows that lack
  // these fields are treated as public-by-default in gallery queries.
  page_title, author_token_hash, source, is_public
}) {
  const d = await getDb();
  const doc = {
    ts: new Date(),
    // Granular event type for funnel analytics:
    //   ai_generation_completed | ai_refused | ai_generation_failed |
    //   ai_disconnected | ai_cancelled | ai_timeout
    event: event || 'ai_generation_completed',
    // Back-compat discriminator; older entries used this.
    kind: kind || 'generate',
    ip_hash: hashIp(ip),                                  // SHA-256 of IP+salt; never the raw IP
    brief_length: brief ? brief.length : 0,
    brief_preview: brief ? brief.slice(0, 100) : '',      // legacy quick-scan field
    brief_full: brief ? String(brief) : null,             // full brief text (up to MAX_BRIEF_LENGTH)
    model: (data && data.model) || null,
    output_tokens: (data && data.usage && data.usage.output_tokens) || 0,
    input_tokens: (data && data.usage && data.usage.input_tokens) || 0,
    duration_ms: duration_ms || 0,
    referrer: referrer ? String(referrer).slice(0, 200) : null,
    utm_ref: ref ? String(ref).slice(0, 40) : null,       // 'marc', 'a16z', 'tw', 'hn', etc.
    user_agent: user_agent ? String(user_agent).slice(0, 200) : null
  };
  if (forceBuild !== undefined) doc.force_build = !!forceBuild;
  if (verdict) doc.verdict = String(verdict).slice(0, 200);
  if (body_html) {
    // Archive the generated page (or REFUSED line, or partial body). Lets us
    // browse the gallery of what people are creating and review for abuse.
    doc.body_html = String(body_html);
    doc.body_size_bytes = doc.body_html.length;
  }
  if (share_slug) doc.share_slug = String(share_slug);

  // ---- Gallery fields (Phase 1) ----
  if (page_title) doc.page_title = String(page_title).slice(0, 200);
  if (author_token_hash) doc.author_token_hash = String(author_token_hash);
  // source discriminates AI generations (gallery-eligible) from a
  // hypothetical future WYSIWYG-save flow (never appears in gallery).
  doc.source = source || 'ai';
  // isPublic defaults true on insert; the spec's "Make site public"
  // checkbox in the share dialog defaults to checked. Author can later
  // PATCH to false via the verify-author endpoint (Phase 5).
  doc.is_public = (is_public === false) ? false : true;
  // Counters initialized at 0; /api/vote and /api/hit (Phase 3) use $inc.
  doc.upvotes = 0;
  doc.hits = 0;

  await d.collection('generations').insertOne(doc);
}
