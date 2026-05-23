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

function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + String(ip)).digest('hex').slice(0, 16);
}

export async function logEvent({
  ip, event, kind, brief, data, ref, forceBuild, duration_ms,
  referrer, user_agent, verdict, body_html, share_slug
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
  await d.collection('generations').insertOne(doc);
}
