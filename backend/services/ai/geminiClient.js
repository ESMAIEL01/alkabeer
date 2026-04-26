/**
 * Thin wrapper around Google Generative AI SDK.
 *
 * Responsibilities:
 *   - Read GEMINI_API_KEY from env (never logged).
 *   - Return ready-to-use model handles for archive vs narration.
 *   - Enforce a request timeout regardless of SDK behavior.
 *   - Inject the AlKabeer persona + knowledge file as systemInstruction.
 */
const { GoogleGenerativeAI } = require('@google/generative-ai');
const config = require('../../config/env');
const { ALKABEER_PERSONA, loadKnowledge } = require('./prompts');

let _client = null;
function client() {
  if (_client) return _client;
  if (!config.gemini.apiKey) {
    throw new Error('GEMINI_API_KEY is not set');
  }
  _client = new GoogleGenerativeAI(config.gemini.apiKey);
  return _client;
}

function systemInstruction() {
  const knowledge = loadKnowledge();
  return knowledge
    ? `${ALKABEER_PERSONA}\n\n--- المرجع الكامل (Mafiozo Architect Edition) ---\n${knowledge}`
    : ALKABEER_PERSONA;
}

/**
 * Wrap a promise with a hard timeout. The SDK has its own internal timing
 * but we want a single source of truth.
 */
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Call Gemini and return raw text. Caller parses.
 *
 * @param {object} opts
 * @param {string} opts.modelName        - Model id (e.g. "gemini-2.5-pro")
 * @param {string} opts.userPrompt       - The user message
 * @param {boolean} [opts.json]          - Request JSON-only response
 * @param {number} [opts.temperature]    - Sampling temp (default 0.85)
 * @param {number} [opts.maxOutputTokens] - Per-call ceiling. For 2.5 thinking
 *   models this covers BOTH internal reasoning AND visible output — set
 *   generously for archive calls to avoid finishReason: MAX_TOKENS.
 */
async function callGemini({ modelName, userPrompt, json = false, temperature = 0.85, maxOutputTokens }) {
  const cap = Number.isFinite(maxOutputTokens) && maxOutputTokens > 0 ? maxOutputTokens : 2048;
  const model = client().getGenerativeModel({
    model: modelName,
    systemInstruction: systemInstruction(),
    generationConfig: {
      temperature,
      maxOutputTokens: cap,
      ...(json ? { responseMimeType: 'application/json' } : {}),
    },
    // Loosen safety filters for the crime-mystery genre. Still blocks the
    // hardest categories — Gemini will refuse if a prompt is genuinely unsafe.
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT',         threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH',        threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',  threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT',  threshold: 'BLOCK_ONLY_HIGH' },
    ],
  });

  const result = await withTimeout(
    model.generateContent(userPrompt),
    config.gemini.timeoutMs,
    `Gemini ${modelName}`
  );

  const response = result.response;
  if (!response) throw new Error('Empty response from Gemini.');

  // The SDK throws if the model refused. Defense in depth: check finishReason.
  const candidate = response.candidates && response.candidates[0];
  if (candidate && candidate.finishReason && candidate.finishReason !== 'STOP') {
    throw new Error(`Gemini stopped early: ${candidate.finishReason}`);
  }

  return response.text();
}

module.exports = { callGemini };
