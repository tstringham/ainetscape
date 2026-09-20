// scripts/gen-gallery-thumbs.mjs
//
// Render a static 1200x800 thumbnail for every gallery page that doesn't
// have one yet, into public/images/gallery/<slug>.png. The gallery uses
// that file as the primary <img> src; only slugs without a file fall back
// to the Microlink screenshot proxy, whose free tier has a daily quota.
//
// Usage:
//   node scripts/gen-gallery-thumbs.mjs            # every gallery slug missing a PNG
//   node scripts/gen-gallery-thumbs.mjs --force    # regenerate all gallery slugs
//   node scripts/gen-gallery-thumbs.mjs slugA slugB  # just these slugs
//
// /p/:slug serves the generated document inside a sandboxed <iframe srcdoc>
// within the AI Netscape chrome, so a screenshot of /p/:slug would show the
// chrome with a small frame. Instead this pulls the srcdoc out of the frame
// and renders the document itself at the thumbnail viewport, matching the
// committed thumbnails produced by review/reseed/gen-thumbs*.mjs.

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const ORIGIN = 'https://ainetscape.com';
const OUT_DIR = path.resolve('public/images/gallery');
const VIEWPORT = { width: 1200, height: 800 };
const CONCURRENCY = 3;

const args = process.argv.slice(2);
const force = args.includes('--force');
const explicit = args.filter(a => !a.startsWith('--'));

fs.mkdirSync(OUT_DIR, { recursive: true });

async function galleryslugs() {
  const slugs = new Set();
  for (let page = 1; page < 100; page++) {
    const res = await fetch(`${ORIGIN}/gallery?page=${page}`);
    if (!res.ok) throw new Error(`gallery page ${page}: HTTP ${res.status}`);
    const html = await res.text();
    const found = [...html.matchAll(/src="\/images\/gallery\/([^"/]+)\.png"/g)].map(m => m[1]);
    found.forEach(s => slugs.add(s));
    const m = html.match(/Page (\d+) of (\d+)/);
    if (!m || Number(m[1]) >= Number(m[2]) || found.length === 0) break;
  }
  return [...slugs];
}

const all = explicit.length ? explicit : await galleryslugs();
const todo = force || explicit.length
  ? all
  : all.filter(s => !fs.existsSync(path.join(OUT_DIR, `${s}.png`)));

console.log(`gallery slugs: ${all.length}, to render: ${todo.length}`);
if (!todo.length) process.exit(0);

const browser = await chromium.launch();
let failures = 0;

async function render(slug) {
  const ctx = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
  try {
    // 1. Fetch the share page and lift the document out of the sandboxed frame.
    const outer = await ctx.newPage();
    const res = await outer.goto(`${ORIGIN}/p/${slug}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (!res || !res.ok()) throw new Error(`HTTP ${res ? res.status() : 'none'}`);
    const doc = await outer.evaluate(() => {
      const f = document.querySelector('iframe.page-frame');
      return f ? f.getAttribute('srcdoc') : null;
    });
    await outer.close();
    if (!doc) throw new Error('no iframe.page-frame srcdoc');

    // 2. Render the document itself at thumbnail size.
    const page = await ctx.newPage();
    await page.setContent(doc, { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch (_) { /* slow assets; shoot anyway */ }
    await page.waitForTimeout(1200);
    const stat = await page.evaluate(() => ({
      total: document.images.length,
      ok: [...document.images].filter(i => i.complete && i.naturalWidth > 0).length
    }));
    const out = path.join(OUT_DIR, `${slug}.png`);
    await page.screenshot({ path: out, fullPage: false });
    const kb = Math.round(fs.statSync(out).size / 1024);
    console.log(`  ${slug.padEnd(12)} ok  imgs ${stat.ok}/${stat.total}  ${kb}KB`);
  } catch (err) {
    failures++;
    console.log(`  ${slug.padEnd(12)} FAILED  ${err.message}`);
  } finally {
    await ctx.close();
  }
}

const queue = [...todo];
await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
  while (queue.length) await render(queue.shift());
}));

await browser.close();
console.log(`done: ${todo.length - failures} rendered, ${failures} failed`);
process.exit(failures ? 1 : 0);
