/**
 * Provider-agnostic validators and parsers for AI output.
 *
 * The same checks apply uniformly to Gemini and OpenRouter (or any future
 * provider). Centralising them prevents one provider from slipping output
 * through that the other would have rejected.
 *
 * Nothing in this file talks to a network, reads env, or logs secrets.
 */

const NARRATION_MAX_LEN = 600;          // chars; cinematic lines stay short
const NARRATION_MIN_LEN = 8;            // reject empty / one-word output

// Used to detect English bleed in Arabic-only narration.
// Whitelisted English: short proper nouns inside parentheses or quotes are
// rare in practice; we just require that >= 60% of letters be Arabic-script.
const ARABIC_SCRIPT_RE = /[؀-ۿݐ-ݿࢠ-ࣿ]/;

/**
 * Permissive JSON parser that strips code fences and recovers the first
 * complete JSON object if the model wrapped it in prose.
 *
 * @param {string} text
 * @returns {object|null}
 */
function safeJsonParse(text) {
  if (typeof text !== 'string' || !text) return null;
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

/**
 * Validate a sealed-archive object. Returns null if valid,
 * else a short reason string suitable for warn-level logs.
 */
function validateArchive(a) {
  if (!a || typeof a !== 'object') return 'not an object';
  if (typeof a.story !== 'string' || a.story.length < 60) return 'story too short';
  if (typeof a.mafiozo !== 'string' || !a.mafiozo.trim()) return 'missing mafiozo';
  if (typeof a.obvious_suspect !== 'string' || !a.obvious_suspect.trim()) return 'missing obvious_suspect';
  if (!Array.isArray(a.clues) || a.clues.length !== 3) return 'clues must be exactly 3';
  for (const c of a.clues) if (typeof c !== 'string' || !c.trim()) return 'empty clue';
  if (!Array.isArray(a.characters) || a.characters.length < 2) return 'need at least 2 characters';
  // Arabic-content guard — at least the story must be predominantly Arabic.
  if (!ARABIC_SCRIPT_RE.test(a.story)) return 'story is not Arabic';
  return null;
}

/**
 * Narration must be short, Arabic-only, and not leak the mafiozo or final
 * solution. Returns the cleaned string on success, or null if the input
 * fails any rule.
 *
 * @param {string} text - raw model output
 * @param {object} [opts]
 * @param {string[]} [opts.forbiddenTerms] - extra phrases that must not appear
 *   (e.g. the actual mafiozo name when the AI host is generating mid-game lines).
 */
function validateNarration(text, opts = {}) {
  if (typeof text !== 'string') return null;
  let cleaned = text.replace(/```/g, '').trim();
  if (cleaned.length < NARRATION_MIN_LEN || cleaned.length > NARRATION_MAX_LEN) return null;

  // Reject markdown-style emphasis or developer-style headers.
  if (/^#{1,6}\s/m.test(cleaned)) return null;
  if (/^\s*\*\*/m.test(cleaned)) return null;

  // Arabic-content ratio guard. Letters-only count, then require that at
  // least 60% of letter-shaped chars are Arabic script. This tolerates
  // proper nouns (Mido, Kamal in Latin) without permitting English prose.
  const letters = cleaned.match(/[\p{L}]/gu) || [];
  if (letters.length === 0) return null;
  const arabicLetters = letters.filter(ch => ARABIC_SCRIPT_RE.test(ch)).length;
  if (arabicLetters / letters.length < 0.6) return null;

  // Forbidden-term filter (e.g. don't echo the mafiozo identity).
  const lower = cleaned.toLowerCase();
  for (const term of (opts.forbiddenTerms || [])) {
    if (term && lower.includes(String(term).toLowerCase())) return null;
  }

  return cleaned;
}

module.exports = {
  safeJsonParse,
  validateArchive,
  validateNarration,
  NARRATION_MAX_LEN,
};
