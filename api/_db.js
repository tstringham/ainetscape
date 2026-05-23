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
  return db;
}

function hashIp(ip) {
  return crypto.createHash('sha256').update(IP_SALT + String(ip)).digest('hex').slice(0, 16);
}

export async function logEvent({
  ip, kind = 'generate', brief, data, ref, forceBuild, duration_ms,
  referrer, user_agent, verdict
}) {
  const d = await getDb();
  const doc = {
    ts: new Date(),
    kind,                                                 // 'generate' | 'triage'
    ip_hash: hashIp(ip),                                  // SHA-256 of IP+salt; never the raw IP
    brief_length: brief ? brief.length : 0,
    brief_preview: brief ? brief.slice(0, 100) : '',      // first 100 chars only, for spam review
    model: (data && data.model) || null,
    output_tokens: (data && data.usage && data.usage.output_tokens) || 0,
    input_tokens: (data && data.usage && data.usage.input_tokens) || 0,
    duration_ms: duration_ms || 0,
    referrer: referrer ? String(referrer).slice(0, 200) : null,
    utm_ref: ref ? String(ref).slice(0, 40) : null,       // 'marc', 'a16z', 'tw', 'hn', etc.
    user_agent: user_agent ? String(user_agent).slice(0, 200) : null
  };
  if (kind === 'generate') doc.force_build = !!forceBuild;
  if (kind === 'triage')   doc.verdict = verdict || null;
  await d.collection('generations').insertOne(doc);
}
