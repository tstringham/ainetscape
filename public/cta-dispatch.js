/* AI Netscape — generated-page CTA / contact dispatcher.
 *
 * Injected into every generated page by api/generate.js (and into pages generated
 * before it existed by api/page/[slug]/index.js at render time) as:
 *   <script src="https://ainetscape.com/cta-dispatch.js"
 *           data-cta-page="https://ainetscape.com/p/<slug>" defer></script>
 *
 * Generated pages run inside a sandboxed, opaque-origin iframe (no
 * allow-same-origin on /p/:slug), so this POSTs to the ABSOLUTE endpoint with a
 * CORS-simple (text/plain) request, fire-and-forget, and ALWAYS shows the 1997
 * "dispatched to the webmaster" confirmation. Delivery success is never the
 * visitor's problem. Everything is wrapped so a failure can't break the page.
 */
(function () {
  'use strict';

  var ENDPOINT = 'https://ainetscape.com/api/cta';
  var CONFIRM_TEXT = 'Your message has been dispatched to the webmaster.';

  // Canonical /p/<slug> URL, injected at generation time — location.href is
  // useless here (about:srcdoc inside the iframe).
  function pageUrl() {
    try {
      var s = document.querySelector('script[data-cta-page]');
      return (s && s.getAttribute('data-cta-page')) || '';
    } catch (e) { return ''; }
  }

  function collectFields(form) {
    var fields = {};
    if (!form || !form.elements) return fields;
    for (var i = 0; i < form.elements.length; i++) {
      var el = form.elements[i];
      if (!el.name) continue;
      var t = (el.type || '').toLowerCase();
      if (t === 'submit' || t === 'button' || t === 'file' || t === 'password') continue;
      if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
      fields[el.name] = el.value;
    }
    return fields;
  }

  function send(payload) {
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        // text/plain keeps this a CORS-simple request (no preflight) so it
        // reaches the server from the opaque-origin iframe. The body is JSON;
        // the server parses it regardless of Content-Type.
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify(payload),
        keepalive: true
      }).catch(function () {});
    } catch (e) { /* fire-and-forget */ }
  }

  function showConfirm() {
    try {
      var id = '__ai-cta-confirm';
      var existing = document.getElementById(id);
      if (existing) return;
      var box = document.createElement('div');
      box.id = id;
      box.setAttribute('role', 'status');
      box.textContent = CONFIRM_TEXT;
      box.style.cssText = [
        'position:fixed', 'left:50%', 'bottom:24px', 'transform:translateX(-50%)',
        'z-index:2147483647', 'max-width:90%', 'padding:12px 18px',
        'background:#000', 'color:#fff',
        'font:13px/1.4 -apple-system,BlinkMacSystemFont,Segoe UI,Tahoma,sans-serif',
        'border:2px solid #fff', 'box-shadow:0 2px 14px rgba(0,0,0,.5)',
        'text-align:center', 'pointer-events:none'
      ].join(';');
      document.body.appendChild(box);
      setTimeout(function () { try { box.parentNode && box.parentNode.removeChild(box); } catch (e) {} }, 6000);
    } catch (e) { /* never let the confirmation throw */ }
  }

  // A submission is held for a moment before sending. A legacy page's own submit
  // handler may follow up by building a mailto: (see __aiMailto below); its
  // subject and body then fold into this same payload, so the webmaster gets one
  // email carrying both the raw fields and the page's composed message.
  var pending = null;
  var lastDispatchAt = 0;
  function flushPending() {
    if (!pending) return;
    var p = pending; pending = null;
    send(p.payload);
  }
  function pageHasOwnConfirmation() {
    try { return /dispatched to the webmaster/i.test(document.body.textContent || ''); } catch (e) { return false; }
  }
  function dispatch(triggerEl, label, form) {
    lastDispatchAt = Date.now();
    var payload = {
      title: (document.title || '').slice(0, 140),
      url: pageUrl(),
      action: String(label || (triggerEl && (triggerEl.value || triggerEl.textContent)) || '')
        .replace(/\s+/g, ' ').trim().slice(0, 140),
      fields: form ? collectFields(form) : {}
    };
    if (pending) clearTimeout(pending.timer);
    pending = { payload: payload, timer: setTimeout(flushPending, 200) };
    if (!pageHasOwnConfirmation()) showConfirm();
  }

  // Public API for single-CTA buttons/links not inside a form:
  //   onclick="return __aiDispatch(this,'Reserve a table')"
  window.__aiDispatch = function (el, label) {
    var form = el && (el.form || (el.closest ? el.closest('form') : null));
    dispatch(el, label, form || null);
    return false; // prevent navigation / native submit
  };

  // ---- Legacy pages. Pages generated before the dispatcher existed launch mail
  // with a mailto: link or by assigning window.location.href. The share page
  // rewrites those assignments to __aiLoc.href (see api/page/[slug]/index.js) and
  // this block turns both forms into a dispatch, so the visitor never leaves the
  // page and the webmaster still receives the submission. The mailto subject and
  // body carry whatever the page collected, so they travel as fields.
  var lastMail = { href: '', t: 0 };
  // The click currently being dispatched (set in the capture listener below,
  // cleared once the event has finished). A handler on a bare "#" link that
  // builds a mailto: used to have that navigation replaced by the mail launch;
  // now that the launch is a dispatch, the "#" default would load the share
  // page inside its own frame, so the dispatch cancels the click instead.
  var activeClick = null;
  function parseMailto(href) {
    var out = { subject: '', body: '' };
    try {
      var q = href.indexOf('?'); if (q < 0) return out;
      href.slice(q + 1).split('&').forEach(function (kv) {
        var i = kv.indexOf('=');
        var k = decodeURIComponent((i < 0 ? kv : kv.slice(0, i)).replace(/\+/g, ' ')).toLowerCase();
        var v = decodeURIComponent((i < 0 ? '' : kv.slice(i + 1)).replace(/\+/g, ' '));
        if (k === 'subject' || k === 'body') out[k] = v;
      });
    } catch (e) { /* malformed query: send what we have */ }
    return out;
  }
  window.__aiMailto = function (href) {
    href = String(href == null ? '' : href).trim();
    if (!/^mailto:/i.test(href)) return false;
    var now = Date.now();
    if (href === lastMail.href && now - lastMail.t < 2000) return true; // one click reaching us twice
    lastMail = { href: href, t: now };
    if (activeClick) { try { activeClick.preventDefault(); } catch (e) {} }
    var m = parseMailto(href);
    if (pending) {
      // Same submission as the form the auto-wire is holding: enrich it, send once.
      if (m.subject) {
        pending.payload.fields.subject = m.subject;
        if (pending.payload.action === 'Form submission') pending.payload.action = m.subject.slice(0, 140);
      }
      if (m.body) pending.payload.fields.body = m.body;
      return true;
    }
    if (now - lastDispatchAt < 2000) return true; // straggler after that window: already delivered
    var fields = {};
    if (m.subject) fields.subject = m.subject;
    if (m.body) fields.body = m.body;
    send({
      title: (document.title || '').slice(0, 140),
      url: pageUrl(),
      action: (m.subject || 'Email the webmaster').replace(/\s+/g, ' ').trim().slice(0, 140),
      fields: fields
    });
    if (!pageHasOwnConfirmation()) showConfirm();
    return true;
  };
  // Assignment target the share page substitutes for window.location.href.
  var loc = {};
  try {
    Object.defineProperty(loc, 'href', {
      get: function () { return window.location.href; },
      set: function (v) { if (!window.__aiMailto(v)) window.location.href = v; }
    });
  } catch (e) { loc = window.location; }
  window.__aiLoc = loc;
  // Anything assigned before this script loaded was parked by the head stub.
  try { (window.__aiMailQueue || []).forEach(function (h) { window.__aiMailto(h); }); window.__aiMailQueue = []; } catch (e) {}
  // Link handling for the sandboxed srcdoc frame the page runs in. Capture phase,
  // and the page's own click handlers still run (they usually print the
  // confirmation or smooth-scroll).
  //  - mailto:            dispatch instead of navigating the frame
  //  - "#", "#id", "", "?": inside a srcdoc frame these resolve to the share
  //                       page's own URL and would load the whole chrome inside
  //                       the frame, so they are handled here: scroll to the
  //                       target if there is one, otherwise do nothing
  //  - links to ainetscape.com open in the top window; other sites in a new tab
  var HOST = /^(www\.)?ainetscape\.com$/i;
  document.addEventListener('click', function (e) {
    activeClick = e;
    setTimeout(function () { if (activeClick === e) activeClick = null; }, 0);
    var t = e.target; while (t && t.nodeType === 1 && t.tagName !== 'A') t = t.parentNode;
    if (!t || t.tagName !== 'A' || !t.hasAttribute('href')) return;
    var h = (t.getAttribute('href') || '').trim();
    if (/^mailto:/i.test(h)) { e.preventDefault(); window.__aiMailto(h); return; }
    if (/^(javascript|tel|sms|data|blob):/i.test(h)) return;
    if (h === '' || h.charAt(0) === '#' || h.charAt(0) === '?') {
      e.preventDefault();
      var id = h.charAt(0) === '#' ? h.slice(1) : '';
      if (id) {
        var el = null;
        try { id = decodeURIComponent(id); } catch (x) {}
        try { el = document.getElementById(id) || document.querySelector('a[name="' + id.replace(/["\\]/g, '') + '"]'); } catch (x) {}
        if (el && el.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }
    if (t.hasAttribute('download') || t.getAttribute('target')) return;
    var abs = null;
    try { abs = new URL(t.href, 'https://ainetscape.com/'); } catch (x) { return; }
    if (abs.protocol !== 'https:' && abs.protocol !== 'http:') return;
    if (HOST.test(abs.host)) { t.setAttribute('target', '_top'); }
    else { t.setAttribute('target', '_blank'); t.setAttribute('rel', 'noopener'); }
  }, true);

  // Auto-wire EVERY form: any contact/order/signup form is delivered to the
  // webmaster on submit even if the model didn't add a handler.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    e.preventDefault();
    dispatch(form, form.getAttribute('name') || form.getAttribute('aria-label') || 'Form submission', form);
  }, true);
})();
