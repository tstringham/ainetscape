// Wiring for the artifact-cluster engagement actions on /p/[slug] pages.
// Loaded from a separate file so /p/[slug] HTML stays small and the
// browser can cache this once per origin.
//
// Reads the slug from data-slug on the cluster root. Wires:
//   - Stats:  fetch /api/page/[slug]/stats on load, populate
//             vote/hit/sotw skeleton (counts aren't in the cached body)
//   - Upvote: POST /api/vote, optimistic count update, "voted" lock
//   - Share:  delegates to window.AINetscape.shareDialog (loaded via
//             share-dialog.js — single source of truth shared with the
//             homepage editor's Share toolbar)
//   - Report: mailto:webmaster@ainetscape.com with the URL pre-filled

(function () {
  const cluster = document.querySelector('[data-artifact-cluster]');
  if (!cluster) return;
  const slug = cluster.getAttribute('data-slug') || '';
  if (!slug) return;

  // ---------------- Stats hydration ----------------
  // The cached HTML ships with a skeleton (— placeholders); we fetch
  // live counts on every page load so the numbers are always fresh,
  // independent of the 24h edge cache on the body. The endpoint also
  // increments hits (deduped one-per-IP-per-day server-side).
  const voteCount = cluster.querySelector('[data-vote-count]');
  const hitCount  = cluster.querySelector('[data-hit-count]');
  const sotwEl    = cluster.querySelector('[data-sotw]');
  fetch('/api/page/' + encodeURIComponent(slug) + '/stats', { credentials: 'omit' })
    .then(r => r.ok ? r.json() : null)
    .then(j => {
      if (!j) return;
      if (voteCount && typeof j.upvotes === 'number') voteCount.textContent = formatCount(j.upvotes);
      if (hitCount  && typeof j.hits === 'number')    hitCount.textContent  = formatCount(j.hits);
      if (sotwEl && j.site_of_the_week) sotwEl.hidden = false;
    })
    .catch(() => { /* keep skeleton on failure */ });

  // ---------------- Upvote ----------------
  const upvoteBtn = cluster.querySelector('[data-action="upvote"]');
  if (upvoteBtn) {
    upvoteBtn.addEventListener('click', async function (ev) {
      ev.preventDefault();
      if (upvoteBtn.classList.contains('voted') || upvoteBtn.disabled) return;
      upvoteBtn.disabled = true;
      try {
        const resp = await fetch('/api/vote', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug: slug })
        });
        const j = await resp.json().catch(function () { return {}; });
        if (resp.ok && typeof j.upvotes === 'number' && voteCount) {
          voteCount.textContent = formatCount(j.upvotes);
        }
        upvoteBtn.classList.add('voted');
      } catch (_) {
        upvoteBtn.disabled = false;
      }
    });
  }

  // ---------------- Share ----------------
  const shareBtn = cluster.querySelector('[data-action="share"]');
  if (shareBtn) {
    shareBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      const dlg = window.AINetscape && window.AINetscape.shareDialog;
      if (!dlg) return;   // share-dialog.js failed to load; nothing to do
      dlg.open({
        slug: slug,
        getTitle: () => document.title,
        onTrack: (e, p) => { try { window.gtag && window.gtag('event', e, p); } catch (_) {} }
      });
    });
  }

  // ---------------- Report ----------------
  const reportBtn = cluster.querySelector('[data-action="report"]');
  if (reportBtn) {
    reportBtn.addEventListener('click', function (ev) {
      ev.preventDefault();
      const shareUrl = location.origin + '/p/' + slug;
      const subject = 'Report — ' + shareUrl;
      const body = 'Reporting page: ' + shareUrl + '\n\n' +
                   'Reason (please describe):\n\n';
      window.location.href = 'mailto:webmaster@ainetscape.com' +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    });
  }

  function formatCount(n) {
    n = Number(n) || 0;
    return n < 1000 ? String(n) : n.toLocaleString('en-US');
  }
})();
