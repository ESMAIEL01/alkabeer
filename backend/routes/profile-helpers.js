/**
 * Pure helpers for the profile + stats routes.
 *
 * No express, no jsonwebtoken, no DB. Importable from tests without any
 * production dependency installed. The route files (profile.js, stats.js)
 * re-export these so consumers can pick either entry.
 */

const DISPLAY_NAME_MIN = 2;
const DISPLAY_NAME_MAX = 32;
const AVATAR_URL_MAX = 500;
const BIO_MAX = 500;

const LIMITS = Object.freeze({
  DISPLAY_NAME_MIN, DISPLAY_NAME_MAX, AVATAR_URL_MAX, BIO_MAX,
});

/**
 * Validate + normalize a profile-update body.
 * Returns { ok, errors[], normalized: {displayName|null, avatarUrl|null, bio|null} }.
 *
 * For each field:
 *   - Absent or null → leave as null (caller's SQL uses COALESCE to keep
 *     existing value).
 *   - Present non-null → validate; on failure push an Arabic error and
 *     leave that slot as null.
 *
 * displayName: trimmed, length 2..32. Empty string is REJECTED — clearing
 *   the display name is not allowed (falls back to username).
 * avatarUrl: trimmed. Empty string IS allowed (explicit clear).
 *   Non-empty must be https:// and ≤ AVATAR_URL_MAX chars.
 * bio: trimmed, length ≤ BIO_MAX. Empty string IS allowed (clear).
 *   Crude <script> rejection — backend stores plain text only; the
 *   frontend renders via React's normal text path, so XSS isn't possible
 *   in the current consumer, but we reject obviously hostile payloads.
 */
function validateAndNormalizeProfileInput(body) {
  const b = (body && typeof body === 'object') ? body : {};
  const out = { displayName: null, avatarUrl: null, bio: null };
  const errors = [];

  if (b.displayName !== undefined && b.displayName !== null) {
    if (typeof b.displayName !== 'string') {
      errors.push('اسم العرض لازم يكون نص.');
    } else {
      const v = b.displayName.trim();
      if (v.length < DISPLAY_NAME_MIN) {
        errors.push(`اسم العرض لازم يكون من ${DISPLAY_NAME_MIN} حروف على الأقل.`);
      } else if (v.length > DISPLAY_NAME_MAX) {
        errors.push(`اسم العرض طويل جداً (الحد الأقصى ${DISPLAY_NAME_MAX} حرف).`);
      } else {
        out.displayName = v;
      }
    }
  }

  if (b.avatarUrl !== undefined && b.avatarUrl !== null) {
    if (typeof b.avatarUrl !== 'string') {
      errors.push('رابط الصورة لازم يكون نص.');
    } else {
      const v = b.avatarUrl.trim();
      if (v.length === 0) {
        out.avatarUrl = '';                       // explicit clear
      } else if (v.length > AVATAR_URL_MAX) {
        errors.push('رابط الصورة طويل جداً.');
      } else if (!/^https:\/\//i.test(v)) {
        errors.push('رابط الصورة لازم يبدأ بـ https://');
      } else if (/<\s*script/i.test(v)) {
        errors.push('رابط الصورة فيه شيء غير آمن.');
      } else {
        out.avatarUrl = v;
      }
    }
  }

  if (b.bio !== undefined && b.bio !== null) {
    if (typeof b.bio !== 'string') {
      errors.push('السيرة لازم تكون نص.');
    } else {
      const v = b.bio.trim();
      if (v.length > BIO_MAX) {
        errors.push(`السيرة طويلة جداً (الحد الأقصى ${BIO_MAX} حرف).`);
      } else if (/<\s*script/i.test(v)) {
        errors.push('السيرة فيها شيء غير آمن.');
      } else {
        out.bio = v;
      }
    }
  }

  return { ok: errors.length === 0, errors, normalized: out };
}

/** Map a user_profiles row to public camelCase. user_id is intentionally NOT surfaced. */
function mapProfileRow(row) {
  if (!row) return null;
  return {
    displayName: row.display_name || null,
    avatarUrl:   row.avatar_url   || null,
    bio:         row.bio          || null,
    aiBio:       row.ai_bio       || null,
    aiBioSource: row.ai_bio_source || null,
    createdAt:   row.created_at   || null,
    updatedAt:   row.updated_at   || null,
  };
}

/**
 * Map a user_stats row to public camelCase + computed winRate.
 * winRate is reported as a percentage INTEGER (0..100).
 * gamesPlayed === 0 → 0.
 *
 * NEVER surfaces archive_b64, final_reveal, voting_history, gameRole,
 * or roleAssignments — those columns don't exist on user_stats anyway,
 * but the allow-list shape is documented and tested.
 */
