#!/usr/bin/env node
/**
 * Measure how varied the generated pages actually look.
 *
 * Written because "they all look the same" is easy to feel and hard to argue
 * with. The first run of this said something more useful than the impression
 * did: fonts were already varied (103 sans / 50 serif / 28 mono) but of 187
 * pages, ZERO had a mid-tone background. Every one was near-white or
 * near-black. The monotony was the palette, not the typeface.
 *
 * Re-run it after new pages accumulate to see whether the design seed in
 * generate.js moved the needle. The number to watch is `mid`.
 *
 *   node --env-file=.env.production.local scripts/audit_design_variety.mjs
 *   node --env-file=.env.production.local scripts/audit_design_variety.mjs --since 2026-09-29
 */

import { MongoClient } from 'mongodb';

const sinceArg = process.argv.indexOf('--since');
const since = sinceArg > -1 ? new Date(process.argv[sinceArg + 1]) : null;
if (!process.env.MONGODB_URI) {
  console.error('MONGODB_URI not set. Try: node --env-file=.env.production.local scripts/audit_design_variety.mjs');
  process.exit(1);
}

const luminance = (hex) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return 0.2126 * (n >> 16) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
};

// Resolve `background: var(--bg)` through the :root custom properties, because
// most pages define their colours that way and a naive regex reads them as
// "unknown" — which is how a 100%-monochrome catalogue looked like 77% unknown.
function bodyBackground(css) {
  const vars = {};
  for (const v of css.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) vars[v[1]] = v[2].trim();
  let m = /body\s*\{[^}]*?background(?:-color)?\s*:\s*([^;!}]+)/i.exec(css)
       || /:root\s*\{[^}]*?--bg\s*:\s*([^;}]+)/i.exec(css);
  if (!m) return null;
  let val = m[1].trim();
  for (let i = 0; i < 4; i++) {
    const vm = /var\(\s*--([\w-]+)/.exec(val);
    if (!vm) break;
    val = (vars[vm[1]] || '').trim();
  }
  const hm = /#[0-9a-f]{3,8}/i.exec(val);
  if (hm) {
    let h = hm[0];
    if (h.length === 4) h = '#' + h[1] + h[1] + h[2] + h[2] + h[3] + h[3];
    return h.slice(0, 7).toLowerCase();
  }
  if (/^(white|#fff)/i.test(val)) return '#ffffff';
  if (/^black/i.test(val)) return '#000000';
  return null;
}

const client = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 2 });
await client.connect();
const filter = {
  source: 'ai', event: 'ai_generation_completed',
  is_public: { $ne: false }, body_html: { $exists: true }
};
if (since) filter.ts = { $gte: since };
const rows = await client.db(process.env.MONGODB_DB || 'ainetscape')
  .collection('generations')
  .find(filter, { projection: { body_html: 1, ts: 1, _id: 0 } })
  .toArray();

const bg = { light: 0, mid: 0, dark: 0, unresolved: 0 };
const fonts = {};
for (const r of rows) {
  const css = (r.body_html.match(/<style[^>]*>([\s\S]*?)<\/style>/gi) || []).join('\n');
  const hex = bodyBackground(css);
  const L = hex === null ? null : luminance(hex);
  if (L === null) bg.unresolved++;
  else if (L > 180) bg.light++;
  else if (L < 70) bg.dark++;
  else bg.mid++;

  const fm = /h1\s*\{[^}]*?font-family\s*:\s*([^;}]+)/i.exec(css)
          || /body\s*\{[^}]*?font-family\s*:\s*([^;}]+)/i.exec(css);
  if (fm) {
    const f = fm[1].toLowerCase();
    const kind = /mono|courier/.test(f) ? 'mono'
      : /sans-serif|helvetica|arial|grotesk/.test(f) ? 'sans'
      : /serif/.test(f) ? 'serif' : 'other';
    fonts[kind] = (fonts[kind] || 0) + 1;
  }
}

const n = bg.light + bg.mid + bg.dark;
const pc = (x) => n ? Math.round((x / n) * 100) + '%' : 'n/a';
console.log(`pages: ${rows.length}${since ? '  (since ' + since.toISOString().slice(0, 10) + ')' : ''}\n`);
console.log('BACKGROUND');
console.log(`  light  ${String(bg.light).padStart(4)}  ${pc(bg.light)}`);
console.log(`  mid    ${String(bg.mid).padStart(4)}  ${pc(bg.mid)}   <-- the number to watch`);
console.log(`  dark   ${String(bg.dark).padStart(4)}  ${pc(bg.dark)}`);
if (bg.unresolved) console.log(`  (unresolved: ${bg.unresolved})`);
console.log('\nHEADING FONT');
for (const [k, v] of Object.entries(fonts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${k.padEnd(6)} ${String(v).padStart(4)}`);
}
await client.close();
process.exit(0);
