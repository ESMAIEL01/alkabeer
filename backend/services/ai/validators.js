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

// Hotfix — sharia-safe / culturally-appropriate content filter shared
// across the bio + identity validators. See safe-content.js for the
// documented categories.
const { containsForbiddenTerm } = require('./safe-content');

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

// Strings that some models emit as placeholder filler. Reject them.
const PLACEHOLDER_HINTS = [
  'todo', 'tbd', 'placeholder', 'lorem', 'ipsum',
  '...', '…', 'xxx', '???',
];

function looksLikePlaceholder(s) {
  if (typeof s !== 'string') return false;
  const trimmed = s.trim().toLowerCase();
  if (!trimmed) return true;
  for (const hint of PLACEHOLDER_HINTS) {
    if (trimmed === hint || trimmed.startsWith(hint + ' ') || trimmed.endsWith(' ' + hint)) {
      return true;
    }
  }
  return false;
}

/**
 * Validate a sealed-archive object. Returns null if valid, else a short reason
 * string useful for warn-level logs. Reasons include indices where applicable.
 *
 * Never logs the raw archive content — only the field/index that failed.
 *
 * E4: optional opts for Custom Mode:
 *   { expectedClues, expectedMafiozos, expectedCharacters }
 * Default opts preserve pre-E4 behavior (3 clues, 1 mafiozo, ≥2 chars).
 *
 * Multi-Mafiozo support: archive.mafiozos array (length === expectedMafiozos)
 * is the preferred shape. The legacy singular archive.mafiozo string is
 * accepted ONLY when expectedMafiozos === 1 (backwards compat with default
 * archive prompts).
 */
