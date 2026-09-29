// Tests for cleanTitle(). Run: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanTitle, displayTitle } from '../api/_title.js';

test('named entity: &amp; becomes a bare ampersand', () => {
  assert.equal(cleanTitle('BEAD &amp; BONE — The Unauthorised History'),
                          'BEAD & BONE — The Unauthorised History');
  assert.equal(cleanTitle('Silk &amp; Shadow'), 'Silk & Shadow');
});

test('decimal entity: &#39; becomes an apostrophe', () => {
  assert.equal(cleanTitle('It&#39;s 1997'), "It's 1997");
});

test('hex entity: &#x27; becomes an apostrophe', () => {
  assert.equal(cleanTitle('It&#x27;s 1997'), "It's 1997");
  assert.equal(cleanTitle('It&#X27;s 1997'), "It's 1997", 'uppercase X is legal');
});

test('&quot; becomes a double quote', () => {
  assert.equal(cleanTitle('The &quot;Best&quot; Page'), 'The "Best" Page');
});

test('&lt;script&gt; survives as literal text and cannot execute', () => {
  const out = cleanTitle('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(out, '<script>alert(1)</script>',
    'decodes to the characters the author wrote');
  // The guarantee that matters: escaped on output it is inert and visible.
  const escaped = out.replace(/[&<>"]/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  assert.equal(escaped, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.ok(!/<script/i.test(escaped), 'no executable tag reaches the page');
});

test('real markup is stripped rather than rendered', () => {
  assert.equal(cleanTitle('<b>Bold</b> Title'), 'Bold Title');
  assert.equal(cleanTitle('<script>alert(1)</script>Hello'), 'alert(1)Hello',
    'tags go; their text content is not executable');
  assert.equal(cleanTitle('<!-- <b>hidden</b> -->Visible'), 'Visible');
});

test('double-encoded &amp;amp; decodes exactly one level', () => {
  assert.equal(cleanTitle('A &amp;amp; B'), 'A &amp; B',
    'one pass — decoding twice would corrupt a title that really says &amp;');
});

test('a clean title with a raw em dash is untouched', () => {
  const clean = 'BEAD & BONE — The Unauthorised History';
  assert.equal(cleanTitle(clean), clean);
  assert.equal(cleanTitle('Plain Title 1997'), 'Plain Title 1997');
});

const CASES = [
  'BEAD &amp; BONE — The Unauthorised History', 'It&#39;s 1997',
  '&lt;script&gt;alert(1)&lt;/script&gt;', 'A &amp;amp; B',
  'BEAD & BONE — The Unauthorised History', '<b>Bold</b> Title',
  'Caf&eacute; &mdash; 1997', 'RACHEL > MONICA • 1997', ''
];

test('displayTitle is idempotent — it is applied to already-captured titles', () => {
  // Every input except nested encoding, which peels one level per pass by
  // definition and is covered by the KNOWN LIMIT test below.
  for (const c of CASES.filter((x) => x !== 'A &amp;amp; B')) {
    const once = displayTitle(c);
    assert.equal(displayTitle(once), once, `not idempotent for: ${JSON.stringify(c)}`);
  }
});

test('displayTitle over cleanTitle is stable for every realistic title', () => {
  // Capture writes plain text, so the display pass finds no entities left and
  // changes nothing. Double-encoded input is the one exception and is covered
  // separately below.
  for (const c of CASES.filter((x) => x !== 'A &amp;amp; B')) {
    const stored = cleanTitle(c);               // what capture would write
    assert.equal(displayTitle(stored), stored,  // what display would show
      `display altered a captured title: ${JSON.stringify(c)}`);
  }
});

test('KNOWN LIMIT: double-encoded input decodes twice across capture + display', () => {
  // A browser renders <title>A &amp;amp; B</title> as "A &amp; B", so the
  // correct plain text keeps one level of encoding. Capture gets that right.
  assert.equal(cleanTitle('A &amp;amp; B'), 'A &amp; B');
  // But display decodes what capture stored, and cannot tell a legacy raw
  // entity from a legitimately-stored one. The result loses the second level.
  assert.equal(displayTitle(cleanTitle('A &amp;amp; B')), 'A & B');
  // Accepted deliberately. Fixing it needs a per-row "already cleaned" flag
  // threaded through every projection and surface, to correct a case that
  // requires the model to emit a double-encoded entity in a <title>. Zero of
  // 180 stored titles do. Documented here so the next person finds the
  // decision rather than the surprise.
});

test('displayTitle does NOT strip markup, so real titles keep their brackets', () => {
  assert.equal(displayTitle('RACHEL > MONICA • 1997'), 'RACHEL > MONICA • 1997');
  // The case that forced the split: capture yields literal <script>, and a
  // display pass must not then delete it.
  const captured = cleanTitle('&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(captured, '<script>alert(1)</script>');
  assert.equal(displayTitle(captured), '<script>alert(1)</script>',
    'display must not treat captured text as markup');
});

test('displayTitle fixes legacy rows without a migration', () => {
  assert.equal(displayTitle('BEAD &amp; BONE — The Unauthorised History'),
                            'BEAD & BONE — The Unauthorised History');
  assert.equal(displayTitle('Silk &amp; Shadow'), 'Silk & Shadow');
});

test('unknown entities are left alone rather than guessed at', () => {
  assert.equal(cleanTitle('A &notarealentity; B'), 'A &notarealentity; B');
  assert.equal(cleanTitle('Fish & Chips'), 'Fish & Chips', 'bare & is not an entity');
});

test('numeric escapes cannot smuggle control characters or bad code points', () => {
  assert.equal(cleanTitle('A&#10;B'), 'A B', 'newline collapses to a space');
  assert.equal(cleanTitle('A&#0;B'), 'A&#0;B', 'NUL is refused, left literal');
  assert.equal(cleanTitle('A&#xD800;B'), 'A&#xD800;B', 'lone surrogate refused');
  assert.equal(cleanTitle('A&#9999999;B'), 'A&#9999999;B', 'out of range refused');
});

test('whitespace collapses and the length cap holds', () => {
  assert.equal(cleanTitle('  spaced   out  \n title '), 'spaced out title');
  assert.equal(cleanTitle('x'.repeat(300)).length, 200);
  assert.equal(cleanTitle('&amp;'.repeat(100), 10).length, 10);
});

test('nullish and non-string input degrade to an empty string', () => {
  assert.equal(cleanTitle(null), '');
  assert.equal(cleanTitle(undefined), '');
  assert.equal(cleanTitle(123), '123');
});
