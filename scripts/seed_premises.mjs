// scripts/seed_premises.mjs
//
// Push the composer catalogue from public/index.html into Mongo.
//
// index.html is the source of truth for the FALLBACK list -- the one the
// homepage ships so chips render before any network call -- and this copies it
// into the database that /api/premises serves. Run it after editing the array.
//
// Never deletes. A premise dropped from index.html stays in the database until
// somebody retires it deliberately; losing a row because it fell out of a file
// is not a thing this should be able to do by accident.
//
//   node scripts/seed_premises.mjs            seed from index.html
//   node scripts/seed_premises.mjs --dry-run  parse and report, write nothing

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { upsertComposerPremises, listComposerPremises } from '../api/_db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadEnvFile() {
  if (process.env.MONGODB_URI) return;
  for (const name of ['.env.production.local', '.env.local']) {
    const p = path.join(ROOT, name);
    if (!fs.existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
      if (process.env.MONGODB_URI) { console.error('Loaded ' + name); return; }
    } catch (_) { /* fall through to the error below */ }
  }
}

/**
 * Read the premises array out of index.html.
 *
 * Deliberately evaluated rather than regex-scraped: the entries are JavaScript
 * object literals with quotes inside quotes, and a regex that gets that right
 * is a regex that will get it wrong later. The bracket scan finds the array's
 * own closing bracket by depth -- an earlier version of this merge matched the
 * first `],` it saw and inserted a hundred premises into the File menu.
 */
function parsePremises() {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const start = html.indexOf('premises: [');
  if (start === -1) throw new Error('no `premises: [` in public/index.html');

  const open = html.indexOf('[', start);
  let depth = 0, end = -1;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '[') depth++;
    else if (html[i] === ']') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end === -1) throw new Error('unbalanced brackets in the premises array');

  const literal = html.slice(open, end + 1);
  // eslint-disable-next-line no-new-func
  return new Function('return ' + literal + ';')();
}

async function main() {
  loadEnvFile();
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set, and no .env.production.local or');
    console.error('.env.local in the project root supplied one.');
    console.error('');
    console.error('  vercel env pull --environment=production .env.production.local');
    process.exit(1);
  }

  const rows = parsePremises();
  const byPillar = {};
  for (const r of rows) byPillar[r.pillar] = (byPillar[r.pillar] || 0) + 1;
  const labels = rows.map((r) => r.label);
  const dupes = labels.length - new Set(labels).size;

  console.log('parsed ' + rows.length + ' premises from public/index.html');
  console.log('  by pillar: ' + JSON.stringify(byPillar));
  if (dupes) {
    console.error('  ' + dupes + ' duplicate label(s) -- `_id` is the label, so these would');
    console.error('  collapse into one row. Fix index.html first.');
    process.exit(1);
  }

  if (process.argv.includes('--dry-run')) {
    console.log('--dry-run: nothing written.');
    process.exit(0);
  }

  const { added, updated } = await upsertComposerPremises(rows);
  const total = (await listComposerPremises()).length;
  console.log('added ' + added + ', updated ' + updated + ', unchanged ' +
    (rows.length - added - updated) + '.');
  console.log(total + ' live premises in the database.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