function mapStatsRow(row) {
  const r = row || {};
  const games = Number.isFinite(r.games_played) ? r.games_played : 0;
  const wins  = Number.isFinite(r.wins) ? r.wins : 0;
  return {
    gamesPlayed:          games,
    wins,
    losses:               Number.isFinite(r.losses) ? r.losses : 0,
    winRate:              games > 0 ? Math.round((wins / games) * 100) : 0,
    timesMafiozo:         Number.isFinite(r.times_mafiozo) ? r.times_mafiozo : 0,
    timesInnocent:        Number.isFinite(r.times_innocent) ? r.times_innocent : 0,
    timesObviousSuspect:  Number.isFinite(r.times_obvious_suspect) ? r.times_obvious_suspect : 0,
    totalSurvivalRounds:  Number.isFinite(r.total_survival_rounds) ? r.total_survival_rounds : 0,
    favoriteMode:         r.favorite_mode || null,
    lastPlayedAt:         r.last_played_at || null,
  };
}

// ---------------------------------------------------------------------------
// AI bio request validator (D5).
//
// rawIdea is the user's free-text seed for the AI bio writer. The helper
// trims, length-checks (10..300), and rejects URLs / script tags. We
// deliberately reject URLs at the request boundary so the AI provider
// never sees them in the prompt body.
// ---------------------------------------------------------------------------

const BIO_AI_RAW_MIN = 10;
const BIO_AI_RAW_MAX = 300;

function validateBioAiRequest(body) {
  const b = (body && typeof body === 'object') ? body : {};
  if (typeof b.rawIdea !== 'string') {
    return { ok: false, error: 'لازم تكتب فكرة مختصرة عن نفسك.' };
  }
  const trimmed = b.rawIdea.replace(/[\r\n]+/g, ' ').trim();
  if (trimmed.length < BIO_AI_RAW_MIN) {
    return { ok: false, error: `الفكرة لازم تكون ${BIO_AI_RAW_MIN} حروف على الأقل.` };
  }
  if (trimmed.length > BIO_AI_RAW_MAX) {
    return { ok: false, error: `الفكرة طويلة جداً (الحد الأقصى ${BIO_AI_RAW_MAX} حرف).` };
  }
  if (/<\s*script/i.test(trimmed)) {
    return { ok: false, error: 'الفكرة فيها شيء غير آمن.' };
  }
  if (/\b(?:https?:\/\/|www\.)\S+/i.test(trimmed)) {
    return { ok: false, error: 'لا تكتب روابط داخل الفكرة.' };
  }
  return { ok: true, normalized: { rawIdea: trimmed } };
}

// ---------------------------------------------------------------------------
// AI identity-interview request validator (FixPack v3 / Commit 2).
//
// Body shape: { answers: [ { questionId, question, answer }, ... ] }.
//   - answers length 3..6
//   - each answer 2..180 chars (after trim)
//   - questionId / question are short safe strings (≤ 80 / ≤ 240 chars)
//   - reject URLs, emails, phone numbers, HTML/script, markdown/code fences
//   - reject empty answers
//
// On success returns { ok: true, normalized: { username?, answers: [...] } }
// where each normalized answer is { questionId, question, answer } trimmed
// and length-bounded. The username slot is reserved for the route handler
// to fill from req.user — never trusted from the body.
// ---------------------------------------------------------------------------

const IDENTITY_ANSWERS_MIN = 3;
const IDENTITY_ANSWERS_MAX = 6;
const IDENTITY_ANSWER_MIN = 2;
const IDENTITY_ANSWER_MAX = 180;
const IDENTITY_QUESTION_MAX = 240;
const IDENTITY_QID_MAX = 80;

