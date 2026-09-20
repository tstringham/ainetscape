// scripts/build_thumbs.mjs
//
// Renders gallery thumbnails with our own headless browser and stores them in
// our own database. Replaces api.microlink.io, whose free daily quota took out
// every gallery card and every shared link's social preview at once on
// 20 September when it ran out.
//
// Same approach as build_og.mjs, which has been rendering the static social
// card this way since launch -- Playwright's chromium, a fixed viewport, a PNG.
// The only new part is where the bytes go: Mongo, via putThumbnail, because a
// serverless function has no writable disk and the repo cannot grow a PNG per
// generated page.
//
// Run from the project root:
//   node scripts/build_thumbs.mjs                  backfill everything missing
//   node scripts/build_thumbs.mjs --slug k1rXemQkQ7  one page
//   node scripts/build_thumbs.mjs --force          re-render even if stored
//   node scripts/build_thumbs.mjs --limit 20       stop after N
//
// Requires: MONGODB_URI in the environment, playwright + chromium installed.
//   npm install && npx playwright install chromium
//   vercel env pull .env.production.local     (then run with the vars loaded)

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { getThumbnail, putThumbnail, listSlugsMissingThumbnails } from '../api/_db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATIC_DIR = path.resolve(__dirname, '..', 'public', 'images', 'gallery');

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://ainetscape.com';

// 3:2 at 1200x800, the same shape the gallery card and the old proxy used, so
// swapping the source reflows nothing. deviceScaleFactor 1 keeps the PNG at
// exactly these pixels -- 2 would quadruple the bytes for a 240px-wide card.
const WIDTH = 1200;
const HEIGHT = 800;

// The generated document lives in a sandboxed iframe inside the Netscape
// chrome, and it loads its own images and fonts. `networkidle` alone fires too
// early on pages whose hero image is still decoding, and a thumbnail of a
// half-painted page is worse than none -- it looks like the page is broken
// rather than like it is loading.
const SETTLE_MS = 1500;
const NAV_TIMEOUT_MS = 30_000;

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : (process.argv[i + 1] || null);
}
const hasFlag = (name) => process.argv.includes(name);

async function renderOne(browser, slug) {
  const page = await browser.newPage({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1
  });
  try {
    const url = SITE_ORIGIN + '/p/' + slug;
    await page.goto(url, { waitUntil: 'networkidle', timeout: NAV_TIMEOUT_MS });
    await page.waitForTimeout(SETTLE_MS);
    const png = await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
    });
    return png;
  } finally {
    await page.close();
  }
}

/**
 * Adopt the hand-uploaded PNGs in public/images/gallery into the database.
 *
 * Seventy-three of these were screenshotted and committed by hand -- the manual
 * workaround that ran alongside the metered proxy, six and a half megabytes of
 * the repository and growing by one file per page for ever. They are perfectly
 * good renders and there is no reason to make a browser produce them again.
 *
 * Once they are in, /api/thumb answers for every page from one place, the
 * gallery's static-first ordering costs nothing, and the directory can be
 * retired whenever Thomas wants the repository lighter. Nothing here deletes
 * anything -- that is his call, and the files keep working until he makes it.
 */
async function importStatic(force) {
  if (!fs.existsSync(STATIC_DIR)) {
    console.log('No public/images/gallery directory; nothing to import.');
    return;
  }
  const files = fs.readdirSync(STATIC_DIR).filter((f) => f.toLowerCase().endsWith('.png'));
  console.log('Importing ' + files.length + ' hand-uploaded PNG(s) from public/images/gallery');

  let done = 0, skipped = 0, failed = 0;
  for (const file of files) {
    const slug = path.basename(file, '.png');
    try {
      if (!force) {
        const existing = await getThumbnail(slug);
        if (existing) { skipped += 1; continue; }
      }
      const png = fs.readFileSync(path.join(STATIC_DIR, file));
      await putThumbnail({ slug, png, width: null, height: null, source: 'hand-uploaded' });
      done += 1;
    } catch (err) {
      failed += 1;
      console.error('  FAIL ' + slug + '  ' + (err && err.message));
    }
  }
  console.log('Imported ' + done + ', already present ' + skipped + ', failed ' + failed + '.');
}

/**
 * Load the env file the way the documented command assumes.
 *
 * `node scripts/build_thumbs.mjs` does not read a .env file -- node never has,
 * and build_og.mjs never needed one, so the omission was invisible until this
 * script wanted a database. The first run of the published instructions died
 * twice on "MONGODB_URI is not set" with the file sitting right there.
 *
 * Only when the variable is not already set, so an explicit
 * `MONGODB_URI=... node scripts/...` or a `vercel env`-wrapped run still wins.
 * Quiet when the file is missing: that is a normal way to run this.
 */
function loadEnvFile() {
  if (process.env.MONGODB_URI) return;
  for (const name of ['.env.production.local', '.env.local']) {
    const p = path.resolve(__dirname, '..', name);
    if (!fs.existsSync(p)) continue;
    try {
      process.loadEnvFile(p);
      if (process.env.MONGODB_URI) {
        console.log('Loaded ' + name);
        return;
      }
    } catch (_) { /* older node, or unreadable -- fall through to the error */ }
  }
}

async function main() {
  loadEnvFile();

  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is not set, and no .env.production.local or');
    console.error('.env.local in the project root supplied one.');
    console.error('');
    console.error('  vercel env pull --environment=production .env.production.local');
    console.error('');
    console.error('Note the --environment flag: `vercel env pull` alone downloads');
    console.error('DEVELOPMENT variables, whatever you name the file.');
    process.exit(1);
  }

  const one = arg('--slug');
  const force = hasFlag('--force');
  const limit = Number(arg('--limit') || 500);

  // Adopting the existing PNGs is free and instant; rendering is neither. Do
  // it first so a subsequent backfill only renders what genuinely has nothing.
  if (hasFlag('--import-static')) {
    await importStatic(force);
    if (!hasFlag('--and-render')) { process.exit(0); }
  }

  let targets;
  if (one) {
    targets = [{ share_slug: one, page_title: '(named on the command line)' }];
  } else {
    targets = await listSlugsMissingThumbnails(limit);
    if (force) {
      console.log('--force with no --slug re-renders only what is missing;');
      console.log('pass --slug to re-render a page that already has one.');
    }
  }

  if (!targets.length) {
    console.log('Nothing to render. Every public page has a thumbnail.');
    return;
  }

  console.log('Rendering ' + targets.length + ' thumbnail(s) from ' + SITE_ORIGIN);
  const browser = await chromium.launch();
  let done = 0;
  let failed = 0;

  try {
    for (const row of targets) {
      const slug = row.share_slug;
      if (one && !force) {
        const existing = await getThumbnail(slug);
        if (existing) {
          console.log('  ' + slug + ' already has one; pass --force to replace it.');
          continue;
        }
      }
      try {
        const png = await renderOne(browser, slug);
        await putThumbnail({ slug, png, width: WIDTH, height: HEIGHT, source: 'playwright' });
        done += 1;
        console.log('  ok   ' + slug + '  ' + Math.round(png.length / 1024) + ' KB  ' +
          String(row.page_title || '').slice(0, 48));
      } catch (err) {
        // One bad page must not end the batch. A page that 500s or hangs is
        // exactly the page a backfill exists to find.
        failed += 1;
        console.error('  FAIL ' + slug + '  ' + (err && err.message));
      }
    }
  } finally {
    await browser.close();
  }

  console.log('Rendered ' + done + ', failed ' + failed + '.');
  // The Mongo driver keeps the pool open; nothing else holds the process.
  process.exit(failed && !done ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
