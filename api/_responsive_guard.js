// /api/_responsive_guard.js
//
// A small responsive baseline injected into every generated document at
// serve/render time. Files prefixed "_" are not routed as endpoints.
//
// WHY THIS EXISTS. Model-authored pages are laid out for a desktop canvas and
// occasionally emit one declaration that pins the document wider than a phone.
// On /p/jaGCbbjgv3 it was a single `min-width: 1100px` on a timeline row: its
// `overflow-x:auto` container failed to isolate it, the hero block above it is
// a FLEX ITEM (so `min-width:auto`, unable to shrink below min-content), and
// the whole document laid out at 1124px inside a 375px viewport. The h1 was
// clipped right, the timeline clipped left, and `body{overflow-x:hidden}` meant
// neither scrolled. Measured in WebKit: scrollWidth 1124 against clientWidth 375.
//
// IT IS NOT A HOST PROBLEM. Both surfaces size their iframe correctly — on /p/
// at 375px the frame computes to 351px and the outer page has zero overflow.
// The document overflows inside a correctly-sized container, so the correction
// has to be in the document. No container change would have helped.
//
// APPLIED AT RENDER, NOT AT GENERATION, so it reaches every page already
// published without regenerating anything:
//   - prepareDocument()  (api/page/[slug]/index.js) -> serves /p/<slug>/raw
//   - generate.js        -> the stream the editor canvas mounts, and the stored copy
//
// DESKTOP MUST NOT MOVE. Everything corrective is scoped to
// @media (max-width:600px). The always-on rules are limited to things that
// cannot change a working desktop layout: a border-box box model, media that
// does not exceed its column, and long strings that wrap. Verified by
// measuring all six reference pages at 1280px before and after — identical.
//
// ON `!important`: the guard is injected FIRST in <head>, so author rules win
// on equal specificity. The mobile block has to beat author declarations like
// `.timeline{min-width:1100px}`, so those few rules are marked. The always-on
// rules are not, and defer to the author.

const MARKER = 'ai-responsive-guard';

const GUARD_CSS = `
/* Media never exceeds its column. Carried over verbatim from the rule this
   replaces, height:auto included, so nothing already shipping changes. */
img,svg,video,canvas{max-width:100%!important;height:auto;}
/* iframe/table get the width cap but NOT height:auto — they have no intrinsic
   ratio and can collapse to nothing. */
iframe,table{max-width:100%;}
/* Long strings wrap instead of forcing the column wider. */
h1,h2,h3,h4,h5,h6,p,li,blockquote,dd,dt,figcaption,td,th,a{overflow-wrap:break-word;}
/* The document itself never exceeds the viewport. Applied to html AS WELL AS
   body: overflow-x on body alone is unreliable and is exactly what the
   reference page did. */
html,body{max-width:100%;}
html,body{overflow-x:hidden;}

/* CORRECTIVE LAYER — 820px, not 600px.
   The editor canvas is a bounded frame ~788px wide (the SYSTEM_PROMPT calls it
   "a bounded ~780px editor frame"), and media queries inside an iframe evaluate
   against the FRAME, not the device. A 600px breakpoint therefore misses the
   surface the author actually works in: with the block at 600px, the reference
   page was still laying out at 1100px inside a 788px frame and was merely being
   clipped by overflow-x:hidden rather than reflowed. 820px covers phones,
   tablets and the editor frame, and stays clear of a full-width desktop /p/. */
@media (max-width:820px){
  /* THE RULE THAT DOES THE WORK. An author min-width above the available width
     is the single most common cause of a page laying out wider than its
     container, and because flex items default to min-width:auto it propagates
     up through ancestors that look like they should contain it. */
  *{min-width:0!important;}
  /* Rows stack instead of running off the edge. flex-wrap is inert on anything
     that is not a flex container, so applying it broadly is safe. */
  *{flex-wrap:wrap!important;}
  /* Belt and braces. Unmarked, so an author rule with real intent still wins. */
  body *{max-width:100%;}
}

@media (max-width:600px){
  /* Predictable box model, PHONES ONLY. Applied globally this measurably moved
     desktop layout on three of six reference pages — Silicon Singles lost 48px
     off a row, NEURAL SYNTH 40px, LANDSCAPE CANVAS 1px — because those pages
     were authored against content-box and border-box absorbs padding and
     borders into the declared width. Kept out of the 820px block for the same
     reason: that block reaches the editor canvas on a desktop machine. */
  *,*::before,*::after{box-sizing:border-box;}
  /* Flex items size to their CONTENT, so a row that no longer fits wraps onto
     a new line instead of squeezing into unreadable columns.
     flex:1 is shorthand for flex-basis:0, which means "ignore my content and
     split the line evenly". Combined with min-width:0 above, five timeline
     entries collapsed to ~70px each and their labels overlapped — no element
     was wider than the viewport, so a width-based check passed while the page
     was unreadable. flex-basis:auto restores content-sizing; flex-wrap above
     then does the actual wrapping. Rows that still fit are left alone. */
  *{flex-basis:auto!important;}
  /* Display type breaks rather than overflows. Deliberately NOT a blanket
     font-size override: resizing every heading would visibly change the pages
     that already render correctly, which is most of them. Oversized type is
     constrained at the source instead, by the MOBILE directive in
     generate.js's SYSTEM_PROMPT. */
  h1,h2,h3{overflow-wrap:anywhere;}
}
`.trim();

const VIEWPORT_META = '<meta name="viewport" content="width=device-width, initial-scale=1">';

/**
 * Inject the responsive baseline into a generated document.
 *
 * Idempotent (checks for the marker) and never throws — a failed inject ships
 * the document unchanged, exactly like injectCtaDispatch.
 *
 * @param {string} html a full generated document
 * @returns {string}
 */
export function injectResponsiveGuard(html) {
  try {
    let out = String(html == null ? '' : html);
    if (out.includes(MARKER)) return out;

    let head = '';
    // Most generated pages ship a viewport meta; some do not, and without one
    // none of the rest of this matters — the page renders at 980px and scales down.
    if (!/<meta[^>]+name=["']?viewport/i.test(out)) head += VIEWPORT_META;
    head += '<style id="' + MARKER + '">' + GUARD_CSS + '</style>';

    if (/<head[^>]*>/i.test(out))      return out.replace(/<head[^>]*>/i, (m) => m + head);
    if (/<html[^>]*>/i.test(out))      return out.replace(/<html[^>]*>/i, (m) => m + '<head>' + head + '</head>');
    return head + out;
  } catch (_) {
    return html;
  }
}
