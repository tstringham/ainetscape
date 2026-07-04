/* AI Netscape — generated-page CTA / contact dispatcher.
 *
 * Injected into every generated page by api/generate.js as:
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

  function dispatch(triggerEl, label, form) {
    var payload = {
      title: (document.title || '').slice(0, 140),
      url: pageUrl(),
      action: String(label || (triggerEl && (triggerEl.value || triggerEl.textContent)) || '')
        .replace(/\s+/g, ' ').trim().slice(0, 140),
      fields: form ? collectFields(form) : {}
    };
    send(payload);
    showConfirm();
  }

  // Public API for single-CTA buttons/links not inside a form:
  //   onclick="return __aiDispatch(this,'Reserve a table')"
  window.__aiDispatch = function (el, label) {
    var form = el && (el.form || (el.closest ? el.closest('form') : null));
    dispatch(el, label, form || null);
    return false; // prevent navigation / native submit
  };

  // Auto-wire EVERY form: any contact/order/signup form is delivered to the
  // webmaster on submit even if the model didn't add a handler.
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (!form || form.tagName !== 'FORM') return;
    e.preventDefault();
    dispatch(form, form.getAttribute('name') || form.getAttribute('aria-label') || 'Form submission', form);
  }, true);
})();
