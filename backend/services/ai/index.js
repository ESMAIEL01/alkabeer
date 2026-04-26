/**
 * Public AI surface used by the route layer.
 *
 * Provider chain (per call):
 *   1. Gemini   (primary)        — config.gemini.apiKey present
 *   2. OpenRouter (fallback)     — config.openrouter.enabled
 *   3. Built-in scenario/line    — always available
 *
 * Public functions:
 *   generateSealedArchive(input) → { source, archive, note? }
 *   narrate({ phase, context })  → { source, line }
 *
 * Both are guaranteed not to throw.
 */
const config = require('../../config/env');
const { callGemini } = require('./geminiClient');
const { callOpenRouter, isConfigured: openrouterConfigured } = require('./openrouterClient');
const { archivePrompt, narrationPrompt } = require('./prompts');
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

async function tryGeminiArchive(input) {
  if (!config.gemini.apiKey) return null;
  try {
    const raw = await callGemini({
      modelName: config.gemini.archiveModel,
      userPrompt: archivePrompt(input),
      json: true,
      temperature: 0.9,
    });
    const parsed = safeJsonParse(raw);
    const err = validateArchive(parsed);
    if (err) {
      console.warn(`[ai] gemini archive invalid (${err})`);
      return null;
    }
    return parsed;
  } catch (err) {
    console.warn('[ai] gemini archive failed:', err.message);
    return null;
  }
}

async function tryOpenRouterArchive(input) {
  if (!openrouterConfigured()) return null;
  try {
    const raw = await callOpenRouter({
      userPrompt: archivePrompt(input),
      json: true,
      temperature: 0.85,
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
  try {
    const raw = await callGemini({
      modelName: config.gemini.narrationModel,
      userPrompt: prompt,
      json: false,
      temperature: 0.95,
    });
    const cleaned = validateNarration(raw, { forbiddenTerms });
    if (!cleaned) {
      console.warn('[ai] gemini narration rejected by validator');
      return null;
    }
    return cleaned;
  } catch (err) {
    console.warn('[ai] gemini narration failed:', err.message);
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
 *   { source: 'gemini' | 'openrouter' | 'fallback', archive, note? }
 * Never throws.
 */
async function generateSealedArchive(input = {}) {
  const fromGemini = await tryGeminiArchive(input);
  if (fromGemini) return { source: 'gemini', archive: fromGemini };

  const fromOpenRouter = await tryOpenRouterArchive(input);
  if (fromOpenRouter) return { source: 'openrouter', archive: fromOpenRouter };

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
  if (fromGemini) return { source: 'gemini', line: fromGemini };

  const fromOpenRouter = await tryOpenRouterNarration(prompt, forbiddenTerms);
  if (fromOpenRouter) return { source: 'openrouter', line: fromOpenRouter };

  return { source: 'fallback', line: FALLBACK_NARRATION };
}

module.exports = {
  generateSealedArchive,
  narrate,
  // Test/diagnostic exports — not part of the route surface.
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
};
