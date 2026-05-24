// scripts/build_pages.mjs
//
// Converts the static markdown files under content/ into HTML pages served
// at /terms, /privacy, /copyright, /faq. Substitutes the rendered HTML +
// browser-tab title into scripts/templates/page.html (the AI Netscape
// chrome) and writes the result to public/{slug}.html. Vercel cleanUrls
// makes /terms.html available at /terms.
//
// Also replaces `[DATE]` placeholders in source markdown with today's
// date in Pacific time, formatted "Month D, YYYY". Same date formatter
// as scripts/build_lastupdated.mjs so the "Last updated" lines on the
// legal pages and the starter doc footer agree.

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { marked } from 'marked';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Pages to build. Slug = output filename (public/{slug}.html).
const PAGES = [
  { slug: 'terms',     source: 'content/terms.md',     title: 'Terms of Service — AI Netscape' },
  { slug: 'privacy',   source: 'content/privacy.md',   title: 'Privacy Policy — AI Netscape' },
  { slug: 'copyright', source: 'content/copyright.md', title: 'Copyright Policy — AI Netscape' },
  { slug: 'faq',       source: 'content/faq.md',       title: 'Frequently Asked Questions — AI Netscape' }
];

// Today's date in Pacific time, "Month D, YYYY". Matches the format used
// elsewhere on the site for "Last updated" lines.
function todayPT() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit'
  });
  const [y, mo, d] = fmt.format(new Date()).split('-').map(Number);
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  return `${MONTHS[mo - 1]} ${d}, ${y}`;
}

const DATE = todayPT();
const template = readFileSync(resolve(projectRoot, 'scripts/templates/page.html'), 'utf8');

// Marked options — GitHub-flavored markdown, no inline HTML sanitization
// (content is authored by us, not user-submitted, so trust is fine).
marked.setOptions({ gfm: true, breaks: false });

for (const page of PAGES) {
  const sourcePath = resolve(projectRoot, page.source);
  let md = readFileSync(sourcePath, 'utf8');

  // Replace [DATE] placeholders with today's PT date.
  md = md.split('[DATE]').join(DATE);

  const html = marked.parse(md);

  // Substitute into the chrome template. Use split/join to avoid regex
  // pitfalls (the rendered HTML may contain $1-style sequences that would
  // confuse String.replace).
  const out = template
    .split('{{TITLE}}').join(escapeHtml(page.title))
    .split('{{CONTENT}}').join(html);

  const outPath = resolve(projectRoot, `public/${page.slug}.html`);
  writeFileSync(outPath, out);
  console.log(`Wrote public/${page.slug}.html (${page.title})`);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
