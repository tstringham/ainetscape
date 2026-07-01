// /api/_dedup.js
//
// Publish-time uniqueness (Part B). Generation stays free; uniqueness is
// enforced only at PUBLISH, via a structural fingerprint of the page.
//
// contentSkeleton() reduces a generated HTML document to a structural skeleton
// by neutralizing everything that legitimately varies between two otherwise-
// identical pages:
//   - image src / srcset URLs (Pexels picks are randomized per render — two
//     true dupes would otherwise look different)
//   - dates (any year / common date format — the date guard + counters move)
//   - counter / upvote / hit-style numbers (and incidental numeric values)
//   - insignificant attributes (style, class, id, data-*, aria-*, on*, width,
//     height, loading, referrerpolicy, …)
//   - whitespace / comments
//
// What's left is tag structure + visible copy + <style>/<script> bodies. Two
// genuinely different generations (different layout or copy) hash differently
// and publish freely; only a near-identical reproduction collides. This is a
// safety net for the rare exact-dupe, not a similarity throttle.

import crypto from 'crypto';

export function contentSkeleton(html) {
  let s = String(html || '');

  // 1. Drop comments.
  s = s.replace(/<!--[\s\S]*?-->/g, '');

  // 2. Neutralize image URLs (randomized per render) — src, srcset, CSS url().
  s = s.replace(/\s(?:src|srcset)\s*=\s*("[^"]*"|'[^']*')/gi, '');
  s = s.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)]*)\)/gi, 'url()');

  // 3. Drop insignificant attributes (presentation / behavior / identifiers).
  s = s.replace(
    /\s(?:style|class|id|width|height|loading|referrerpolicy|decoding|fetchpriority|tabindex|role|target|rel|alt|title|placeholder|aria-[\w-]+|data-[\w-]+|on\w+)\s*=\s*("[^"]*"|'[^']*')/gi,
    ''
  );

  // 4. Strip dates: 4-digit years and common dd/mm/yy(yy) forms.
  s = s.replace(/\b(?:19|20)\d{2}\b/g, '');
  s = s.replace(/\b\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}\b/g, '');

  // 5. Strip counter / upvote / hit-style numbers (and incidental numerics).
  //    Pure digit (comma-grouped) tokens only — hex colors / ids survive.
  s = s.replace(/\b\d[\d,]*\b/g, '');

  // 6. Collapse whitespace; normalize case.
  s = s.replace(/>\s+</g, '><').replace(/\s+/g, ' ').trim().toLowerCase();

  return s;
}

export function contentHash(html) {
  return crypto.createHash('sha256').update(contentSkeleton(html), 'utf8').digest('hex');
}
