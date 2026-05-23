// scripts/build_lastupdated.mjs
//
// Writes public/last-updated.js with the date of the most recent commit
// (or, if git history isn't available in the build env, today's date in
// Pacific time). Runs as part of `npm run vercel-build` so every deploy
// regenerates the value.

import { execSync } from 'child_process';
import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let isoDate;
try {
  // %cs = committer date in short ISO 8601 (YYYY-MM-DD), in the local
  // timezone of the commit. That matches "the day the commit was made."
  isoDate = execSync('git log -1 --format=%cs', {
    encoding: 'utf8',
    cwd: projectRoot,
    stdio: ['pipe', 'pipe', 'ignore']
  }).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
    throw new Error('unexpected git output: ' + JSON.stringify(isoDate));
  }
} catch (err) {
  // git history unavailable — fall back to today's date in Pacific time,
  // which is the deploy day. Close enough for our CLI workflow where
  // deploys follow commits within minutes.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  isoDate = fmt.format(new Date());   // en-CA gives YYYY-MM-DD
  console.warn('git log unavailable; falling back to today (PT):', isoDate);
}

// Format ISO date as "May 23, 2026" without timezone drift from `new Date()`.
const [y, mo, d] = isoDate.split('-').map(Number);
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];
const formatted = `${MONTHS[mo - 1]} ${d}, ${y}`;

const outFile = resolve(projectRoot, 'public/last-updated.js');
writeFileSync(outFile,
  '// Generated at build time by scripts/build_lastupdated.mjs — do not edit.\n' +
  'window.__LAST_UPDATED__ = ' + JSON.stringify(formatted) + ';\n'
);
console.log('Wrote public/last-updated.js → ' + formatted);
