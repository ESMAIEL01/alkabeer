/**
 * OpenRouter client — secondary AI fallback only.
 *
 * Speaks the OpenAI-compatible /chat/completions REST API. Uses Node 20's
 * built-in fetch — no extra dependency, no lockfile change.
 *
 * Responsibilities:
 *   - Read OPENROUTER_API_KEY from env (never logged).
 *   - Inject the same AlKabeer persona + knowledge file as system prompt.
 *   - Hard timeout regardless of network behaviour.
 *   - Return raw text. Validation is the caller's job (validators.js).
 *
 * Note: this module never throws on misconfiguration. If the key is missing
 * or the env disables fallback, callers must check `isConfigured()` first.
 */
const config = require('../../config/env');
const { ALKABEER_PERSONA, loadKnowledge } = require('./prompts');

function isConfigured() {
  return !!(config.openrouter && config.openrouter.enabled && config.openrouter.apiKey);
}

function systemContent() {
  const knowledge = loadKnowledge();
  return knowledge
    ? `${ALKABEER_PERSONA}\n\n--- المرجع الكامل (Mafiozo Architect Edition) ---\n${knowledge}`
    : ALKABEER_PERSONA;
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Send a chat completion request to OpenRouter and return the assistant text.
 *
 * @param {object} opts
 * @param {string} opts.userPrompt    - User message
 * @param {boolean} [opts.json]       - Hint the model to emit JSON only (string-level only)
 * @param {number} [opts.temperature] - Sampling temp
 * @param {string} [opts.modelName]   - Override the configured fallback model
 * @returns {Promise<string>} raw assistant text
 */
async function callOpenRouter({ userPrompt, json = false, temperature = 0.85, modelName } = {}) {
  if (!isConfigured()) {
    throw new Error('OpenRouter is not configured');
  }

  const model = modelName || config.openrouter.fallbackModel;
  const baseUrl = (config.openrouter.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
  const url = `${baseUrl}/chat/completions`;

  const body = {
    model,
    temperature,
    max_tokens: 2048,
    messages: [
      { role: 'system', content: systemContent() },
      // For JSON tasks we bias the system message; OpenRouter has no
      // universal response_format flag because providers vary.
      ...(json ? [{ role: 'system', content: 'Return ONLY valid JSON. No prose. No code fences. No comments.' }] : []),
      { role: 'user', content: userPrompt },
    ],
  };

  // Some OpenRouter providers honour OpenAI-style response_format. It's safe
  // to send — providers that don't recognise it will ignore the field.
  if (json) body.response_format = { type: 'json_object' };

  let response;
  try {
    response = await withTimeout(
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${config.openrouter.apiKey}`,
          // OpenRouter recommends these to identify the calling app on its
          // analytics dashboard. They are public and never expose secrets.
          'HTTP-Referer': config.frontendUrl || 'https://alkabeer.local',
          'X-Title': 'AlKabeer',
        },
        body: JSON.stringify(body),
      }),
      config.openrouter.timeoutMs || 30_000,
      `OpenRouter ${model}`
    );
  } catch (err) {
    // Network or timeout. Wrap so callers don't see provider internals leak
    // into user-facing error paths.
    throw new Error(`OpenRouter network error: ${err.message}`);
  }

  if (!response.ok) {
    // Pull a short error reason without leaking the body verbatim into logs.
    let snippet = '';
    try {
      const text = await response.text();
      snippet = text ? text.slice(0, 200) : '';
    } catch { /* ignore */ }
    throw new Error(`OpenRouter HTTP ${response.status}${snippet ? ': ' + snippet.replace(/\s+/g, ' ') : ''}`);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new Error('OpenRouter returned non-JSON body');
  }

  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) {
    throw new Error('OpenRouter returned empty content');
  }
  return content;
}

module.exports = {
  callOpenRouter,
  isConfigured,
};
