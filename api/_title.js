// /api/_title.js
//
// One function, used everywhere a page title is captured or displayed.
// Files prefixed "_" are not routed as endpoints.
//
// THE BUG THIS EXISTS FOR. generate.js lifts a title with
// /<title>([\s\S]*?)<\/title>/ — the raw SOURCE of the element, not its
// rendered value. The model writes valid HTML, so an ampersand arrives as
// `&amp;`, gets stored that way, and every consumer then escapes it again on
// output. The card ends up reading "BEAD &amp; BONE" in five literal
// characters. `page_title` is treated as plain text by everything that reads
// it, so it has to BE plain text.
//
// TWO FUNCTIONS, BY ROLE. cleanTitle() runs at CAPTURE and strips markup.
// displayTitle() runs at DISPLAY and does not.
//
// They were one function until the idempotence test failed. Stripping at
// display is not idempotent: cleanTitle('&lt;script&gt;') correctly yields the
// literal text `<script>`, but feeding that back in looks like real markup and
// deletes it. Since display-time cleaning runs on titles that capture already
// cleaned, that is a live data-loss path, not a hypothetical.
//
// It is also unnecessary. Of 180 stored titles, zero contain `<` — and one is
// "RACHEL > MONICA • 1997", which is exactly the reminder that angle brackets
// belong in real titles. Output escaping already makes them safe, so display
// leaves them alone and shows what the author wrote.
//
// STRIP TAGS FIRST, THEN DECODE, at capture. The order is load-bearing.
// Decoding first would turn `&lt;script&gt;` into a real <script> tag, which
// tag-stripping would then delete — silently eating the author's text.
// Stripping first removes only genuine markup, and the decode afterwards
// leaves `<script>` as literal characters that output-escaping renders visible
// and inert.
//
// ONE PASS, NOT RECURSIVE. `&amp;amp;` becomes `&amp;`, not `&`. Decoding
// until nothing changes would corrupt any title legitimately containing the
// text "&amp;", and would let `&amp;lt;` be laundered into a `<`. A single
// pass is also what makes this safe to apply twice: a clean title has nothing
// matching the entity pattern, so it comes back byte-identical.
//
// The output is ALWAYS plain text. Callers escape on output — never assign it
// to innerHTML.

// Named entities a browser title realistically carries. Deliberately short:
// this is a title, not a document, and an unrecognised name is left alone
// rather than guessed at.
const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  nbsp: ' ', ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  hellip: '…', trade: '™', copy: '©', reg: '®',
  deg: '°', middot: '·', bull: '•', eacute: 'é',
  egrave: 'è', agrave: 'à', ccedil: 'ç', uuml: 'ü',
  ouml: 'ö', auml: 'ä', szlig: 'ß', pound: '£',
  euro: '€', yen: '¥', cent: '¢', sect: '§',
  para: '¶', laquo: '«', raquo: '»', times: '×',
  divide: '÷', frac12: '½', frac14: '¼', sup2: '²',
  sup3: '³', micro: 'µ', plusmn: '±'
};

// Code points that must never be produced from a numeric escape. Surrogates
// and out-of-range values would corrupt the string; NUL terminates it in some
// consumers.
function safeCodePoint(n) {
  if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return null;
  if (n >= 0xd800 && n <= 0xdfff) return null;
  try { return String.fromCodePoint(n); } catch (_) { return null; }
}

function decodeAndNormalise(s, maxLength) {
  // Entities decode, exactly once.
  s = s.replace(
    /&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/g,
    (whole, body) => {
      if (body[0] === '#') {
        const hex = body[1] === 'x' || body[1] === 'X';
        const n = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        const ch = safeCodePoint(n);
        return ch === null ? whole : ch;
      }
      const named = NAMED[body];
      if (named !== undefined) return named;
      // Case-insensitive second look: &AMP; is legal in HTML.
      const lower = NAMED[body.toLowerCase()];
      return lower !== undefined ? lower : whole;
    }
  );

  // Titles are one line. Newlines and runs of whitespace collapse, and
  // control characters go — a decoded &#10; must not smuggle a line break
  // into a <title> or an email subject.
  s = s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();

  return maxLength > 0 ? s.slice(0, maxLength) : s;
}

/**
 * CAPTURE. Normalise a title lifted out of generated HTML, or supplied by the
 * operator, into plain text for storage. Strips markup.
 *
 * @param {unknown} input raw title, possibly containing markup or entities
 * @param {number} [maxLength=200] matches the storage cap in _db.js
 * @returns {string} plain text, never HTML
 */
export function cleanTitle(input, maxLength = 200) {
  if (input == null) return '';
  let s = String(input);
  // Comments first, so `<!-- <b> -->` cannot leave a stray fragment behind.
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<[^>]*>/g, '');
  return decodeAndNormalise(s, maxLength);
}

/**
 * DISPLAY. Normalise a stored title on the way to a surface. Decodes entities
 * so records written before the capture fix render correctly with no
 * migration, and does NOT strip markup — see the note at the top of the file.
 * Safe to apply to an already-clean title.
 *
 * @param {unknown} input stored title
 * @param {number} [maxLength=200]
 * @returns {string} plain text; callers escape on output
 */
export function displayTitle(input, maxLength = 200) {
  if (input == null) return '';
  return decodeAndNormalise(String(input), maxLength);
}

export default cleanTitle;
