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
//      /api/site-stats/homepage, which seeds the counter at 420 on
//      first call and increments per-IP/day-deduped on subsequent
//      visits. Zero-padded to 5 digits up to 99999, then 6.
//
// Failure modes are silent: a stuck network leaves the placeholder
// em-dash in place rather than throwing an alarm into the starter
// doc.

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
  fetch('/api/site-stats/homepage', { credentials: 'omit' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) {
      if (!j || typeof j.count !== 'number') return;
      slot.textContent = formatVisits(j.count);
    })
    .catch(function () { /* keep em-dash */ });

  function formatVisits(n) {
    n = Math.max(0, Number(n) || 0);
    const s = String(n);
    return s.length < 5 ? s.padStart(5, '0') : s;
  }
})();
