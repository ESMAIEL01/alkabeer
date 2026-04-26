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
const { archivePrompt, archivePromptStrict, narrationPrompt } = require('./prompts');
const { safeJsonParse, validateArchive, validateNarration } = require('./validators');

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
  try {
    const raw = await callGemini({
      modelName,
      userPrompt: strict ? archivePromptStrict(input) : archivePrompt(input),
      json: true,
      temperature: strict ? 0.85 : 0.9,
      maxOutputTokens: config.gemini.archiveMaxOutputTokens,
    });
    const parsed = safeJsonParse(raw);
    const err = validateArchive(parsed);
    if (err) {
      console.warn(`[ai] gemini(${modelName}) archive invalid (${err})`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) archive failed:`, err.message);
    return null;
  }
}

async function tryOpenRouterArchive(input) {
  if (!openrouterConfigured()) return null;
  try {
    const raw = await callOpenRouter({
      userPrompt: archivePromptStrict(input),
      json: true,
      temperature: 0.8,
      maxTokens: config.openrouter.archiveMaxTokens,
    });
    const parsed = safeJsonParse(raw);
    const err = validateArchive(parsed);
    if (err) {
      console.warn(`[ai] openrouter archive invalid (${err})`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[ai] openrouter archive failed:', err.message);
    return null;
  }
}

async function tryGeminiNarration(prompt, forbiddenTerms) {
  if (!config.gemini.apiKey) return null;
  const modelName = config.gemini.narrationModel;
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
      return null;
    }
    return cleaned;
  } catch (err) {
    console.warn(`[ai] gemini(${modelName}) narration failed:`, err.message);
    return null;
  }
}

async function tryOpenRouterNarration(prompt, forbiddenTerms) {
  if (!openrouterConfigured()) return null;
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
      return null;
    }
    return cleaned;
  } catch (err) {
    console.warn('[ai] openrouter narration failed:', err.message);
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

  return { source: 'fallback', line: FALLBACK_NARRATION };
}

module.exports = {
  generateSealedArchive,
  narrate,
  // Test/diagnostic exports — not part of the route surface.
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
};