const IDENTITY_URL_RE     = /\b(?:https?:\/\/|www\.)\S+/i;
const IDENTITY_EMAIL_RE   = /\b[\w.+-]+@[\w-]+\.[a-z]{2,}\b/i;
// 7+ consecutive ASCII or Arabic-Indic digits with optional separators.
const IDENTITY_PHONE_RE   = /(?:\+?[\d٠-٩][\d٠-٩\s\-]{6,})/;
const IDENTITY_SCRIPT_RE  = /<\s*\/?\s*(?:script|style|iframe|img|svg|object|embed)\b/i;
// Conservative HTML tag detection — anything that looks like <foo ...>.
const IDENTITY_HTML_RE    = /<\s*[a-z][^>]*>/i;
const IDENTITY_FENCE_RE   = /```/;
const IDENTITY_MD_HDR_RE  = /^\s*#{1,6}\s/;
const IDENTITY_MD_BOLD_RE = /\*\*[^*]+\*\*|__[^_]+__/;

function validateIdentityInterviewRequest(body) {
  const b = (body && typeof body === 'object') ? body : {};
  if (!Array.isArray(b.answers)) {
    return { ok: false, error: 'الإجابات لازم تكون قائمة.' };
  }
  if (b.answers.length < IDENTITY_ANSWERS_MIN) {
    return { ok: false, error: `لازم تجاوب على ${IDENTITY_ANSWERS_MIN} أسئلة على الأقل.` };
  }
  if (b.answers.length > IDENTITY_ANSWERS_MAX) {
    return { ok: false, error: `الحد الأقصى ${IDENTITY_ANSWERS_MAX} إجابات.` };
  }

  const out = [];
  const seenIds = new Set();
  for (let i = 0; i < b.answers.length; i++) {
    const a = b.answers[i] || {};
    if (typeof a !== 'object' || Array.isArray(a)) {
      return { ok: false, error: `الإجابة رقم ${i + 1} شكلها غلط.` };
    }
    const questionId = typeof a.questionId === 'string' ? a.questionId.trim() : '';
    const question = typeof a.question === 'string' ? a.question.trim() : '';
    const answerRaw = typeof a.answer === 'string' ? a.answer : '';
    const answer = answerRaw.replace(/[\r\n\t]+/g, ' ').trim();

    if (!questionId || questionId.length > IDENTITY_QID_MAX) {
      return { ok: false, error: `معرّف السؤال رقم ${i + 1} غير صالح.` };
    }
    if (seenIds.has(questionId)) {
      return { ok: false, error: 'لا تكرر نفس السؤال.' };
    }
    seenIds.add(questionId);
    if (!question || question.length > IDENTITY_QUESTION_MAX) {
      return { ok: false, error: `نص السؤال رقم ${i + 1} غير صالح.` };
    }
    if (answer.length < IDENTITY_ANSWER_MIN) {
      return { ok: false, error: `الإجابة رقم ${i + 1} قصيرة جداً.` };
    }
    if (answer.length > IDENTITY_ANSWER_MAX) {
      return { ok: false, error: `الإجابة رقم ${i + 1} طويلة جداً (الحد الأقصى ${IDENTITY_ANSWER_MAX} حرف).` };
    }
    // Reject URLs, emails, phones, HTML/script, markdown/code fences in the answer.
    if (IDENTITY_URL_RE.test(answer))    return { ok: false, error: `الإجابة رقم ${i + 1} فيها رابط — مش مسموح.` };
    if (IDENTITY_EMAIL_RE.test(answer))  return { ok: false, error: `الإجابة رقم ${i + 1} فيها إيميل — مش مسموح.` };
    if (IDENTITY_PHONE_RE.test(answer))  return { ok: false, error: `الإجابة رقم ${i + 1} فيها رقم تليفون — مش مسموح.` };
    if (IDENTITY_SCRIPT_RE.test(answer)) return { ok: false, error: `الإجابة رقم ${i + 1} فيها كود غير آمن.` };
    if (IDENTITY_HTML_RE.test(answer))   return { ok: false, error: `الإجابة رقم ${i + 1} فيها HTML — مش مسموح.` };
    if (IDENTITY_FENCE_RE.test(answer))  return { ok: false, error: `الإجابة رقم ${i + 1} فيها code fence — مش مسموح.` };
    if (IDENTITY_MD_HDR_RE.test(answer)) return { ok: false, error: `الإجابة رقم ${i + 1} فيها تنسيق markdown — اكتبها كنص عادي.` };
    if (IDENTITY_MD_BOLD_RE.test(answer))return { ok: false, error: `الإجابة رقم ${i + 1} فيها تنسيق markdown — اكتبها كنص عادي.` };

    out.push({ questionId, question, answer });
  }

  return { ok: true, normalized: { answers: out } };
}

module.exports = {
  validateAndNormalizeProfileInput,
  validateBioAiRequest,
  validateIdentityInterviewRequest,
  mapProfileRow,
  mapStatsRow,
  LIMITS,
  BIO_AI_RAW_MIN,
  BIO_AI_RAW_MAX,
  IDENTITY_ANSWERS_MIN,
  IDENTITY_ANSWERS_MAX,
  IDENTITY_ANSWER_MIN,
  IDENTITY_ANSWER_MAX,
};
