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

module.exports = {
  validateAndNormalizeProfileInput,
  mapProfileRow,
  mapStatsRow,
  LIMITS,
};
