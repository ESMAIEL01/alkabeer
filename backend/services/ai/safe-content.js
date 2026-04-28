/**
 * Shared sharia-safe / culturally-appropriate content filter.
 *
 * Used by:
 *   - validateBio
 *   - validateIdentityInterviewOutput
 *   - profileBioPrompt / identityInterviewPrompt (as the source-of-truth
 *     for the model-instruction phrasing)
 *
 * Design rules:
 *   - Reject only EXPLICIT forbidden terms (alcohol / drugs / gambling /
 *     sexual / satanic-occult / blasphemous-mockery / profanity).
 *   - Do NOT block ordinary mystery-noir vocabulary:
 *       ظل (shadow / metaphorical), مريب, غموض, مافيوزو, تحقيق,
 *       محقق, شاهد, مشتبه, ظلام (when used metaphorically).
 *   - Each entry is a short Arabic OR English token. Matching is
 *     SUBSTRING-based (ASCII case-insensitive); Arabic is matched
 *     verbatim because Arabic letters are not case-sensitive.
 *   - The list is kept small and practical — no attempt at exhaustive
 *     coverage (which is impossible). The deterministic fallback
 *     guarantees a clean output even when the AI emits a borderline
 *     phrase that slips through.
 */

// Each category is a flat array of short tokens. We keep them short on
// purpose: long phrases are easier for a model to decompose around.
const SAFE_DENY_CATEGORIES = Object.freeze({
  alcohol: [
    'خمر', 'خمور', 'نبيذ', 'بيرة', 'ويسكي', 'سُكر', 'سكير', 'مشروب كحولي',
    'alcohol', 'beer', 'wine', 'whisky', 'whiskey', 'vodka', 'liquor',
  ],
  drugs: [
    'حشيش', 'مخدر', 'مخدرات', 'كوكايين', 'هيروين', 'أفيون', 'بانجو',
    'cocaine', 'heroin', 'meth', 'weed', 'marijuana', 'opium', 'cannabis',
  ],
  gambling: [
    'قمار', 'مراهنات', 'مراهنة', 'كازينو', 'روليت', 'بوكر',
    'gamble', 'gambling', 'casino', 'roulette', 'poker',
  ],
  sexual: [
    'جنس', 'جنسي', 'إيحاء جنسي', 'إغراء جنسي', 'عُري', 'عاهرة', 'دعارة', 'مخن',
    'sexual', 'sex scene', 'nude', 'porn', 'erotic',
  ],
  satanic_occult: [
    // Religious / mythical figures used as named entities — block by name.
    'إبليس', 'عبادة الشيطان', 'satan', 'satanic', 'devil worship',
    'demonic', 'lucifer',
    // Occult practices.
    'شعوذة', 'سحر أسود', 'تعاويذ', 'تعويذة', 'لعنات', 'لعنة سوداء',
    'witchcraft', 'occult', 'black magic', 'hex', 'séance',
  ],
  blasphemy: [
    // Self-deification phrases used in the spec.
    'أنا إله', 'أنا الإله', 'أنا الرب', 'قدري مقدس', 'رب الظلام',
    'أعبد الظلام', 'أعبد الشيطان', 'أعبد إبليس',
    // English equivalents — short common phrases only.
    'i am god', 'worship the dark',
  ],
  profanity: [
    // Conservative shortlist — only EXPLICIT slurs / extreme insults that
    // would always be inappropriate. Common Arabic words like "غبي" are
    // intentionally NOT blocked.
    'fuck', 'shit', 'bitch', 'bastard',
  ],
});

/** Flatten the categories into a single lookup array for the validator. */
const SAFE_DENY_FLAT = Object.freeze(
  Object.values(SAFE_DENY_CATEGORIES).reduce((acc, arr) => acc.concat(arr), [])
);

// Word-boundary char class. A "letter" for this purpose is any ASCII
// alphanumeric OR any Arabic-script letter (U+0600–U+06FF, U+0750–U+077F,
// U+08A0–U+08FF, U+FB50–U+FDFF, U+FE70–U+FEFF). The full range is broad
// but conservative — anything outside it (whitespace, punctuation,
// numbers from non-Arabic scripts, emoji) counts as a boundary.
//
// This boundary is what prevents "بيرة" (beer) from matching inside
// "كبيرة" (big), which is a real false-positive class for short
// Arabic tokens.
const SAFE_BOUNDARY_CLASS = '[^A-Za-z0-9\\u0600-\\u06FF\\u0750-\\u077F\\u08A0-\\u08FF\\uFB50-\\uFDFF\\uFE70-\\uFEFF]';

const _tokenCache = new Map();

function _escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function _tokenRegex(needle) {
  if (_tokenCache.has(needle)) return _tokenCache.get(needle);
  const esc = _escapeRegex(needle);
  // Match the token only when both sides are at a string boundary OR a
  // non-letter character (per SAFE_BOUNDARY_CLASS). Using lookbehind /
  // lookahead keeps the match zero-width on the boundary so consecutive
  // matches don't shadow one another.
  const re = new RegExp(`(?:^|${SAFE_BOUNDARY_CLASS})${esc}(?=$|${SAFE_BOUNDARY_CLASS})`, 'i');
  _tokenCache.set(needle, re);
  return re;
}

/**
 * Test-helper: does the input contain ANY explicitly-denied token as a
 * standalone word? Tokens are matched with Unicode-aware word boundaries
 * so a short Arabic token like "بيرة" (beer) does NOT false-positive
 * inside a benign word like "كبيرة" (big).
 *
 * @param {string} text
 * @returns {{ hit: boolean, category?: string, token?: string }}
 */
function containsForbiddenTerm(text) {
  if (typeof text !== 'string' || !text) return { hit: false };
  for (const [category, list] of Object.entries(SAFE_DENY_CATEGORIES)) {
    for (const t of list) {
      const needle = String(t || '').trim();
      if (!needle) continue;
      const re = _tokenRegex(needle);
      if (re.test(text)) {
        return { hit: true, category, token: needle };
      }
    }
  }
  return { hit: false };
}

/**
 * Documented prompt fragment that prompt builders can inline so the
 * model sees the exact rules the validator will enforce.
 */
const SAFE_PROMPT_RULES_AR = [
  '- نص عربي فقط بنسبة ≥80% في كل حقل.',
  '- ممنوع أي كلمات إنجليزية باستثناء "Mafiozo" — يُفضّل كتابتها "مافيوزو".',
  '- ممنوع المحتوى المُسيء دينياً أو الإلحادي أو الشركي.',
  '- ممنوع تمجيد الشيطان أو إبليس أو السحر أو الشعوذة أو التعاويذ.',
  '- ممنوع جمل مثل "أنا إله" أو "قدري مقدس" أو "أعبد الظلام".',
  '- ممنوع ذكر الخمور أو المخدرات أو القمار.',
  '- ممنوع أي إيحاء جنسي أو محتوى عُريّ.',
  '- ممنوع شتائم أو ألفاظ نابية.',
  '- ممنوع عنف مفرط أو تفاصيل دموية.',
  '- ممنوع الاستهزاء بالأديان أو الرموز الدينية.',
  '- الأسلوب نوار سينمائي نظيف: غموض، تحقيق، أرشيف، قضية، شاهد، مشتبه.',
  '- "ظل" مسموحة بالمعنى المجازي. "غموض" و"مريب" مسموحة.',
];

module.exports = {
  SAFE_DENY_CATEGORIES,
  SAFE_DENY_FLAT,
  containsForbiddenTerm,
  SAFE_PROMPT_RULES_AR,
};
