// Dynamic homepage stamps. Runs at page load to fill two slots in
// the starter doc that the cached HTML can't render correctly on
// its own:
//
//   1. The "Last updated" line. Month + day come from today's real
//      date; year is locked to 1997 to maintain the site conceit
//      (same rule as the Gallery date formatter). The line rolls
//      forward daily without any redeploy.
//
//   2. The "This page has been visited N times" line. Fetched from
//      /api/site-stats/homepage, which seeds the counter at 1042 on
//      first call and increments once per page load thereafter (no
//      per-IP/day dedupe — see e6b7fc5). Zero-padded to 5 digits up
//      to 99999, then 6.
//
// Failure modes are silent ON THE PAGE: a blocked or failed fetch
// leaves the placeholder markup alone rather than throwing an alarm
// into the starter doc.
//
// DIAGNOSING A "RESET" COUNTER: the placeholder shipped in the markup
// is 01042, which is ALSO the server-side seed value. So a counter
// stuck at 01042 means either a fresh database row or — far more
// likely — a fetch that never landed (429, offline, or a content
// blocker matching "site-stats"). The number cannot tell them apart,
// so this script records what actually happened on the element:
//
//   document.getElementById('visitor-count').dataset.counter
//     → 'live'    the number on screen came from the server
//     → 'blocked' the request failed outright (network/extension)
//     → 'http-<status>'  server answered non-200 (429 = rate limited)
//     → 'degraded-<reason>' server answered but had no real count
//
// Check that attribute in devtools before suspecting the database.

(function () {
  // ---- Last updated ----
  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const d = new Date();
  const dateStr = MONTHS[d.getMonth()] + ' ' + d.getDate() + ', 1997';
  const lu = document.getElementById('last-updated');
  if (lu) lu.textContent = 'Last updated: ' + dateStr;

  // ---- Visitor counter ----
  const slot = document.getElementById('visitor-count');
  if (!slot) return;

  // Mark the state on the element itself so a stuck counter is
  // diagnosable from devtools without reproducing the failure.
  function mark(state, detail) {
    try {
      slot.dataset.counter = state;
      if (state !== 'live') {
        console.warn('[visitor-count] live count unavailable (' + state + ') — ' +
          'showing the placeholder from the page markup, not a reset counter.' +
          (detail ? ' ' + detail : ''));
      }
    } catch (_) {}
  }

  fetch('/api/site-stats/homepage', { credentials: 'omit' })
    .then(function (r) {
      if (!r.ok) { mark('http-' + r.status); return null; }
      return r.json();
    })
    .then(function (j) {
      if (!j) return;
      if (typeof j.count !== 'number') {
        mark('degraded-' + (j.degraded || 'unknown'));
        return;
      }
      slot.textContent = formatVisits(j.count);
      mark('live');
    })
    .catch(function (err) {
      mark('blocked', err && err.message ? String(err.message) : '');
    });

  function formatVisits(n) {
    n = Math.max(0, Number(n) || 0);
    const s = String(n);
    return s.length < 5 ? s.padStart(5, '0') : s;
  }
})();
