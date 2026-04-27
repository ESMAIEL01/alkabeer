/**
 * Public AI surface used by the route layer.
 *
 * Provider chain for archive generation:
 *   1. Gemini  (primary)     — config.gemini.archiveModel          (e.g. gemini-2.5-pro)
 *   2. Gemini  (internal fb) — config.gemini.archiveFallbackModel  (e.g. gemini-2.5-flash)
 *   3. OpenRouter (external) — config.openrouter.enabled
 *   4. Built-in scenario     — always available
 *
 * Provider chain for narration:
 *   1. Gemini Flash (primary) — config.gemini.narrationModel
 *   2. OpenRouter             — config.openrouter.enabled
 *   3. Built-in static line
 *
 * Public functions:
 *   generateSealedArchive(input) → { source, model?, archive, note? }
 *   narrate({ phase, context })  → { source, model?, line }
 *
 * Both are guaranteed not to throw.
 */
const config = require('../../config/env');
const { callGemini } = require('./geminiClient');
const { callOpenRouter, isConfigured: openrouterConfigured } = require('./openrouterClient');
const {
  archivePrompt, archivePromptStrict, narrationPrompt,
  voteResultPolishPrompt, clueTransitionPolishPrompt, finalRevealPolishPrompt,
} = require('./prompts');
const {
  safeJsonParse, validateArchive, validateNarration,
  validatePolishLine, validateFinalRevealPolish,
} = require('./validators');
const { logAiGeneration } = require('../analytics');

// ---------------------------------------------------------------------------
// Telemetry helpers — tiny, internal, fire-and-forget.
// ---------------------------------------------------------------------------

/**
 * Map a thrown provider error to a short, secret-free classification.
 * The original err.message may contain provider response bodies — never
 * forward it to the analytics row directly.
 */
function classifyProviderError(err) {
  const m = err && err.message ? String(err.message).toLowerCase() : '';
  if (m.includes('timeout') || m.includes('aborted')) return 'timeout';
  if (m.includes('429') || m.includes('quota') || m.includes('rate limit')
      || m.includes('401') || m.includes('403') || m.includes('unauthorized')
      || m.includes('forbidden')) return 'quota_or_auth_error';
  if (m.includes('json') || m.includes('parse') || m.includes('unexpected token')) return 'malformed_json';
  return 'provider_error';
}

/**
 * Fire-and-forget wrapper. The default logger never rejects, but the .catch
 * is defensive against future changes.
 */
function logAi(args) {
  try {
    const p = logAiGeneration(args);
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* swallow */ }
}

// ---------------------------------------------------------------------------
// Built-in fallback content. The game must always be playable, even when
// every external provider is down.
// ---------------------------------------------------------------------------

const FALLBACK_ARCHIVE = {
  title: 'سرقة قصر البارون',
  story:
    'الجريمة حصلت في قصر البارون ميدو الساعة 2 الصبح. الضحية مدير البنك "أنور". المافيوزو الحقيقي هو المحاسب "كمال" — هادي وذكي ومحدش حاسس بيه. المشتبه الواضح هو الحارس "محمود" لأنه كان قريب من الخزنة في وقت الجريمة. كل الأدلة مصممة عشان تلبّس محمود لحد ما الدليل الثالث يكشف كمال.',
  mafiozo: 'كمال (المحاسب)',
  obvious_suspect: 'محمود (الحارس)',
  characters: [
    { name: 'محمود', role: 'الحارس', suspicious_detail: 'اتصرف على إنه ساهر طول الليل بس مفيش حد شافه عند البوابة.' },
    { name: 'سارة', role: 'السكرتيرة', suspicious_detail: 'لقت الجثة أول واحدة وكانت لابسة معطف غريب.' },
    { name: 'كمال', role: 'المحاسب', suspicious_detail: 'طلب تقرير عاجل قبل الجريمة بنص ساعة.' },
    { name: 'فريد', role: 'المدير', suspicious_detail: 'كان متخانق مع الضحية إمبارح قدام الكل.' },
  ],
  clues: [
    'كاميرا الباب الخلفي سجلت حد لابس بالطو غامق الساعة 1:30 — والحارس محمود كان لابس بالطو زيه.',
    '٣ ناس بس كان معاهم مفتاح الخزنة: المحاسب كمال، المدير فريد، الحارس محمود... وواحد منهم كان صاحي الساعة 2.',
    'كمال طلب "كوباية مية كبيرة" على مكتبه الساعة 9:05 — الكوباية ظهرت فاضية والحوض مبلول. شكله بيغسل حاجة من إيديه.',
  ],
};

const FALLBACK_NOTE_AR = 'الكبير اشتغل بقصة احتياطية دلوقتي. خدمة الذكاء مش متاحة للحظات.';
const FALLBACK_NARRATION = '...الكبير ساكت دلوقتي';

// ---------------------------------------------------------------------------
// Internal: provider attempts. Each returns the parsed+validated archive on
// success, or null on failure. They never throw.
// ---------------------------------------------------------------------------

