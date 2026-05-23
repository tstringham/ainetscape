// scripts/build_ga.mjs
//
// Writes public/ga.js — the GA4 gtag bootstrap snippet if
// GA_MEASUREMENT_ID is set in the build env (Vercel), or a no-op
// `window.gtag` stub if it isn't. Same pattern as build_lastupdated.mjs.
//
// To enable analytics: `vercel env add GA_MEASUREMENT_ID production`
// (and `preview`), paste a GA4 Measurement ID like G-XXXXXXXXXX, then
// redeploy. To disable: remove the env var and redeploy.

import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const gaId = String(process.env.GA_MEASUREMENT_ID || '').trim();

let out;
if (/^G-[A-Z0-9]+$/i.test(gaId)) {
  // GA4 measurement enabled.
  out =
    '// Generated at build time. GA4 measurement enabled.\n' +
    '(function () {\n' +
    '  var GA_ID = ' + JSON.stringify(gaId) + ';\n' +
    '  var s = document.createElement("script");\n' +
    '  s.async = true;\n' +
    '  s.src = "https://www.googletagmanager.com/gtag/js?id=" + encodeURIComponent(GA_ID);\n' +
    '  document.head.appendChild(s);\n' +
    '  window.dataLayer = window.dataLayer || [];\n' +
    '  window.gtag = function () { dataLayer.push(arguments); };\n' +
    '  gtag("js", new Date());\n' +
    '  gtag("config", GA_ID);\n' +
    '})();\n';
  console.log('Wrote public/ga.js → GA4 enabled (' + gaId + ')');
} else {
  // No measurement ID set — stub window.gtag so trackEvent() calls in the
  // app code are safe to fire without `typeof` guards.
  out =
    '// Generated at build time. GA_MEASUREMENT_ID not set; analytics disabled.\n' +
    'window.gtag = function () {};\n';
  console.log('Wrote public/ga.js → GA4 disabled (no GA_MEASUREMENT_ID env var)');
}

writeFileSync(resolve(projectRoot, 'public/ga.js'), out);
