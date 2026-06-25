// /api/_ai_providers.js
//
// Config-driven multi-provider AI waterfall. The ordered list of rungs lives
// in Mongo (settings.aiWaterfall, see api/_db.js#getAiWaterfall) and is edited
// from the admin panel without a redeploy; DEFAULT_WATERFALL below is the
// fallback when the settings doc is absent or Mongo is off.
//
// Each rung is { provider, model, enabled }. generate.js attempts the runnable
// rungs in order, BUFFERED (not streamed) — the whole HTML must exist before
// any of it ships so the image post-processor can rewrite placeholders in
// place. On transport error / timeout / empty body we fall through to the next
// rung. A deliberate `REFUSED::` body is terminal — we never shop a refusal to
// another provider (the harm boundary in SYSTEM_PROMPT is narrow and
// intentional; a second model must not "rescue" a refused brief).
//
// Provider names live here and in engineering docs only — never in chrome.
//
// Adding a provider: add an entry to PROVIDERS with its env key(s), endpoint
// kind, and the model IDs the admin panel may pick from. Nothing else changes.

// ------------------------------------------------------------------
// Provider registry
// ------------------------------------------------------------------
// `kind` selects the wire adapter:
//   'openai'    — OpenAI-shaped Chat Completions (xAI, and Gemini via its
//                 OpenAI-compatibility endpoint). System prompt is the first
//                 message; text is choices[0].message.content.
//   'anthropic' — Anthropic Messages API. System prompt is a top-level field;
//                 text is the concatenation of the `text` content blocks.
//
// `models` is the allow-list the admin panel offers and the POST validator
// enforces — a swap to a model not listed here is rejected. Verify IDs against
// each provider's current docs before extending (they version often).
export const PROVIDERS = {
  xai: {
    id: 'xai',
    label: 'Provider A',                       // never user-facing; admin-only
    envKeys: ['XAI_API_KEY'],
    kind: 'openai',
    endpoint: 'https://api.x.ai/v1/chat/completions',
    models: ['grok-4.3', 'grok-4', 'grok-4.1-fast-reasoning']
  },
  gemini: {
    id: 'gemini',
    label: 'Provider B',
    envKeys: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    kind: 'openai',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    models: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemini-3.1-pro-preview']
  },
  anthropic: {
    id: 'anthropic',
    label: 'Provider C',
    envKeys: ['ANTHROPIC_API_KEY'],
    kind: 'anthropic',
    endpoint: 'https://api.anthropic.com/v1/messages',
    models: ['claude-sonnet-4-6', 'claude-opus-4-8', 'claude-haiku-4-5']
  }
};

// Default order, used when no settings doc exists. Verified against provider
// docs 2026-06-25: grok-4.3 (xAI flagship), gemini-3.5-flash (Google GA Flash),
// claude-sonnet-4-6 (Anthropic). The Gemini rung is skipped until a
// GEMINI_API_KEY (or GOOGLE_API_KEY) is set in env — that is expected, not a
// failure.
export const DEFAULT_WATERFALL = [
  { provider: 'xai',       model: 'grok-4.3',          enabled: true },
  { provider: 'gemini',    model: 'gemini-3.5-flash',  enabled: true },
  { provider: 'anthropic', model: 'claude-sonnet-4-6', enabled: true }
];

// First present env key for a provider (the value — never logged or returned).
function providerApiKey(provider) {
  const p = PROVIDERS[provider];
  if (!p) return null;
  for (const k of p.envKeys) {
    if (process.env[k]) return process.env[k];
  }
  return null;
}

// Boolean: does this provider have an API key in env? (No secret leaves here.)
export function providerKeyPresent(provider) {
  return !!providerApiKey(provider);
}

// Annotate every rung for display/validation WITHOUT exposing secrets. Returns
// one row per input rung plus a `knownProvider` / `knownModel` / `keyPresent`
// flag set. Used by the admin GET to render state.
export function annotateWaterfall(order) {
  const list = Array.isArray(order) ? order : [];
  return list.map((r) => {
    const provider = String(r && r.provider || '');
    const model = String(r && r.model || '');
    const p = PROVIDERS[provider];
    return {
      provider,
      model,
      enabled: r && r.enabled !== false,
      knownProvider: !!p,
      knownModel: !!(p && p.models.includes(model)),
      keyPresent: providerKeyPresent(provider)
    };
  });
}

// The subset generate.js will actually attempt, in order: enabled, a known
// provider, and an API key present in env. Keyless / disabled / unknown rungs
// are dropped here (and surfaced via annotateWaterfall for the admin view).
export function resolveRunnableWaterfall(order) {
  return annotateWaterfall(order)
    .filter((r) => r.enabled && r.knownProvider && r.keyPresent)
    .map((r) => ({ provider: r.provider, model: r.model }));
}

// Validate + normalize an admin-submitted order. Returns { ok, error?,
// normalized? }. Every rung must name a known provider and a model in that
// provider's allow-list; `enabled` is coerced to boolean.
export function validateWaterfall(order) {
  if (!Array.isArray(order) || order.length === 0) {
    return { ok: false, error: 'order_must_be_nonempty_array' };
  }
  const normalized = [];
  for (const r of order) {
    const provider = r && String(r.provider || '');
    const model = r && String(r.model || '');
    const p = PROVIDERS[provider];
    if (!p) return { ok: false, error: 'unknown_provider:' + provider };
    if (!p.models.includes(model)) {
      return { ok: false, error: 'unknown_model:' + provider + '/' + model };
    }
    normalized.push({ provider, model, enabled: r.enabled !== false });
  }
  return { ok: true, normalized };
}

