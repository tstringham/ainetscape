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
// 24h (s-maxage=86400). There are TWO cached documents, not one:
//
//   /p/<slug>       the Netscape chrome shell
//   /p/<slug>/raw   the generated page, loaded into the shell's iframe
//
// The iframe requests /raw with NO query string, so "verify with ?v=..."
// checks a URL no visitor ever hits: it is a different cache key, so it
// misses, re-renders from Mongo and looks correct while every real visitor
// is still served the old bytes. Worse, a diagnostic curl of the bare URL
// re-warms the stale entry for another 24h -- that is how an edit made at
// 08:50 was still invisible behind an entry cached at 08:32.
//
// To actually verify: curl the BARE urls and read x-vercel-cache / age.
// HIT with a large age means you are reading the cache, not your change.
// To ship it to everyone: purge the edge cache (Vercel dashboard ->
// project -> Data Cache / purge), or deploy, which invalidates it.

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
  console.log('');
  console.log('Mongo is updated. The Vercel edge is NOT -- both /p/<slug> and');
  console.log('/p/<slug>/raw are cached for up to 24h and the iframe requests');
  console.log('/raw with no query string, so a ?v= check proves nothing.');
  console.log('');
  console.log('Check what visitors get:');
  console.log(`  curl -sI "https://ainetscape.com/p/${slug}/raw" | grep -i "x-vercel-cache\\|age"`);
  console.log('A HIT with a non-zero age is the old copy. Purge the edge cache');
  console.log('or deploy to make the change visible.');
} finally {
  await client.close();
}
