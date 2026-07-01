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
  // Indexes. createIndex is idempotent — safe to call on every cold start.
  try {
    await db.collection('generations').createIndex(
      { share_slug: 1 },
      { sparse: true, name: 'share_slug_idx' }
    );
    // Gallery queries filter on (source, event, is_public) and sort by
    // either ts desc (Recent) or upvotes desc then ts desc (Upvotes).
    // Two indexes — one per sort order — keep both queries fast.
    await db.collection('generations').createIndex(
      { source: 1, event: 1, is_public: 1, ts: -1 },
      { name: 'gallery_recent_idx' }
    );
    await db.collection('generations').createIndex(
      { source: 1, event: 1, is_public: 1, upvotes: -1, ts: -1 },
      { name: 'gallery_upvotes_idx' }
    );
    // Site-of-the-week lookup hits this every gallery render. Sparse so
    // it only indexes the (typically 0 or 1) currently-set rows.
    await db.collection('generations').createIndex(
      { site_of_the_week: 1 },
      { sparse: true, name: 'site_of_the_week_idx' }
    );
    // Unsplash query → photo metadata cache. TTL expires entries 24h
    // after write so we re-query Unsplash periodically (results shift
    // as their catalog grows) without burning the API on hot queries.
    await db.collection('unsplashCache').createIndex(
      { cachedAt: 1 },
      { expireAfterSeconds: 24 * 60 * 60, name: 'unsplash_ttl_idx' }
    );
  } catch (_) { /* index may already exist; ignore */ }

  // Part B — publish-time uniqueness. PARTIAL unique index on contentHash:
  // unique only where the field EXISTS, so legacy rows without a hash never
  // collide on a missing value. Built in its own guard: if it fails (e.g.
  // pre-existing duplicate hashes), REPORT loudly and continue — never drop or
  // mutate data. The publish path also pre-checks via findByContentHash, so
  // dedup still works even if the index can't build.
  try {
    await db.collection('generations').createIndex(
      { contentHash: 1 },
      {
        unique: true,
        partialFilterExpression: { contentHash: { $exists: true } },
        name: 'content_hash_unique_idx'
      }
    );
  } catch (err) {
    console.error('[CRITICAL] content_hash_unique_idx failed to build — likely',
      'pre-existing duplicate contentHash values. NOT dropping/mutating data.',
      'err:', err && (err.message || err));
  }

  return db;
}

// Look up a generation by its share slug for /api/page/[slug] serving.
export async function findBySlug(slug) {
  if (!slug) return null;
  const d = await getDb();
  return d.collection('generations').findOne({ share_slug: slug });
}

// Part B — publish-time dedup pre-check: any existing row sharing this
// structural contentHash? Returns the colliding row's slug (or null). Global
// (every row that has the field), matching the partial unique index above.
export async function findByContentHash(hash) {
  if (!hash) return null;
  const d = await getDb();
  return d.collection('generations').findOne(
    { contentHash: String(hash) },
    { projection: { share_slug: 1, _id: 0 } }
  );
}

// ---- Gallery queries ----
// Only fully-completed, public AI generations enter the gallery. Older
// rows that pre-date is_public default-true at write time; the
// `{ $ne: false }` predicate treats missing field as public.
const GALLERY_FILTER = {
  source: 'ai',
  event: 'ai_generation_completed',
  is_public: { $ne: false },
  // Require a page_title and body — guards against rows whose completion
  // update failed (stage 2 of the two-stage write).
  page_title: { $exists: true, $nin: [null, ''] },
  body_html:  { $exists: true, $nin: [null, ''] }
};
const GALLERY_PROJECTION = {
  share_slug: 1, page_title: 1, upvotes: 1, hits: 1, ts: 1, _id: 0
};

// Three sort modes: 'recent' (latest first), 'week' (last 7 days by upvotes),
// 'all' (lifetime by upvotes). Legacy 'upvotes' is treated as an alias for
// 'all' so old shared URLs (?sort=upvotes) keep resolving.
function galleryQueryFor(sort) {
  const upvoteSort = { upvotes: -1, ts: -1 };
  switch (String(sort || '').toLowerCase()) {
    case 'week': {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      return {
        filter: { ...GALLERY_FILTER, ts: { $gte: sevenDaysAgo } },
        sortSpec: upvoteSort
      };
    }
    case 'all':
    case 'upvotes':
      return { filter: GALLERY_FILTER, sortSpec: upvoteSort };
    case 'recent':
    default:
      return { filter: GALLERY_FILTER, sortSpec: { ts: -1 } };
  }
}