// ------------------------------------------------------------------
// Wire adapters
// ------------------------------------------------------------------
// Each returns { text, usage:{input_tokens,output_tokens}|null, stopReason }.
// Non-2xx throws an Error with `.status`. The orchestrator owns timeouts via
// the AbortSignal it passes in.

async function callOpenAICompatible(provider, { apiKey, model, systemPrompt, userContent, maxTokens, signal }) {
  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: false,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userContent }
      ]
    }),
    signal
  });
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    const err = new Error('http_' + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const text = (choice && choice.message && choice.message.content) || '';
  const usage = data.usage
    ? { input_tokens: data.usage.prompt_tokens || 0, output_tokens: data.usage.completion_tokens || 0 }
    : null;
  return { text, usage, stopReason: (choice && choice.finish_reason) || null };
}

async function callAnthropic(provider, { apiKey, model, systemPrompt, userContent, maxTokens, signal }) {
  const res = await fetch(provider.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [
        { role: 'user', content: userContent }
      ]
    }),
    signal
  });
  if (!res.ok) {
    let detail = null;
    try { detail = (await res.text()).slice(0, 300); } catch (_) {}
    const err = new Error('http_' + res.status);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  const data = await res.json();
  const usage = data.usage
    ? { input_tokens: data.usage.input_tokens || 0, output_tokens: data.usage.output_tokens || 0 }
    : null;
  // A safety-classifier refusal arrives as HTTP 200 with stop_reason:"refusal"
  // and (pre-output) empty content. Surface it as empty text so the
  // orchestrator falls through to the next rung — this is a provider-side
  // block, distinct from the model deliberately emitting our REFUSED:: token.
  if (data.stop_reason === 'refusal') {
    return { text: '', usage, stopReason: 'refusal' };
  }
  const text = (data.content || [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('');
  return { text, usage, stopReason: data.stop_reason || null };
}

function callProvider(provider, args) {
  return provider.kind === 'anthropic'
    ? callAnthropic(provider, args)
    : callOpenAICompatible(provider, args);
}

// ------------------------------------------------------------------
// Orchestrator
// ------------------------------------------------------------------
// Attempts `order` (already filtered to runnable rungs) in sequence. Per-rung
// timeout via AbortController; an overall deadline so we never blow the
// function's maxDuration trying a third slow provider. Returns the first
// non-empty body, or empty text with the per-rung `attempts` trail.
const MIN_RUNG_FLOOR_MS = 20000;

export async function runWaterfall({
  order,
  systemPrompt,
  userContent,
  maxTokens,
  perRungTimeoutMs = 120000,
  deadlineMs = 255000,
  isClientGone,
  log = () => {}
}) {
  const startedAt = Date.now();
  const attempts = [];

  for (const rung of order) {
    const provider = PROVIDERS[rung.provider];
    if (!provider) { attempts.push({ ...rung, skipped: 'unknown_provider' }); continue; }

    if (isClientGone && isClientGone()) {
      attempts.push({ ...rung, skipped: 'client_gone' });
      break;
    }

    const remaining = deadlineMs - (Date.now() - startedAt);
    if (remaining < MIN_RUNG_FLOOR_MS) {
      attempts.push({ ...rung, skipped: 'deadline' });
      log('deadline reached before ' + rung.provider + '/' + rung.model);
      break;
    }

    const apiKey = providerApiKey(rung.provider);
    if (!apiKey) { attempts.push({ ...rung, skipped: 'no_key' }); continue; }

    const controller = new AbortController();
    const timeout = Math.min(perRungTimeoutMs, remaining);
    const timer = setTimeout(() => controller.abort(), timeout);
    const rungStart = Date.now();
    try {
      const r = await callProvider(provider, {
        apiKey, model: rung.model, systemPrompt, userContent, maxTokens,
        signal: controller.signal
      });
      clearTimeout(timer);
      const text = (r.text || '').trim();
      if (!text) {
        // Empty body (incl. a provider-side safety refusal) → fall through.
        attempts.push({ ...rung, error: r.stopReason === 'refusal' ? 'provider_refusal' : 'empty', ms: Date.now() - rungStart });
        log(rung.provider + '/' + rung.model + ' returned no usable body — falling through');
        continue;
      }
      attempts.push({ ...rung, ok: true, ms: Date.now() - rungStart });
      log('served by ' + rung.provider + '/' + rung.model);
      return { text, usage: r.usage || null, stopReason: r.stopReason || null, model: rung.model, provider: rung.provider, attempts };
    } catch (err) {
      clearTimeout(timer);
      const reason = (err && err.name === 'AbortError') ? 'timeout' : ('error_' + ((err && err.status) || (err && err.message) || 'unknown'));
      attempts.push({ ...rung, error: reason, ms: Date.now() - rungStart });
      log(rung.provider + '/' + rung.model + ' failed (' + reason + ') — falling through');
      continue;
    }
  }

  return { text: '', usage: null, stopReason: null, model: null, provider: null, attempts };
}
