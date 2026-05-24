// Shared share-dialog module. Single source of truth for the "Share This
// Page" modal used by:
//   - the homepage editor (after AI generation, via the Share toolbar)
//   - artifact-cluster.js on /p/[slug] (via the Share button in the
//     right-cluster)
//
// Both surfaces call into window.AINetscape.shareDialog.open(opts) so a
// change here lands on both at once. Self-contained: no external CSS,
// no dependency on the homepage's openCustomDialog system, so it works
// inside an AI-generated page without leaning on any page chrome.
//
// opts:
//   slug      — required, the canonical /p/[slug] identifier
//   getTitle  — () => string. Resolves the current document title at
//               share time so renames between dialog opens are honored.
//   onTrack   — (eventName, params) => void. Optional. Both surfaces
//               pass their own analytics router (trackEvent / gtag).

(function () {
  const ROOT = (window.AINetscape = window.AINetscape || {});
  if (ROOT.shareDialog) return;   // idempotent if double-loaded

  let dialogEl = null;

  function open(opts) {
    opts = opts || {};
    if (dialogEl) return;
    const slug = String(opts.slug || '');
    if (!slug) return;
    const getTitle = typeof opts.getTitle === 'function'
      ? opts.getTitle
      : () => (document.title || '').trim() || 'Untitled';
    const onTrack = typeof opts.onTrack === 'function' ? opts.onTrack : noop;

    const shareUrl = location.origin + '/p/' + slug;
    const hasNative = typeof navigator !== 'undefined' && typeof navigator.share === 'function';

    const wrap = document.createElement('div');
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-labelledby', 'ainetscape-share-title');
    wrap.style.cssText =
      'position:fixed; inset:0; z-index:2147483647; ' +
      'background:rgba(0,0,0,0.45); display:flex; align-items:center; ' +
      'justify-content:center; padding:12px;';

    wrap.innerHTML =
      '<div style="background:#c0c0c0; border:2px solid; ' +
        'border-color:#fff #404040 #404040 #fff; box-shadow:2px 2px 0 rgba(0,0,0,0.4); ' +
        'max-width:460px; width:100%; font-family:\'MS Sans Serif\',Tahoma,sans-serif;">' +

        '<div style="background:#000080; color:#fff; padding:3px 6px; ' +
          'font-weight:bold; font-size:11px; display:flex; align-items:center;">' +
          '<span id="ainetscape-share-title" style="flex:1;">Share This Page</span>' +
          '<button data-x type="button" aria-label="Close" ' +
            'style="background:#c0c0c0; border:1px solid; ' +
            'border-color:#fff #404040 #404040 #fff; color:#000; ' +
            'font:bold 9px sans-serif; width:16px; height:14px; ' +
            'line-height:10px; padding:0; cursor:pointer;">✕</button>' +
        '</div>' +

        '<div style="padding:12px;">' +
          '<div style="font-size:11px; margin-bottom:10px;">' +
            'Your page has its own URL. Anyone with this link can view it.' +
          '</div>' +
          '<input data-url type="text" readonly value="' + escapeAttr(shareUrl) + '" ' +
            'style="width:100%; box-sizing:border-box; padding:4px 6px; ' +
            'font:11px \'Courier New\',monospace; border:1px solid #404040; background:#fff;" />' +
          '<div data-toast style="font-size:10px; color:#080; ' +
            'margin-top:6px; min-height:14px; visibility:hidden;">' +
            'Link copied to clipboard.</div>' +
          '<div style="display:flex; gap:6px; justify-content:flex-end; margin-top:6px; flex-wrap:wrap;">' +
            btn('copy', 'Copy Link', true) +
            btn('email', 'Email', false) +
            (hasNative ? btn('native', 'Share…', false) : '') +
            btn('close', 'Close', false) +
          '</div>' +
        '</div>' +
      '</div>';

    document.body.appendChild(wrap);
    dialogEl = wrap;

    wrap.addEventListener('click', e => { if (e.target === wrap) close(); });
    on(wrap, '[data-x]', close);
    on(wrap, '[data-act="close"]', close);
    on(wrap, '[data-act="copy"]', () => copy(shareUrl, slug, onTrack));
    on(wrap, '[data-act="email"]', () => emailShare(shareUrl, slug, getTitle, onTrack));
    if (hasNative) on(wrap, '[data-act="native"]', () => nativeShare(shareUrl, slug, getTitle, onTrack));

    const escListener = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', escListener);
    wrap._escListener = escListener;

    setTimeout(() => {
      const inp = wrap.querySelector('[data-url]');
      if (inp) { inp.focus(); inp.select(); }
    }, 0);

    onTrack('share_dialog_opened', { slug: slug });
  }

  function close() {
    if (!dialogEl) return;
    if (dialogEl._escListener) document.removeEventListener('keydown', dialogEl._escListener);
    dialogEl.remove();
    dialogEl = null;
  }

  function composePayload(shareUrl, getTitle) {
    const title = (getTitle() || '').trim() || 'Untitled';
    const subject = title + " (Generated by AI Netscape - 1997's AI-Powered HTML Editor)";
    const body =
      'Check out the page I just generated on AI Netscape:\n\n' +
      '  ' + title + '\n' +
      '  ' + shareUrl + '\n\n' +
      '— — —\n\n' +
      'AI Netscape is a 1997-era HTML editor with one impossible button: ' +
      'a modern AI that builds a complete state-of-the-art website from a ' +
      'one-line brief, in under a minute. No signup, no payment, modem ' +
      'sounds included.\n\n' +
      'Try it yourself: https://ainetscape.com\n\n' +
      '— — —\n\n' +
      "AI Netscape 4.7  •  1997's AI-Powered HTML Editor  •  © 1997 AI Netscape, All Rights Reserved";
    return { title, subject, body };
  }

  function copy(shareUrl, slug, onTrack) {
    const toast = dialogEl && dialogEl.querySelector('[data-toast]');
    const finish = ok => {
      if (toast) {
        toast.textContent = ok ? 'Link copied to clipboard.'
          : 'Could not copy — select the URL above and copy manually.';
        toast.style.color = ok ? '#080' : '#a00';
        toast.style.visibility = 'visible';
      }
      onTrack('share_link_copied', { slug: slug, ok: !!ok });
    };
    try {
      navigator.clipboard.writeText(shareUrl).then(() => finish(true), () => finish(false));
    } catch (_) { finish(false); }
  }

  function emailShare(shareUrl, slug, getTitle, onTrack) {
    const p = composePayload(shareUrl, getTitle);
    window.location.href = 'mailto:?subject=' + encodeURIComponent(p.subject) +
      '&body=' + encodeURIComponent(p.body);
    onTrack('share_email_opened', { slug: slug });
  }

  function nativeShare(shareUrl, slug, getTitle, onTrack) {
    const p = composePayload(shareUrl, getTitle);
    try {
      navigator.share({ title: p.subject, text: p.body, url: shareUrl }).then(
        () => { onTrack('share_native_completed', { slug: slug }); close(); },
        () => {}    // user cancelled
      );
    } catch (_) {}
  }

  function btn(key, label, primary) {
    const style =
      'font:11px \'MS Sans Serif\',Tahoma,sans-serif; color:#000; ' +
      'background:#c0c0c0; border:2px solid; ' +
      'border-color:#fff #404040 #404040 #fff; ' +
      'padding:3px 14px; min-width:74px; cursor:pointer;' +
      (primary ? ' font-weight:bold;' : '');
    return '<button type="button" data-act="' + key + '" style="' + style + '">' + label + '</button>';
  }
  function on(root, sel, fn) {
    root.querySelectorAll(sel).forEach(el => el.addEventListener('click', fn));
  }
  function escapeAttr(s) {
    return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function noop() {}

  ROOT.shareDialog = { open, close, composePayload };
})();