export async function findGalleryPages({ sort = 'recent', skip = 0, limit = 24 }) {
  const d = await getDb();
  const { filter, sortSpec } = galleryQueryFor(sort);
  return d.collection('generations')
    .find(filter, { projection: GALLERY_PROJECTION })
    .sort(sortSpec)
    .skip(Math.max(0, skip))
    .limit(Math.max(1, Math.min(100, limit)))
    .toArray();
}

// Sort-aware so the 'week' tab's pagination reflects just last-7-day rows
// rather than the lifetime total.
export async function countGalleryPages(sort = 'recent') {
  const d = await getDb();
  const { filter } = galleryQueryFor(sort);
  return d.collection('generations').countDocuments(filter);
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
  share_slug, event, body_html, page_title, data, duration_ms, verdict, contentHash
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
  if (contentHash) setFields.contentHash = String(contentHash);
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

// Admin-only: overwrite body_html on an existing row. Used to retrofit
// pages built before image support landed. Auth lives in the endpoint.
export async function updatePageBody({ slug, body_html, page_title }) {
  if (!slug || !body_html) throw new Error('updatePageBody requires slug and body_html');
  const d = await getDb();
  const setFields = {
    body_html: String(body_html),
    body_size_bytes: String(body_html).length,
    edited_at: new Date()
  };
  if (page_title) setFields.page_title = String(page_title).slice(0, 200);
  const r = await d.collection('generations').updateOne(
    { share_slug: String(slug) },
    { $set: setFields }
  );
  return (r.matchedCount || 0) > 0;
}

// ============================================================
// Site of the Week — weekly cron picks one winning page based on
// last-7-days upvote counts, sets site_of_the_week to the pick time,
// and clears the field from any previously-winning row. The gallery
// renders a feature box at the top for whichever row currently holds
// the field; /p/[slug] adds a small badge to the winning page.
// ============================================================

// Top upvotes among public AI pages from the last 7 days that aren't
// flagged. Ties broken by ts desc (most recent among tied vote counts).
// Returns null when no candidate qualifies (zero-vote weeks, fresh
// install) — the cron treats that as "no winner this week" and skips
// the mark step entirely, which is the spec'd empty-state behavior.
export async function findSiteOfTheWeekCandidate() {
  const d = await getDb();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  return d.collection('generations').findOne(
    {
      source: 'ai',
      event: 'ai_generation_completed',
      is_public: { $ne: false },
      flagged: { $ne: true },
      ts: { $gte: sevenDaysAgo },
      page_title: { $exists: true, $nin: [null, ''] },
      body_html:  { $exists: true, $nin: [null, ''] },
      upvotes: { $gt: 0 }
    },
    {
      sort: { upvotes: -1, ts: -1 },
      projection: { share_slug: 1, page_title: 1, upvotes: 1, hits: 1, ts: 1, _id: 0 }
    }
  );
}

// Unset on every currently-set row. Returns the number cleared so the
// cron can log the transition (usually 0 or 1, but updateMany is the
// safe form in case more than one row ever ends up flagged).
export async function clearAllSiteOfTheWeek() {
  const d = await getDb();
  const result = await d.collection('generations').updateMany(
    { site_of_the_week: { $exists: true, $ne: null } },
    { $set: { site_of_the_week: null } }
  );
  return result.modifiedCount || 0;
}

export async function markSiteOfTheWeek(slug) {
  if (!slug) return false;
  const d = await getDb();
  const r = await d.collection('generations').updateOne(
    { share_slug: String(slug) },
    { $set: { site_of_the_week: new Date() } }
  );
  return (r.modifiedCount || 0) > 0;
}

// One winner at a time; the gallery and the /p/[slug] badge both call
// this. Filtered the same way as the gallery feed so a row that's been
// hidden after winning doesn't keep showing as the featured page.
export async function findCurrentSiteOfTheWeek() {
  const d = await getDb();
  return d.collection('generations').findOne(
    {
      site_of_the_week: { $exists: true, $ne: null },
      source: 'ai',
      is_public: { $ne: false }
    },
    {
      projection: {
        share_slug: 1, page_title: 1, upvotes: 1, hits: 1, ts: 1,
        site_of_the_week: 1, _id: 0
      }
    }
  );
}

// ============================================================
// Upvotes — atomic $inc on the generations row, scoped to public AI
// pages so a vote can't resurrect a hidden/non-gallery row. Returns the
// post-increment count, or null if the slug doesn't match a votable row.
// Dedupe (one vote per IP per slug) lives in _shared.js#recordVote.
// ============================================================
export async function incrementUpvote(slug) {
  if (!slug) return null;
  const d = await getDb();
  const result = await d.collection('generations').findOneAndUpdate(
    { share_slug: String(slug), source: 'ai', is_public: { $ne: false } },
    { $inc: { upvotes: 1 } },
    { returnDocument: 'after', projection: { upvotes: 1, _id: 0 } }
  );
  // Driver shape differs across versions: v4+ returns the doc directly,
  // v3 returns { value: doc }. Cover both.
  const doc = (result && result.value) ? result.value : result;
  return doc ? (doc.upvotes || 0) : null;
}

export async function getUpvoteCount(slug) {
  if (!slug) return 0;
  const d = await getDb();
  const doc = await d.collection('generations').findOne(
    { share_slug: String(slug) },
    { projection: { upvotes: 1, _id: 0 } }
  );
  return doc ? (doc.upvotes || 0) : 0;
}

// ============================================================
// Per-page stats — read for the JS-rendered /p/[slug] right
// cluster (api/page/[slug]/stats.js fetches this on every page
// load so the cached body can stay immutable while counts and
// the SOTW flag stay fresh).
// ============================================================
export async function getPageStats(slug) {
  if (!slug) return null;
  const d = await getDb();
  return d.collection('generations').findOne(
    { share_slug: String(slug) },
    { projection: { upvotes: 1, hits: 1, site_of_the_week: 1, source: 1, is_public: 1, _id: 0 } }
  );
}

export async function incrementHit(slug) {
  if (!slug) return null;
  const d = await getDb();
  const result = await d.collection('generations').findOneAndUpdate(
    { share_slug: String(slug), source: 'ai', is_public: { $ne: false } },
    { $inc: { hits: 1 } },
    { returnDocument: 'after', projection: { hits: 1, _id: 0 } }
  );
  const doc = (result && result.value) ? result.value : result;
  return doc ? (doc.hits || 0) : null;
}

// ============================================================
// Homepage visitor counter.
//
// siteStats holds one row per tracked surface; today only 'homepage'
// exists. Doc shape: { _id: 'homepage', count: <int>, updatedAt: Date }.
//
// The seed value (420) is loaded the first time the doc is touched,
// so a fresh deployment starts with a plausible-looking count rather
// than 1 — period sites all faked their counters at launch and so
// do we. The seed itself counts as the first visit; subsequent
// IP-deduped visits each $inc by 1.
// ============================================================
const HOMEPAGE_SEED = 1042;

export async function getHomepageVisitCount() {
  const d = await getDb();
  const doc = await d.collection('siteStats').findOne(
    { _id: 'homepage' },
    { projection: { count: 1, _id: 0 } }
  );
  return doc ? (doc.count || 0) : 0;
}

// Atomically increments + returns the new count. Seeds the doc at
// HOMEPAGE_SEED on first call (without an extra +1 — the seed IS
// the first visit's count). Returns whichever post-state the caller
// should display.
export async function incrementHomepageVisits() {
  const d = await getDb();
  const col = d.collection('siteStats');

  // Common path: doc exists, $inc and return.
  const updated = await col.findOneAndUpdate(
    { _id: 'homepage' },
    { $inc: { count: 1 }, $set: { updatedAt: new Date() } },
    { returnDocument: 'after', projection: { count: 1, _id: 0 } }
  );
  const updatedDoc = (updated && updated.value) ? updated.value : updated;
  if (updatedDoc && typeof updatedDoc.count === 'number') {
    return updatedDoc.count;
  }

  // Doc didn't exist — seed it. Race-safe: a concurrent visitor may
  // beat us to the insert; in that case fall back to a $inc.
  try {
    await col.insertOne({
      _id: 'homepage',
      count: HOMEPAGE_SEED,
      updatedAt: new Date()
    });
    return HOMEPAGE_SEED;
  } catch (err) {
    if (err && err.code === 11000) {
      const retry = await col.findOneAndUpdate(
        { _id: 'homepage' },
        { $inc: { count: 1 }, $set: { updatedAt: new Date() } },
        { returnDocument: 'after', projection: { count: 1, _id: 0 } }
      );
      const retryDoc = (retry && retry.value) ? retry.value : retry;
      return retryDoc ? (retryDoc.count || HOMEPAGE_SEED) : HOMEPAGE_SEED;
    }
    throw err;
  }
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + String(ip)).digest('hex').slice(0, 16);
}

