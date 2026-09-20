// api/_indexable.js
//
// Turning a generated page into something a search engine can read.
//
// The problem this exists for, measured on 20 September 1997: a /p/ page's
// entire content lives in the `srcdoc` attribute of a sandboxed iframe, and
// crawlers do not index iframe content as part of the parent -- srcdoc content
// has no URL of its own to index separately. So all seventy-five published
// pages presented the same 88 words to Google, every one of them Netscape
// chrome ("File Edit View Insert Format Tools Help", the toolbar, the status
// bar) and not one word of the page. Seventy-five near-identical documents,
// which is the profile that earns suppression for a whole domain rather than
// no ranking at all.
//
// The iframe cannot simply go. Sixty-eight of those pages ship their own
// script and sixty-four use inline handlers -- and they are not decoration:
// `calculateCosts`, `submitReport`, `submitTheory`. Interactive calculators and
// forms are part of the joke. Stripping them to inline the markup would trade
// the product for the ranking, and running model-authored JavaScript in the
// main document would trade a security boundary for it.
//
// So the content appears TWICE and honestly: the framed interactive page for a
// visitor, and a plain-text rendering in the outer document for anyone -- human
// or crawler -- who wants the words. Same content, visible to both, no
// cloaking, nothing hidden after load. A 1997 site offering a text-only
// version is also exactly period-correct, which is the part that makes it feel
// like a feature rather than a concession.
//
// What comes out is TEXT, never markup. Nothing here re-emits a tag from the
// model's document: the caller escapes what it gets, and the structure below is
// built from a fixed vocabulary of our own elements. Model output never becomes
// live HTML in the outer document, which is the whole reason the iframe was
// sandboxed in the first place.

const BLOCK_TAGS = 'h1|h2|h3|h4|h5|h6|p|li|blockquote|figcaption|dt|dd|td|th|summary';

/** Elements whose text is never page content. */
const DROP_CONTENT = /<(script|style|noscript|template|svg|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi;

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'",
  '&apos;': "'", '&nbsp;': ' ', '&mdash;': '—', '&ndash;': '–', '&hellip;': '…',
  '&rsquo;': '’', '&lsquo;': '‘', '&rdquo;': '”', '&ldquo;': '“'
};

function decodeEntities(s) {
  return s
    .replace(/&(amp|lt|gt|quot|#39|apos|nbsp|mdash|ndash|hellip|rsquo|lsquo|rdquo|ldquo);/g,
      (m) => ENTITIES[m] || m)
    .replace(/&#(\d+);/g, (_, d) => {
      const n = Number(d);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
    });
}

