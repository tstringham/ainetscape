// scripts/build_og.mjs
//
// Renders scripts/og-template.html to public/og-image.png — the 1200x630
// social card. A headless-browser screenshot gets the fonts and 1px Motif
// bevels exact, which PIL cannot.
//
// Run from the project root:  node scripts/build_og.mjs
// Requires: playwright + the chromium browser
//   npm install
//   npx playwright install chromium

import { chromium } from 'playwright';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const templatePath = 'file://' + path.join(__dirname, 'og-template.html');
const outDir = path.join(root, 'public');
const outPath = path.join(outDir, 'og-image.png');

fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
try {
  // deviceScaleFactor 1 → exactly 1200x630, matching the og:image meta tags.
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1
  });
  await page.goto(templatePath);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
  console.log('OG image written to ' + outPath);
} finally {
  await browser.close();
}