// ============================================================
// Unsplash query cache — see api/_unsplash.js for the consumer.
// The collection stores { _id: <sha256 of normalized query>, url,
// photographerName, photographerProfile, photoId, downloadLocation,
// cachedAt }. cachedAt drives the 24h TTL index registered in getDb().
// ============================================================
export async function getUnsplashCacheEntry(keyHash) {
  if (!keyHash) return null;
  const d = await getDb();
  const doc = await d.collection('unsplashCache').findOne(
    { _id: String(keyHash) },
    { projection: { _id: 0, cachedAt: 0 } }
  );
  return doc || null;
}

export async function putUnsplashCacheEntry(keyHash, photo) {
  if (!keyHash || !photo || !photo.url) return;
  const d = await getDb();
  await d.collection('unsplashCache').updateOne(
    { _id: String(keyHash) },
    { $set: { ...photo, cachedAt: new Date() } },
    { upsert: true }
  );
}

// ============================================================
// Contact-form recipient lookup + write.
//
// A generated page may contain a <form action="/api/contact-form" ...>;
// submissions there get emailed via Resend to the address the original
// author registered after generation. Author identity is verified by the
// author token issued in the X-AINetscape-Author-Token response header at
// generation time (hashed server-side; see api/_shared.js#hashAuthorToken).
//
// Schema (additive on the generations row):
//   recipient_email                       — string, validated as RFC5322-ish
//   recipient_email_set_at                — Date
//   author_token_hash                     — pre-existing; the auth check
//
// `getContactRecipient` returns enough for /api/contact-form to fan out
// (recipient_email + page_title for the subject line). `setContactRecipient`
// requires the caller to pass author_token_hash so we can match it against
// the row — a slug without a matching author token can't register or change
// the recipient.
// ============================================================
export async function getContactRecipient(slug) {
  if (!slug) return null;
  const d = await getDb();
  const doc = await d.collection('generations').findOne(
    {
      share_slug: String(slug),
      source: 'ai',
      is_public: { $ne: false }
    },
    { projection: { recipient_email: 1, page_title: 1, _id: 0 } }
  );
  if (!doc) return null;
  return {
    recipient_email: doc.recipient_email || null,
    page_title: doc.page_title || null
  };
}

