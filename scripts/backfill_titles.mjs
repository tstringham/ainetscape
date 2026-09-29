#!/usr/bin/env node
/**
 * Decode HTML entities in stored page_title values.
 *
 * DRY RUN BY DEFAULT. Prints before/after for every row it would change, plus
 * a count, and writes nothing. Pass --apply to actually write.
 *
 *   node --env-file=.env.production.local scripts/backfill_titles.mjs
 *   node --env-file=.env.production.local scripts/backfill_titles.mjs --apply
 *
 * WHY THIS IS OPTIONAL. The display path already calls displayTitle(), so
 * every surface renders old rows correctly without it. This only normalises
 * what is IN the database — worth doing so that consumers which read
 * page_title raw (the admin JSON, a future export) see plain text too.
 *
 * Only rows whose decoded title actually differs are touched, so re-running it
 * is a no-op and it can be run safely more than once.
 */

import { MongoClient } from 'mongodb';
import { displayTitle } from '../api/_title.js';

const APPLY = process.argv.includes('--apply');
const URI = process.env.MONGODB_URI;

if (!URI) {
  console.error('MONGODB_URI is not set. Try:\n  node --env-file=.env.production.local scripts/backfill_titles.mjs');
  process.exit(1);
}

const client = new MongoClient(URI, { maxPoolSize: 2 });
await client.connect();
const col = client.db(process.env.MONGODB_DB || 'ainetscape').collection('generations');

const rows = await col
  .find({ page_title: { $exists: true, $nin: [null, ''] } },
        { projection: { share_slug: 1, page_title: 1, is_public: 1 } })
  .toArray();

const changes = [];
for (const r of rows) {
  const after = displayTitle(r.page_title);
  if (after && after !== r.page_title) changes.push({ ...r, after });
}

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — scanned ${rows.length} titled rows\n`);
if (!changes.length) {
  console.log('Nothing to change. Every stored title is already plain text.');
} else {
  for (const c of changes) {
    console.log(`  ${c.share_slug}${c.is_public === false ? ' (hidden)' : ''}`);
    console.log(`    before: ${JSON.stringify(c.page_title)}`);
    console.log(`    after : ${JSON.stringify(c.after)}`);
  }
  console.log(`\n${changes.length} row${changes.length === 1 ? '' : 's'} would change.`);
}

if (APPLY && changes.length) {
  // One updateOne per row rather than a bulk op: a few rows, and a failure
  // part-way leaves the rest correct instead of ambiguous.
  let written = 0;
  for (const c of changes) {
    const r = await col.updateOne({ _id: c._id }, { $set: { page_title: c.after } });
    written += r.modifiedCount;
  }
  console.log(`\nWrote ${written} row${written === 1 ? '' : 's'}.`);
} else if (changes.length) {
  console.log('\nNothing written. Re-run with --apply to write.');
}

await client.close();
process.exit(0);
