/**
 * Public AI surface used by the route layer.
 *
 * Two operations:
 *   generateSealedArchive(input)  - one-shot scenario + clues for game start.
 *   narrate({ phase, context })   - short cinematic line for in-game beats.
 *
 * Both gracefully fall back to a built-in scenario if Gemini is unavailable
 * (no API key, quota exhausted, content-filter refusal, network failure).
 * Callers always receive a usable structure.
 */
const config = require('../../config/env');
const { callGemini } = require('./geminiClient');
const { archivePrompt, narrationPrompt } = require('./prompts');

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

/**
 * Validate that a parsed archive has the required shape.
 * Returns null if valid, else an error message.
 */
function validateArchive(a) {
  if (!a || typeof a !== 'object') return 'not an object';
  if (typeof a.story !== 'string' || a.story.length < 60) return 'story too short';
  if (typeof a.mafiozo !== 'string' || !a.mafiozo) return 'missing mafiozo';
  if (typeof a.obvious_suspect !== 'string' || !a.obvious_suspect) return 'missing obvious_suspect';
  if (!Array.isArray(a.clues) || a.clues.length !== 3) return 'clues must be exactly 3';
  for (const c of a.clues) if (typeof c !== 'string' || !c.trim()) return 'empty clue';
  if (!Array.isArray(a.characters) || a.characters.length < 2) return 'need at least 2 characters';
  return null;
}

function safeJsonParse(text) {
  if (!text) return null;
  // Strip code fences if the model added them despite responseMimeType=json.
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // Try to locate the first valid JSON object in the text.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

/**
 * Build a sealed archive. Always returns:
 *   { source: 'gemini' | 'fallback', archive, note? }
 * Never throws.
 */
async function generateSealedArchive(input = {}) {
  if (!config.gemini.apiKey) {
    return { source: 'fallback', archive: FALLBACK_ARCHIVE, note: FALLBACK_NOTE_AR };
  }

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
      console.warn(`AI archive invalid (${err}). Falling back.`);
      return { source: 'fallback', archive: FALLBACK_ARCHIVE, note: FALLBACK_NOTE_AR };
    }
    return { source: 'gemini', archive: parsed };
  } catch (err) {
    console.warn('AI archive call failed:', err.message);
    return { source: 'fallback', archive: FALLBACK_ARCHIVE, note: FALLBACK_NOTE_AR };
  }
}

/**
 * Short cinematic narration for in-game phase transitions.
 * Returns plain string. Falls back to a static phrase.
 */
async function narrate({ phase, context }) {
  if (!config.gemini.apiKey) return '...الكبير بيبص في الأرشيف';
  try {
    const text = await callGemini({
      modelName: config.gemini.narrationModel,
      userPrompt: narrationPrompt({ phase, context }),
      json: false,
      temperature: 0.95,
    });
    return text.trim() || '...الكبير ساكت دلوقتي';
  } catch (err) {
    console.warn('AI narration failed:', err.message);
    return '...الكبير ساكت دلوقتي';
  }
}

module.exports = {
  generateSealedArchive,
  narrate,
  // Exposed for tests:
  _validateArchive: validateArchive,
  _fallbackArchive: FALLBACK_ARCHIVE,
};
