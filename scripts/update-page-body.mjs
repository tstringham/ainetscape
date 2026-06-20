// scripts/update-page-body.mjs
//
// One-off helper: replace the body_html of a single generation row by
// share_slug. Used to manually fix pages whose generation output had a
// glitch (e.g. a token loop) or to hand-edit a published page's copy.
//
// Usage:
//   vercel env pull .env.production.local --environment=production
//   node --env-file=.env.production.local scripts/update-page-body.mjs <slug> <html-file>
//
// After updating, the page is still cached at the Vercel edge for up to
// 24h (Cache-Control: s-maxage=86400, immutable). Append a cache-busting
// query string (e.g. ?v=2) when verifying, or purge the edge cache from
// the Vercel dashboard if you want everyone to see the change now.

import fs from 'fs';
import { MongoClient } from 'mongodb';

const [, , slug, htmlPath] = process.argv;

if (!slug || !htmlPath) {
  console.error('Usage: node scripts/update-page-body.mjs <slug> <html-file>');
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI not set. Run `vercel env pull` first, then');
  console.error('invoke with `node --env-file=.env.production.local ...`.');
  process.exit(1);
}

const html = fs.readFileSync(htmlPath, 'utf8');
const titleMatch = /<title>([\s\S]*?)<\/title>/i.exec(html);
const pageTitle = titleMatch ? titleMatch[1].trim() : null;

const dbName = process.env.MONGODB_DB || 'ainetscape';
const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2 });

try {
  await client.connect();
  const col = client.db(dbName).collection('generations');

  const existing = await col.findOne(
    { share_slug: slug },
    { projection: { share_slug: 1, page_title: 1, body_size_bytes: 1, _id: 0 } }
  );
  if (!existing) {
    console.error(`No row found for slug "${slug}".`);
    process.exit(2);
  }

  const setFields = {
    body_html: html,
    body_size_bytes: html.length,
    body_updated_at: new Date()
  };
  if (pageTitle) setFields.page_title = pageTitle.slice(0, 200);

  const result = await col.updateOne(
    { share_slug: slug },
    { $set: setFields }
  );

  console.log(`Updated slug=${slug}`);
  console.log(`  matched=${result.matchedCount} modified=${result.modifiedCount}`);
  console.log(`  old size=${existing.body_size_bytes || '?'} bytes → new size=${html.length} bytes`);
  if (pageTitle) console.log(`  title=${pageTitle}`);
  console.log('');
  console.log('Edge cache may still serve the old HTML for up to 24h.');
  console.log(`Verify with: curl -s "https://ainetscape.com/p/${slug}?v=$(date +%s)" | head`);
} finally {
  await client.close();
}
