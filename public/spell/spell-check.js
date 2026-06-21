// /public/spell/spell-check.js
//
// Real Netscape-Composer-style Check Spelling for the WYSIWYG editor.
// Word-by-word workflow with Suggestions list + Ignore / Ignore All /
// Change / Change All / Add to Dictionary / Done. Powered by Typo.js
// (loaded from /spell/typo.js) + the Hunspell en_US dictionary in
// /spell/en_US.{aff,dic}. Fully client-side; runs offline after the
// first dictionary fetch (which is itself cacheable by the browser).
//
// Public surface — attached to window.AINetscape.spelling:
//   open()  — start a Spelling session against the current editor
//
// Storage:
//   localStorage  "spell:custom"  — user's "Add to Dictionary" words
//   sessionStorage "spell:ignore" — words ignored during this session
//
// The modal HTML lives in index.html (#dlg-spell). This file finds it
// by id, fills the labels, and wires the buttons.

(function () {
  const STATE = {
    typo: null,                 // Typo.js instance once loaded
    loading: null,              // shared promise for in-flight load
    misspellings: null,         // queued list of pending misspellings
    cursor: 0,                  // index in misspellings of the active word
    changeAll: new Map(),       // word → replacement (applied auto on later matches)
    ignoreAll: new Set(),       // words to skip for remainder of session
    sessionAdded: new Set(),    // "Add to Dictionary" tracked locally too
    editorRoot: null            // contenteditable root used by current session
  };

  // ============================================================
  // Persistent helpers
  // ============================================================
  function lsGet(k) { try { return localStorage.getItem(k); } catch (_) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (_) {} }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) {} }

  function loadCustomWords() {
    try {
      const raw = lsGet('spell:custom');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
  }
  function saveCustomWords(setObj) {
    lsSet('spell:custom', JSON.stringify([...setObj]));
  }
  function loadIgnored() {
    try {
      const raw = ssGet('spell:ignore');
      const arr = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(arr) ? arr : []);
    } catch (_) { return new Set(); }
  }
  function saveIgnored(setObj) {
    ssSet('spell:ignore', JSON.stringify([...setObj]));
  }

  // ============================================================
  // Dictionary lazy-load
  // ============================================================
  function loadDictionary() {
    if (STATE.typo)    return Promise.resolve(STATE.typo);
    if (STATE.loading) return STATE.loading;

    STATE.loading = (async () => {
      // Typo lives in a global var. Load via <script> if not already there.
      if (typeof window.Typo === 'undefined') {
        await new Promise((resolve, reject) => {
          const s = document.createElement('script');
          s.src = '/spell/typo.js';
          s.async = true;
          s.onload = resolve;
          s.onerror = () => reject(new Error('Failed to load typo.js'));
          document.head.appendChild(s);
        });
      }
      // Hunspell en_US — ~550 KB plaintext .dic, ~3 KB .aff. Browser HTTP
      // cache makes repeat opens free; first open pays the bandwidth.
      const [affData, dicData] = await Promise.all([
        fetch('/spell/en_US.aff').then(r => r.ok ? r.text() : Promise.reject(new Error('aff fetch'))),
        fetch('/spell/en_US.dic').then(r => r.ok ? r.text() : Promise.reject(new Error('dic fetch')))
      ]);
      STATE.typo = new window.Typo('en_US', affData, dicData, { platform: 'any' });
      return STATE.typo;
    })().catch(err => {
      STATE.loading = null;     // allow retry on the next open
      throw err;
    });
    return STATE.loading;
  }

  // ============================================================
  // Editor traversal
  // ============================================================
  // Words: letters + apostrophes for contractions ("don't", "we're").
  // Numbers and pure-punctuation tokens are skipped. Apostrophes-at-end
  // (possessives) tracked too.
  const WORD_RE = /[A-Za-z][A-Za-z'']*/g;

  function tokenizeEditor(root) {
    // Walk all text nodes inside the editor. For each, find word matches
    // and record (textNode, startOffset, endOffset, word). Result is a
    // flat ordered list — Spelling walks it forward.
    const results = [];
    if (!root) return results;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      if (!text || !text.trim()) continue;
      let m;
      WORD_RE.lastIndex = 0;
      while ((m = WORD_RE.exec(text))) {
        const word = m[0];
        if (word.length < 2) continue;       // single-letter words spotty in Hunspell
        results.push({
          node, start: m.index, end: m.index + word.length, word
        });
      }
    }
    return results;
  }

  function isMisspelled(word, typo, custom, ignored) {
    if (!word) return false;
    // Strip leading/trailing apostrophes that aren't part of the word
    // (a quoted word like 'hello' should still spell-check "hello").
    const stripped = word.replace(/^[''"]+|[''"]+$/g, '');
    if (!stripped) return false;
    if (custom.has(stripped) || custom.has(stripped.toLowerCase())) return false;
    if (ignored.has(stripped) || ignored.has(stripped.toLowerCase())) return false;
    try {
      if (typo.check(stripped)) return false;
    } catch (_) {
      // Dict not loaded somehow — treat as ok to avoid false positives.
      return false;
    }
    return true;
  }

  // ============================================================
  // Replacement — operates on a single misspelling at a time, then
  // re-tokenizes downstream because text node offsets after the swap
  // can no longer be trusted for later items in the original queue.
  // ============================================================
  function applyReplacement(misspelling, replacement) {
    const { node, start, end } = misspelling;
    if (!node || node.nodeType !== Node.TEXT_NODE) return false;
    const before = node.nodeValue.slice(0, start);
    const after  = node.nodeValue.slice(end);
    node.nodeValue = before + replacement + after;
    return true;
  }

  function applyChangeAllRest(word, replacement) {
    // Walk every remaining item (including ones already past), but in
    // practice cursor++ moves us past current. Re-tokenize from current
    // cursor so any prior swaps are accounted for.
    const root = STATE.editorRoot;
    if (!root) return 0;
    let swaps = 0;
    const re = new RegExp(`\\b${escapeRegex(word)}\\b`, 'g');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.nodeValue || '';
      if (!text.includes(word)) continue;
      const updated = text.replace(re, () => { swaps++; return replacement; });
      if (updated !== text) node.nodeValue = updated;
    }
    return swaps;
  }

  function escapeRegex(s) {
    return String(s).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  }

  // ============================================================
  // Modal — reads/writes DOM elements created in index.html (#dlg-spell)
  // ============================================================
  function el(id) { return document.getElementById(id); }

  function renderState() {
    const status   = el('spell-status');
    const wordSlot = el('spell-current-word');
    const ctxSlot  = el('spell-context');
    const sugSlot  = el('spell-suggestions');
    const changeI  = el('spell-change-input');
    const btnIgnore     = el('spell-btn-ignore');
    const btnIgnoreAll  = el('spell-btn-ignore-all');
    const btnChange     = el('spell-btn-change');
    const btnChangeAll  = el('spell-btn-change-all');
    const btnAdd        = el('spell-btn-add');
    const btnDone       = el('spell-btn-done');

    const total = STATE.misspellings ? STATE.misspellings.length : 0;
    const cur   = STATE.misspellings ? STATE.misspellings[STATE.cursor] : null;

    if (!cur) {
      if (wordSlot) wordSlot.textContent = '—';
      if (ctxSlot)  ctxSlot.innerHTML = '';
      if (sugSlot)  sugSlot.innerHTML = '';
      if (changeI)  changeI.value = '';
      if (status)   status.textContent =
        total === 0
          ? 'Spell check complete. No errors found.'
          : 'Spell check complete. ' + total + ' word(s) reviewed.';
      [btnIgnore, btnIgnoreAll, btnChange, btnChangeAll, btnAdd].forEach(b => {
        if (b) b.disabled = true;
      });
      if (btnDone) btnDone.textContent = 'Close';
      return;
    }

    if (wordSlot) wordSlot.textContent = cur.word;
    if (status)   status.textContent =
      'Word ' + (STATE.cursor + 1) + ' of ' + total + ': not in dictionary.';

    // Context preview — show the surrounding text in the node, with
    // the active word highlighted via a span.
    if (ctxSlot) {
      const text = (cur.node && cur.node.nodeValue) || '';
      const before = text.slice(Math.max(0, cur.start - 60), cur.start);
      const word   = text.slice(cur.start, cur.end);
      const after  = text.slice(cur.end, cur.end + 60);
      ctxSlot.innerHTML = '…' + escapeHtml(before) +
        '<span class="spell-hilite">' + escapeHtml(word) + '</span>' +
        escapeHtml(after) + '…';
    }

    // Suggestions: top 5 via Typo.suggest. First one auto-fills the
    // Change-to input. Click a suggestion to replace the field value.
    if (sugSlot) {
      sugSlot.innerHTML = '';
      let suggestions = [];
      try {
        suggestions = STATE.typo.suggest(cur.word, 5) || [];
      } catch (_) {}
      if (suggestions.length === 0) {
        sugSlot.innerHTML = '<li class="spell-no-sug">(no suggestions)</li>';
        if (changeI) changeI.value = cur.word;
      } else {
        if (changeI) changeI.value = suggestions[0];
        suggestions.forEach((s, i) => {
          const li = document.createElement('li');
          li.textContent = s;
          li.tabIndex = 0;
          li.dataset.suggestion = s;
          if (i === 0) li.classList.add('selected');
          li.addEventListener('click', () => {
            // Single-click sets the change field; double-click commits.
            sugSlot.querySelectorAll('.selected').forEach(x => x.classList.remove('selected'));
            li.classList.add('selected');
            if (changeI) changeI.value = s;
          });
          li.addEventListener('dblclick', () => {
            if (changeI) changeI.value = s;
            commitChange(false);
          });
          sugSlot.appendChild(li);
        });
      }
    }

    [btnIgnore, btnIgnoreAll, btnChange, btnChangeAll, btnAdd].forEach(b => {
      if (b) b.disabled = false;
    });
    if (btnDone) btnDone.textContent = 'Done';
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, c => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'
    }[c]));
  }

  // ============================================================
  // Cursor advance — skip subsequent items already matched by change-all
  // or ignore-all, or words still flagged after a prior swap shifted them.
  // After each commit we re-tokenize from scratch so offsets stay valid.
  // ============================================================
  function reseedMisspellings() {
    const custom  = loadCustomWords();
    const ignored = STATE.ignoreAll;
    const root = STATE.editorRoot;
    if (!root || !STATE.typo) {
      STATE.misspellings = [];
      STATE.cursor = 0;
      return;
    }
    const all = tokenizeEditor(root);
    STATE.misspellings = all.filter(m =>
      isMisspelled(m.word, STATE.typo, custom, ignored)
    );
    STATE.cursor = 0;
  }

  function advanceCursor() {
    STATE.cursor += 1;
    if (STATE.cursor < STATE.misspellings.length) renderState();
    else renderState();      // also handles "done" view
  }

  // ============================================================
  // Button actions
  // ============================================================
  function commitIgnore() {
    advanceCursor();
  }
  function commitIgnoreAll() {
    const cur = STATE.misspellings[STATE.cursor];
    if (!cur) return;
    STATE.ignoreAll.add(cur.word);
    STATE.ignoreAll.add(cur.word.toLowerCase());
    const persisted = loadIgnored();
    persisted.add(cur.word);
    saveIgnored(persisted);
    // Drop every queued entry that matches.
    STATE.misspellings = STATE.misspellings.filter(
      m => m.word !== cur.word && m.word.toLowerCase() !== cur.word.toLowerCase()
    );
    if (STATE.cursor > STATE.misspellings.length) STATE.cursor = STATE.misspellings.length;
    renderState();
  }
  function commitChange(all) {
    const cur = STATE.misspellings[STATE.cursor];
    if (!cur) return;
    const repl = (el('spell-change-input').value || '').trim() || cur.word;
    if (all) {
      applyChangeAllRest(cur.word, repl);
    } else {
      applyReplacement(cur, repl);
    }
    // The DOM mutated; re-tokenize so offsets for downstream entries are
    // correct. Then move past whatever's at the current word position.
    reseedMisspellings();
    renderState();
  }
  function commitAddToDictionary() {
    const cur = STATE.misspellings[STATE.cursor];
    if (!cur) return;
    const custom = loadCustomWords();
    custom.add(cur.word);
    saveCustomWords(custom);
    STATE.sessionAdded.add(cur.word);
    // Drop matching entries from the queue.
    STATE.misspellings = STATE.misspellings.filter(
      m => m.word !== cur.word
    );
    if (STATE.cursor > STATE.misspellings.length) STATE.cursor = STATE.misspellings.length;
    renderState();
  }

  function wireButtons() {
    const wire = (id, fn) => {
      const b = el(id);
      if (b && !b.dataset.spellWired) {
        b.addEventListener('click', fn);
        b.dataset.spellWired = '1';
      }
    };
    wire('spell-btn-ignore',     commitIgnore);
    wire('spell-btn-ignore-all', commitIgnoreAll);
    wire('spell-btn-change',     () => commitChange(false));
    wire('spell-btn-change-all', () => commitChange(true));
    wire('spell-btn-add',        commitAddToDictionary);
    wire('spell-btn-done',       closeDialog);
  }

  function openDialog() {
    const dlg = el('dlg-spell');
    if (dlg) dlg.classList.add('open');
  }
  function closeDialog() {
    const dlg = el('dlg-spell');
    if (dlg) dlg.classList.remove('open');
  }

  // ============================================================
  // Public entry — wired to the Spelling button + Tools menu
  // ============================================================
  async function open() {
    const dlg = el('dlg-spell');
    if (!dlg) {
      // Modal not present — fall back to gentle alert so the click
      // doesn't feel dead. (Should never happen in production.)
      window.alert && window.alert('Spelling is unavailable.');
      return;
    }
    wireButtons();
    openDialog();

    // Show the "loading dictionary" state immediately so the dialog opens
    // visibly even if Typo.js + .dic take a moment to download.
    const status = el('spell-status');
    if (status) status.textContent = 'Loading dictionary…';
    const wordSlot = el('spell-current-word');
    if (wordSlot) wordSlot.textContent = '—';
    ['spell-btn-ignore','spell-btn-ignore-all','spell-btn-change',
     'spell-btn-change-all','spell-btn-add'].forEach(id => {
      const b = el(id); if (b) b.disabled = true;
    });

    let typo;
    try {
      typo = await loadDictionary();
    } catch (err) {
      if (status) status.textContent =
        'The dictionary could not be loaded. Please check your connection and try again.';
      console.error('[spell] dictionary load failed:', err);
      return;
    }

    // Find the live editor root each time the dialog is opened — the
    // homepage swaps between the WYSIWYG div and the source-mode textarea,
    // so we want the current one.
    const editor = document.getElementById('editor');
    if (!editor) {
      if (status) status.textContent = 'No document found to spell-check.';
      return;
    }
    STATE.editorRoot = editor;

    // Seed the ignore set from sessionStorage so prior "Ignore All"s carry
    // across multiple Spelling sessions in the same browser session.
    STATE.ignoreAll = loadIgnored();
    STATE.changeAll = new Map();

    reseedMisspellings();
    renderState();
  }

  // Expose
  window.AINetscape = window.AINetscape || {};
  window.AINetscape.spelling = { open };
})();