/**
 * Try a Gemini archive call against a specific model. Returns the parsed
 * archive on success, or null on any failure (network, quota, rate limit,
 * invalid JSON, validation rejection). Never throws.
 *
 * @param {object} input          - archive input (idea, players, mood, difficulty)
 * @param {string} modelName      - the Gemini model to use for THIS attempt
 * @param {object} [opts]
 * @param {boolean} [opts.strict] - use the compact strict prompt (Flash fallback)
 */
async function tryGeminiArchive(input, modelName, { strict = false } = {}) {
  if (!config.gemini.apiKey) return null;
  if (!modelName) return null;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: strict ? archivePromptStrict(input) : archivePrompt(input),
      json: true,
      temperature: strict ? 0.85 : 0.9,
      maxOutputTokens: config.gemini.archiveMaxOutputTokens,
    });
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      console.warn(`[ai] gemini(${modelName}) archive invalid (malformed_json)`);
      logAi({ task: 'archive', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'malformed_json' });
      return null;
    }
    const err = validateArchive(parsed);
    if (err) {
      console.warn(`[ai] gemini(${modelName}) archive invalid (${err})`);
      logAi({ task: 'archive', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'archive', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return parsed;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) archive failed:`, err.message);
    logAi({ task: 'archive', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

async function tryOpenRouterArchive(input) {
  if (!openrouterConfigured()) return null;
  const orModel = config.openrouter.fallbackModel;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: archivePromptStrict(input),
      json: true,
      temperature: 0.8,
      maxTokens: config.openrouter.archiveMaxTokens,
    });
    const parsed = safeJsonParse(raw);
    if (!parsed) {
      console.warn('[ai] openrouter archive invalid (malformed_json)');
      logAi({ task: 'archive', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'malformed_json' });
      return null;
    }
    const err = validateArchive(parsed);
    if (err) {
      console.warn(`[ai] openrouter archive invalid (${err})`);
      logAi({ task: 'archive', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'archive', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return parsed;
  } catch (err) {
    console.warn('[ai] openrouter archive failed:', err.message);
    logAi({ task: 'archive', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

async function tryGeminiNarration(prompt, forbiddenTerms) {
  if (!config.gemini.apiKey) return null;
  const modelName = config.gemini.narrationModel;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: prompt,
      json: false,
      temperature: 0.95,
      maxOutputTokens: config.gemini.narrationMaxOutputTokens,
    });
    const cleaned = validateNarration(raw, { forbiddenTerms });
    if (!cleaned) {
      console.warn(`[ai] gemini(${modelName}) narration rejected by validator`);
      logAi({ task: 'narration', source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'narration', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) narration failed:`, err.message);
    logAi({ task: 'narration', source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

async function tryOpenRouterNarration(prompt, forbiddenTerms) {
  if (!openrouterConfigured()) return null;
  const orModel = config.openrouter.fallbackModel;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: prompt,
      json: false,
      temperature: 0.9,
      maxTokens: config.openrouter.narrationMaxTokens,
    });
    const cleaned = validateNarration(raw, { forbiddenTerms });
    if (!cleaned) {
      console.warn('[ai] openrouter narration rejected by validator');
      logAi({ task: 'narration', source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task: 'narration', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    console.warn('[ai] openrouter narration failed:', err.message);
    logAi({ task: 'narration', source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

/**
 * Build a sealed archive. Always returns:
 *   { source: 'gemini' | 'openrouter' | 'fallback', model?, archive, note? }
 * Never throws.
 *
 * Provider chain:
 *   1. Gemini archive model (default gemini-2.5-pro)
 *   2. Gemini archive fallback model (default gemini-2.5-flash) — only if
 *      different from the primary model. This gracefully absorbs Pro quota
 *      exhaustion (HTTP 429) without leaving the Gemini family.
 *   3. OpenRouter (if AI_FALLBACK_PROVIDER=openrouter and key configured)
 *   4. Built-in fallback scenario.
 */
async function generateSealedArchive(input = {}) {
  // Rung 1: primary Gemini model with the full Architect prompt.
  const primaryModel = config.gemini.archiveModel;
  const fromPrimary = await tryGeminiArchive(input, primaryModel);
  if (fromPrimary) return { source: 'gemini', model: primaryModel, archive: fromPrimary };

  // Rung 2: internal Gemini fallback model — uses the STRICT compact prompt
  // because Flash-class thinking models burn budget on the verbose prompt.
  // Skip if identical to primary.
  const fbModel = config.gemini.archiveFallbackModel;
  if (fbModel && fbModel !== primaryModel) {
    const fromFallback = await tryGeminiArchive(input, fbModel, { strict: true });
    if (fromFallback) return { source: 'gemini', model: fbModel, archive: fromFallback };
  }

  // Rung 3: OpenRouter (external secondary fallback)
  const fromOpenRouter = await tryOpenRouterArchive(input);
  if (fromOpenRouter) {
    return {
      source: 'openrouter',
      model: config.openrouter.fallbackModel,
      archive: fromOpenRouter,
    };
  }

  // Rung 4: built-in static scenario
  logAi({ task: 'archive_fallback', source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return { source: 'fallback', archive: FALLBACK_ARCHIVE, note: FALLBACK_NOTE_AR };
}

/**
 * Short cinematic narration for in-game phase transitions.
 * Returns: { source, line }
 *
 * @param {object} opts
 * @param {string} opts.phase
 * @param {string} [opts.context]
 * @param {string[]} [opts.forbiddenTerms]  - terms that must not appear in
 *   the line (e.g. mafiozo identity for mid-game beats).
 */
async function narrate({ phase, context, forbiddenTerms } = {}) {
  const prompt = narrationPrompt({ phase, context });

  const fromGemini = await tryGeminiNarration(prompt, forbiddenTerms);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  const fromOpenRouter = await tryOpenRouterNarration(prompt, forbiddenTerms);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

  logAi({ task: 'narration_fallback', source: 'fallback', model: 'built-in',
    latencyMs: 0, ok: true, validatorReason: 'fallback_used' });
  return { source: 'fallback', line: FALLBACK_NARRATION };
}

// ---------------------------------------------------------------------------
// Polish provider attempts (C2 / C3).
//
// Same provider chain shape as narration (Gemini Flash → OpenRouter), but
// with caller-supplied validators so JSON-shaped (final reveal) and line-
// shaped (vote result, clue transition) outputs each get their own gate.
// ---------------------------------------------------------------------------

async function tryGeminiPolish(prompt, validator, task, { json = false } = {}) {
  if (!config.gemini.apiKey) return null;
  const modelName = config.gemini.narrationModel;
  const start = Date.now();
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: prompt,
      json,
      temperature: 0.95,
      maxOutputTokens: config.gemini.narrationMaxOutputTokens,
    });
    const cleaned = validator(raw);
    if (!cleaned) {
      logAi({ task, source: 'gemini', model: modelName,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task, source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    logAi({ task, source: 'gemini', model: modelName,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

async function tryOpenRouterPolish(prompt, validator, task, { json = false } = {}) {
  if (!openrouterConfigured()) return null;
  const orModel = config.openrouter.fallbackModel;
  const start = Date.now();
  try {
    const raw = await callOpenRouter({
      userPrompt: prompt,
      json,
      temperature: 0.9,
      maxTokens: config.openrouter.narrationMaxTokens,
    });
    const cleaned = validator(raw);
    if (!cleaned) {
      logAi({ task, source: 'openrouter', model: orModel,
        latencyMs: Date.now() - start, ok: false, validatorReason: 'validator_rejected' });
      return null;
    }
    logAi({ task, source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: true });
    return cleaned;
  } catch (err) {
    logAi({ task, source: 'openrouter', model: orModel,
      latencyMs: Date.now() - start, ok: false, validatorReason: classifyProviderError(err) });
    return null;
  }
}

/**
 * Embellish a vote-result deterministic payload with one short Arabic noir
 * line. Returns { source, model, line } on success; null otherwise.
 *
 * input.forbiddenTerms must include the alive Mafiozo username/character
 * names mid-game so the AI cannot expose them.
 */
async function embellishVoteResult(input) {
  const prompt = voteResultPolishPrompt(input || {});
  const forbiddenTerms = Array.isArray(input && input.forbiddenTerms) ? input.forbiddenTerms : [];
  const validator = (raw) => validatePolishLine(raw, { forbiddenTerms });
  const task = 'vote_result_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

  return null;
}

/**
 * Bridge prose between a finished round and the next clue. Same contract
 * as embellishVoteResult.
 */
async function embellishClueTransition(input) {
  const prompt = clueTransitionPolishPrompt(input || {});
  const forbiddenTerms = Array.isArray(input && input.forbiddenTerms) ? input.forbiddenTerms : [];
  const validator = (raw) => validatePolishLine(raw, { forbiddenTerms });
  const task = 'clue_transition_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task);
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, line: fromGemini };

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task);
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, line: fromOpenRouter };

  return null;
}

/**
 * Polish the FINAL_REVEAL screen with optional cinematic flavor fields.
 * Returns { source, model, polish } where polish is an object containing
 * only validated optional fields (heroSubtitle, caseClosingLine,
 * finalParagraph, epilogue). Returns null if no provider succeeded.
 *
 * The caller MUST guarantee phase === FINAL_REVEAL — at that point all
 * roles are public, so input may include real Mafiozo names.
 */
async function embellishFinalReveal(input) {
  const prompt = finalRevealPolishPrompt(input || {});
  const validator = (raw) => validateFinalRevealPolish(raw);
  const task = 'final_reveal_polish';

  const fromGemini = await tryGeminiPolish(prompt, validator, task, { json: true });
  if (fromGemini) return { source: 'gemini', model: config.gemini.narrationModel, polish: fromGemini };

  const fromOpenRouter = await tryOpenRouterPolish(prompt, validator, task, { json: true });
  if (fromOpenRouter) return { source: 'openrouter', model: config.openrouter.fallbackModel, polish: fromOpenRouter };

  return null;
}

module.exports = {
  generateSealedArchive,
  narrate,
  embellishVoteResult,
  embellishClueTransition,
  embellishFinalReveal,
  // Test/diagnostic exports — not part of the route surface.
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
};