function clean(s) {
  return decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Block-level text from a generated document, in source order.
 *
 * Returns `[{ tag, text }]` where `tag` is one of our own vocabulary -- never
 * the model's. Consecutive duplicates are dropped: generated pages repeat a
 * headline in a hero and again in a heading often enough that it reads as a
 * stutter in plain text.
 */
export function extractBlocks(html, { maxBlocks = 400 } = {}) {
  if (!html) return [];
  const body = String(html).replace(DROP_CONTENT, ' ');

  /*
   * Headings first, and separately, because they are the one thing worth
   * knowing the shape of and the one thing that does not nest.
   *
   * Everything else comes from a boundary pass rather than a matched-pair
   * pass. Matching `<div>…</div>` with a regex is the classic wrong tool --
   * non-greedy stops at the first `</div>`, which on a nested layout is the
   * wrong one -- and an earlier version of this file paid for that by
   * recovering 171 words per page where the documents hold 603. Generated
   * pages put most of their prose in divs and spans, so a vocabulary of
   * `p|li|h*` was reading a third of the site.
   */
  const headings = new Set();
  const hre = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let hm;
  const headingLevel = new Map();
  while ((hm = hre.exec(body)) !== null) {
    const text = clean(hm[2]);
    if (text.length >= 2) { headings.add(text); headingLevel.set(text, hm[1].toLowerCase()); }
  }

  const listItems = new Set();
  const lre = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let lm;
  while ((lm = lre.exec(body)) !== null) {
    const text = clean(lm[1]);
    if (text.length >= 2) listItems.add(text);
  }

  // Every element that ends a line of reading becomes a break, then the tags
  // go. Nesting stops mattering because nothing is being paired up.
  const BREAK = /<\/?(address|article|aside|blockquote|br|caption|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

  const lines = body
    .replace(BREAK, '\n')
    .replace(/<[^>]*>/g, ' ');

  const out = [];
  const seen = new Set();
  for (const raw of decodeEntities(lines).split('\n')) {
    const text = raw.replace(/\s+/g, ' ').trim();
    // One glyph of nothing -- an arrow, a bullet -- is noise in plain text.
    if (text.length < 2) continue;
    // Generated pages repeat a headline in a hero and again as a heading often
    // enough that it reads as a stutter. Deduplicate across the document, not
    // just adjacently, since the repeat is usually not adjacent.
    if (seen.has(text)) continue;
    seen.add(text);

    let tag = 'p';
    if (headings.has(text)) tag = headingLevel.get(text);
    else if (listItems.has(text)) tag = 'li';

    out.push({ tag, text });
    if (out.length >= maxBlocks) break;
  }
  return out;
}

/**
 * A meta description drawn from what the page actually says.
 *
 * Prefers the first substantial paragraph over the first heading: a heading is
 * usually the title again, and a description that repeats the title tells a
 * searcher nothing they did not already read.
 *
 * Trimmed at a sentence or word boundary near 155 characters -- the width
 * Google has historically rendered before truncating. Never mid-word, because
 * a description ending in "the compa…" reads as a broken page.
 */
export function buildDescription(html, fallbackTitle) {
  const blocks = extractBlocks(html, { maxBlocks: 40 });
  const prose = blocks.find((b) => b.tag === 'p' && b.text.length >= 60)
    || blocks.find((b) => b.tag === 'p' && b.text.length >= 25)
    || blocks.find((b) => b.text.length >= 40);

  let text = prose ? prose.text : '';
  if (!text) {
    // Nothing usable. A generic line beats an empty tag, and it must still
    // sound like the site rather than like a CMS.
    return (fallbackTitle ? fallbackTitle + ' — ' : '') +
      'Published on AI Netscape with the AI Composer.';
  }

  if (text.length <= 155) return text;
  const cut = text.slice(0, 155);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (stop > 90) return cut.slice(0, stop + 1);
  const space = cut.lastIndexOf(' ');
  return (space > 90 ? cut.slice(0, space) : cut).replace(/[,;:\-—\s]+$/, '') + '…';
}

/**
 * The plain-text rendering, as escaped HTML ready to embed.
 *
 * `escapeHtml` is passed in rather than imported so this module stays free of
 * a dependency on the chrome, and so the caller cannot forget to escape: there
 * is no path through here that emits an unescaped character from `html`.
 */
export function renderTextVersion(html, escapeHtml) {
  const blocks = extractBlocks(html);
  if (!blocks.length) return '';

  const parts = [];
  for (const b of blocks) {
    // Our vocabulary, not theirs. A model heading level maps onto h2/h3 so the
    // outer document keeps one h1 -- the page title in the chrome.
    let tag = 'p';
    if (b.tag === 'h1' || b.tag === 'h2') tag = 'h2';
    else if (b.tag === 'h3' || b.tag === 'h4' || b.tag === 'h5' || b.tag === 'h6') tag = 'h3';
    else if (b.tag === 'li') tag = 'li';
    else if (b.tag === 'blockquote') tag = 'blockquote';
    parts.push('<' + tag + '>' + escapeHtml(b.text) + '</' + tag + '>');
  }

  // Runs of <li> wrapped so the markup is valid rather than merely rendering.
  const joined = parts.join('')
    .replace(/(?:<li>[\s\S]*?<\/li>)+/g, (run) => '<ul>' + run + '</ul>');

  return joined;
}