export async function setContactRecipient({ slug, author_token_hash, recipient_email }) {
  if (!slug || !author_token_hash) {
    return { ok: false, error: 'missing_slug_or_token' };
  }
  const d = await getDb();
  const result = await d.collection('generations').updateOne(
    {
      share_slug: String(slug),
      author_token_hash: String(author_token_hash)
    },
    {
      $set: {
        recipient_email: recipient_email ? String(recipient_email).slice(0, 200) : null,
        recipient_email_set_at: new Date()
      }
    }
  );
  if (result.matchedCount === 0) {
    return { ok: false, error: 'not_found_or_unauthorized' };
  }
  return { ok: true };
}

// ============================================================
// App settings — a tiny key/value collection for operator-tunable config
// that must change without a redeploy. Today the only key is the AI provider
// waterfall (order of { provider, model, enabled } rungs); see
// api/_ai_providers.js and the admin panel. Doc shape:
//   { _id: 'aiWaterfall', order: [...], updated_at: Date }
// ============================================================
export async function getAiWaterfall() {
  const d = await getDb();
  const doc = await d.collection('settings').findOne(
    { _id: 'aiWaterfall' },
    { projection: { order: 1, _id: 0 } }
  );
  return doc && Array.isArray(doc.order) ? doc.order : null;
}

export async function setAiWaterfall(order) {
  if (!Array.isArray(order)) throw new Error('setAiWaterfall requires an array');
  const d = await getDb();
  await d.collection('settings').updateOne(
    { _id: 'aiWaterfall' },
    { $set: { order, updated_at: new Date() } },
    { upsert: true }
  );
  return true;
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