function validateArchive(a, opts = {}) {
  if (!a || typeof a !== 'object') return 'not an object';

  const expectedClues      = Number.isFinite(opts.expectedClues)      ? opts.expectedClues      : 3;
  const expectedMafiozos   = Number.isFinite(opts.expectedMafiozos)   ? opts.expectedMafiozos   : 1;
  const expectedCharacters = Number.isFinite(opts.expectedCharacters) ? opts.expectedCharacters : null;

  // story
  if (typeof a.story !== 'string') return 'missing story';
  if (a.story.trim().length < 60) return 'story too short';
  if (!ARABIC_SCRIPT_RE.test(a.story)) return 'non-Arabic story';

  // Mafiozo identity. Two acceptable shapes:
  //   1. archive.mafiozos = [{ name, role, suspicious_detail }, ...]
  //      length must equal expectedMafiozos.
  //   2. archive.mafiozo = "string" — only when expectedMafiozos === 1.
  if (Array.isArray(a.mafiozos)) {
    if (a.mafiozos.length !== expectedMafiozos) {
      return `expected exactly ${expectedMafiozos} mafiozos, got ${a.mafiozos.length}`;
    }
    for (let i = 0; i < a.mafiozos.length; i++) {
      const m = a.mafiozos[i];
      if (!m || typeof m !== 'object') return `invalid mafiozo at index ${i}`;
      if (typeof m.name !== 'string' || !m.name.trim()) return `missing name on mafiozo ${i}`;
      if (looksLikePlaceholder(m.name)) return `placeholder mafiozo name at index ${i}`;
    }
  } else {
    if (expectedMafiozos !== 1) {
      return `expected ${expectedMafiozos} mafiozos in mafiozos array, got singular mafiozo string`;
    }
    if (typeof a.mafiozo !== 'string' || !a.mafiozo.trim()) return 'missing mafiozo';
    if (looksLikePlaceholder(a.mafiozo)) return 'mafiozo is placeholder text';
  }

  // obvious_suspect (optional in custom mode but retained for default)
  if (typeof a.obvious_suspect !== 'string' || !a.obvious_suspect.trim()) return 'missing obvious_suspect';
  if (looksLikePlaceholder(a.obvious_suspect)) return 'obvious_suspect is placeholder text';

  // clues — must be exactly expectedClues, each a non-empty Arabic string, no placeholders
  if (!Array.isArray(a.clues)) return 'clues is not an array';
  if (a.clues.length !== expectedClues) return `expected exactly ${expectedClues} clues, got ${a.clues.length}`;
  for (let i = 0; i < a.clues.length; i++) {
    const c = a.clues[i];
    if (c === null || c === undefined) return `null clue at index ${i}`;
    if (typeof c !== 'string') return `non-string clue at index ${i}`;
    if (!c.trim()) return `empty clue at index ${i}`;
    if (looksLikePlaceholder(c)) return `placeholder clue at index ${i}`;
    if (!ARABIC_SCRIPT_RE.test(c)) return `non-Arabic clue at index ${i}`;
  }

  // characters — at least 2 by default, or exact count when supplied
  if (!Array.isArray(a.characters)) return 'characters is not an array';
  if (expectedCharacters !== null) {
    if (a.characters.length !== expectedCharacters) {
      return `expected exactly ${expectedCharacters} characters, got ${a.characters.length}`;
    }
  } else if (a.characters.length < 2) {
    return `need at least 2 characters, got ${a.characters.length}`;
  }
  for (let i = 0; i < a.characters.length; i++) {
    const ch = a.characters[i];
    if (!ch || typeof ch !== 'object') return `invalid character at index ${i}`;
    if (typeof ch.name !== 'string' || !ch.name.trim()) return `missing name on character ${i}`;
    if (typeof ch.role !== 'string' || !ch.role.trim()) return `missing role on character ${i}`;
  }

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

// ---------------------------------------------------------------------------
// AI polish validators (C2 / C3).
//
// Polish lines are short Arabic noir flavor that the deterministic UI may
// optionally render. They must NEVER leak hidden roles, JSON internals,
// markdown, or AI disclaimers. validatePolishLine extends validateNarration
// with extra rejections specific to the polish use case.
// ---------------------------------------------------------------------------

// Hard-coded reject set applied to every polish line, in addition to any
// caller-supplied forbiddenTerms (e.g. alive Mafiozo names mid-game).
const POLISH_HARD_FORBIDDEN = [
  'undefined',
  'gameRole',
  'roleAssignments',
  'as an AI',
  'I cannot',
  'كذكاء اصطناعي',
  'كنموذج لغة',
];

/**
 * Validate a short AI-generated noir flavor line. Returns the cleaned string
 * or null. Rejects: empty, too short/long, English-dominant, markdown, JSON
 * fragments, code fences, AI disclaimers, hidden-role tokens, and any
 * caller-supplied forbidden term (typically alive Mafiozo identity).
 */
function validatePolishLine(text, opts = {}) {
  // Strict: reject code fences in the RAW output (validateNarration would
  // silently strip them; for polish lines that is too permissive — fences
  // signal the model misunderstood the format).
  if (typeof text === 'string' && /```/.test(text)) return null;

  const forbidden = [...(opts.forbiddenTerms || []), ...POLISH_HARD_FORBIDDEN];
  const cleaned = validateNarration(text, { forbiddenTerms: forbidden });
  if (!cleaned) return null;
  // Reject JSON-shaped output (model returned a JSON object/array).
  if (/^\s*[{\[]/.test(cleaned)) return null;
  // Reject markdown bold/heading variations validateNarration didn't catch.
  if (/^\s*[*_]{2,}/m.test(cleaned)) return null;
  return cleaned;
}

// Final-reveal polish: AI returns a JSON object with optional fields. Each
// field is short Arabic noir prose. We parse, then validate per field.
const FINAL_REVEAL_FIELD_LIMITS = Object.freeze({
  heroSubtitle: 240,
  caseClosingLine: 260,
  finalParagraph: 700,
  epilogue: 500,
});

/**
 * Validate AI final-reveal polish JSON. Returns an object containing only
 * the valid optional fields, or null if none survived.
 */
function validateFinalRevealPolish(text) {
  if (typeof text !== 'string') return null;
  const obj = safeJsonParse(text);
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;

  const out = {};
  for (const [field, maxLen] of Object.entries(FINAL_REVEAL_FIELD_LIMITS)) {
    const v = obj[field];
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string') continue;
    let trimmed = v.replace(/```/g, '').trim();
    if (!trimmed) continue;
    if (trimmed.length > maxLen) continue;
    // Reject markdown bold/heading variations and JSON fragments.
    if (/^#{1,6}\s/m.test(trimmed)) continue;
    if (/^\s*[*_]{2,}/m.test(trimmed)) continue;
    if (/^\s*[{\[]/.test(trimmed)) continue;
    // Reject hidden-token / AI-disclaimer leakage.
    const lower = trimmed.toLowerCase();
    let blocked = false;
    for (const t of POLISH_HARD_FORBIDDEN) {
      if (lower.includes(String(t).toLowerCase())) { blocked = true; break; }
    }
    if (blocked) continue;
    // Arabic-dominant content guard (≥60% of letters Arabic script).
    const letters = trimmed.match(/[\p{L}]/gu) || [];
    if (letters.length === 0) continue;
    const ar = letters.filter(ch => ARABIC_SCRIPT_RE.test(ch)).length;
    if (ar / letters.length < 0.6) continue;

    out[field] = trimmed;
  }

  if (Object.keys(out).length === 0) return null;
  return out;
}

// ---------------------------------------------------------------------------
// Profile bio validator (D5).
//
// Stricter than narration: bios are rendered on a public-ish surface
// (any logged-in user fetching their own profile sees it; a future
// public profile page will too). We reject URLs, emails, phones,
// @mentions, hashtags, markdown, code fences, AI disclaimers, JSON
// fragments, and English-dominant content. 80..500 chars.
// ---------------------------------------------------------------------------

const BIO_MIN_LEN = 80;
const BIO_MAX_LEN = 500;

const BIO_FORBIDDEN_TERMS = [
  'undefined',
  'gameRole',
  'roleAssignments',
  'as an AI',
  'I cannot',
  'كذكاء اصطناعي',
  'كنموذج لغة',
];

// Patterns that immediately reject a bio.
const URL_RE   = /\b(?:https?:\/\/|www\.)\S+/i;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
// Conservative phone heuristic: 7+ consecutive digits, with optional + and
// internal separators. Also catches Arabic-Indic digits.
const PHONE_RE = /(?:\+?[\d٠-٩][\d٠-٩\s\-]{6,})/;
const MENTION_RE = /(?:^|\s)@\w/;
const HASHTAG_RE = /(?:^|\s)#\S/;

function validateBio(text) {
  if (typeof text !== 'string') return null;
  // Reject code fences in the raw input (validateNarration would silently
  // strip them; bios should be rejected outright).
  if (/```/.test(text)) return null;

  const cleaned = text.replace(/[\r\n]+/g, ' ').trim();
  if (cleaned.length < BIO_MIN_LEN || cleaned.length > BIO_MAX_LEN) return null;

  // Markdown / heading / bold rejection.
  if (/^#{1,6}\s/m.test(cleaned)) return null;
  if (/^\s*[*_]{2,}/m.test(cleaned)) return null;
  if (/^\s*[{\[]/.test(cleaned)) return null;

  // URL / email / phone / mention / hashtag — never allowed.
  if (URL_RE.test(cleaned))   return null;
  if (EMAIL_RE.test(cleaned)) return null;
  if (PHONE_RE.test(cleaned)) return null;
  if (MENTION_RE.test(cleaned)) return null;
  if (HASHTAG_RE.test(cleaned)) return null;

  // Hidden tokens / AI disclaimers.
  const lower = cleaned.toLowerCase();
  for (const t of BIO_FORBIDDEN_TERMS) {
    if (lower.includes(String(t).toLowerCase())) return null;
  }

  // Hotfix — sharia-safe content filter (alcohol / drugs / gambling /
  // sexual / satanic / occult / blasphemous / profanity).
  if (containsForbiddenTerm(cleaned).hit) return null;

  // Arabic-dominant guard. Hotfix raises the threshold from 60% → 80%
  // so a few proper nouns (Mafiozo, the player's western username) are
  // tolerated but the body of the bio is essentially Arabic.
  const letters = cleaned.match(/[\p{L}]/gu) || [];
  if (letters.length === 0) return null;
  const ar = letters.filter(ch => ARABIC_SCRIPT_RE.test(ch)).length;
  if (ar / letters.length < 0.8) return null;

  return cleaned;
}

// ---------------------------------------------------------------------------
// Identity-interview output validator (FixPack v3 / Commit 2).
//
// Expected shape:
//   { bio, title, tone, motto, playStyleSummary }
// Field length windows (chars after trim):
//   bio              80..500
//   title             4..60
//   tone              4..80
//   motto             8..120
//   playStyleSummary 30..260
//
// The same shared denylist used for bios applies: no URLs, no emails, no
// phones, no @mentions, no #hashtags, no markdown/code fences, no AI
// disclaimers, no "undefined", no "gameRole" / "roleAssignments". Arabic
// must be ≥60% of letters across every field combined. Returns the cleaned
// object on success or null on any rejection — never throws.
// ---------------------------------------------------------------------------

const IDENTITY_FIELD_LIMITS = Object.freeze({
  bio:              { min: 80,  max: 500 },
  title:            { min: 4,   max: 60  },
  tone:             { min: 4,   max: 80  },
  motto:            { min: 8,   max: 120 },
  playStyleSummary: { min: 30,  max: 260 },
});

function validateIdentityInterviewOutput(raw) {
  let parsed = raw;
  if (typeof raw === 'string') {
    parsed = safeJsonParse(raw);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const cleaned = {};
  let totalLetters = 0;
  let totalArabicLetters = 0;

  for (const [key, limits] of Object.entries(IDENTITY_FIELD_LIMITS)) {
    const v = parsed[key];
    if (typeof v !== 'string') return null;
    if (/```/.test(v)) return null;
    const trimmed = v.replace(/[\r\n]+/g, ' ').trim();
    if (trimmed.length < limits.min || trimmed.length > limits.max) return null;

    if (/^#{1,6}\s/m.test(trimmed)) return null;
    if (/^\s*[*_]{2,}/m.test(trimmed)) return null;
    if (/^\s*[{\[]/.test(trimmed)) return null;
    if (URL_RE.test(trimmed))    return null;
    if (EMAIL_RE.test(trimmed))  return null;
    if (PHONE_RE.test(trimmed))  return null;
    if (MENTION_RE.test(trimmed)) return null;
    if (HASHTAG_RE.test(trimmed)) return null;

    const lower = trimmed.toLowerCase();
    for (const t of BIO_FORBIDDEN_TERMS) {
      if (lower.includes(String(t).toLowerCase())) return null;
    }

    // Hotfix — sharia-safe content filter applies to EVERY identity field.
    if (containsForbiddenTerm(trimmed).hit) return null;

    const letters = trimmed.match(/[\p{L}]/gu) || [];
    if (letters.length === 0) return null;
    totalLetters += letters.length;
    totalArabicLetters += letters.filter(ch => ARABIC_SCRIPT_RE.test(ch)).length;

    cleaned[key] = trimmed;
  }
  if (totalLetters === 0) return null;
  // Hotfix — Arabic-dominant tightened from 60% → 80%.
  if (totalArabicLetters / totalLetters < 0.8) return null;

  return cleaned;
}

module.exports = {
  safeJsonParse,
  validateArchive,
  validateNarration,
  validatePolishLine,
  validateFinalRevealPolish,
  validateBio,
  validateIdentityInterviewOutput,
  FINAL_REVEAL_FIELD_LIMITS,
  IDENTITY_FIELD_LIMITS,
  NARRATION_MAX_LEN,
  BIO_MIN_LEN,
  BIO_MAX_LEN,
};
