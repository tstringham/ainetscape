// api/_render_thumb.js
//
// Render a page's thumbnail here, in the function, the moment it publishes.
//
// The job has moved three times and each move was the same mistake in a new
// costume: the rendering needs a browser, and every design so far has tried to
// borrow one from somewhere else rather than have one.
//
//   microlink.io   a browser you rent. Its free daily quota ran out on
//                  20 September and took every gallery card AND every
//                  og:image with it, at once.
//   GitHub Actions a browser you borrow. Needs GITHUB_DISPATCH_TOKEN to be
//                  valid, a workflow file to keep its name, a queue query to
//                  be right and a cron as backstop. Four things, and on
//                  21 September two of them were wrong at the same time:
//                  publish-time dispatch went silent after 01:20 and the
//                  schedule was three-hourly, so "Hedgehog Reveal" sat on a
//                  placeholder until somebody noticed.
//
// This is the third answer: put the browser in the function. @sparticuz/chromium
// is a Chromium build small enough to ship inside a Vercel bundle, driven by
// puppeteer-core. No token, no dispatch, no queue, no schedule, no third party.
// The comment in build_thumbs.mjs that sent this to Actions in the first place
// -- "a serverless function has no writable disk" -- was true and irrelevant:
// the PNG goes straight to Mongo and never touches a disk.
//
// **Nothing in here may ever fail a generation.** It runs after the body has
// streamed to the visitor, so the page is already on screen and the worst
// honest outcome is the placeholder we would have shown anyway. Every path
// returns a boolean; none throws. The Actions workflow stays wired as the
// fallback and the five-minute schedule stays as the backstop, because a
// thumbnail pipeline with one leg is how we got here.

import chromium from '@sparticuz/chromium';
import puppeteer from 'puppeteer-core';
import { getThumbnail, putThumbnail } from './_db.js';

// 3:2 at 1200x800 -- the shape the gallery card, the og:image and the old
// proxy all assume. deviceScaleFactor 1 keeps the PNG at exactly these pixels;
// 2 would quadruple the bytes for a card that renders 240px wide.
const WIDTH = 1200;
const HEIGHT = 800;

// The generated document sits in a sandboxed iframe inside the Netscape chrome
// and loads its own fonts and photographs. `networkidle0` alone fires while a
// hero image is still decoding, and a thumbnail of a half-painted page looks
// like the page is broken rather than like it is loading.
const SETTLE_MS = 1200;
const NAV_TIMEOUT_MS = 15000;

// Hard ceiling on the whole attempt. api/generate.js allows 300s, and a hung
// browser must not be allowed to sit in that budget: at this point the visitor
// already has their page and every second here is spent on nobody.
const HARD_CAP_MS = 25000;

const ORIGIN = process.env.SITE_ORIGIN || 'https://ainetscape.com';

function withTimeout(promise, ms, label) {
  let timer;
  const cap = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(label + ' exceeded ' + ms + 'ms')), ms);
  });
  return Promise.race([promise, cap]).finally(() => clearTimeout(timer));
}

async function shoot(slug) {
  const browser = await puppeteer.launch({
    args: chromium.args,
    executablePath: await chromium.executablePath(),
    headless: chromium.headless,
    defaultViewport: { width: WIDTH, height: HEIGHT, deviceScaleFactor: 1 }
  });
  try {
    const page = await browser.newPage();
    await page.goto(ORIGIN + '/p/' + encodeURIComponent(slug), {
      waitUntil: 'networkidle0',
      timeout: NAV_TIMEOUT_MS
    });
    // Deliberately not page.waitForTimeout: removed in puppeteer 22.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    return await page.screenshot({
      type: 'png',
      clip: { x: 0, y: 0, width: WIDTH, height: HEIGHT }
    });
  } finally {
    // close() and not disconnect(): the process must die with the invocation
    // or it holds memory for whatever runs on this instance next.
    try { await browser.close(); } catch (_) { /* already gone */ }
  }
}

/**
 * Render and store the thumbnail for `slug`.
 *
 * @returns {Promise<boolean>} true only if a PNG was stored. false means the
 *   caller should fall back -- it never means "throw".
 */
export async function renderThumbnail(slug, { force = false } = {}) {
  const started = Date.now();
  try {
    if (!slug) return false;

    // Cheap and first: the five-minute schedule or a retry may have beaten us
    // here, and rendering a second copy costs a browser launch for nothing.
    if (!force) {
      const existing = await getThumbnail(slug);
      if (existing) {
        console.log('[thumb] ' + slug + ' already has one');
        return true;
      }
    }

    const png = await withTimeout(shoot(slug), HARD_CAP_MS, 'render');
    if (!png || !png.length) {
      console.error('[thumb] ' + slug + ' produced an empty screenshot');
      return false;
    }

    await putThumbnail({
      slug,
      png: Buffer.from(png),
      width: WIDTH,
      height: HEIGHT,
      source: 'vercel'
    });
    console.log('[thumb] ' + slug + ' rendered in ' + (Date.now() - started) +
      'ms, ' + Math.round(png.length / 1024) + ' KB');
    return true;
  } catch (err) {
    // Swallowed on purpose. Naming the failure is what makes a cold-start
    // problem distinguishable from a slow page in the logs; the Actions
    // fallback and the schedule handle the recovery.
    console.error('[thumb] ' + slug + ' failed after ' + (Date.now() - started) +
      'ms:', err && err.message);
    return false;
  }
}
