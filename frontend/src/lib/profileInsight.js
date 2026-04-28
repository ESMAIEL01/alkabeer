/**
 * profileInsight — deterministic, pure helpers that turn a user_stats
 * snapshot into Mafiozo-noir Arabic interpretation strings.
 *
 * No React, no fetch, no dates beyond what's already in the input.
 * Works for null/undefined/incomplete input — the worst case returns the
 * generic "your style is still forming" phrase.
 *
 * The helpers are explicitly content-only — no telemetry, no IDs, no
 * persistence. Used by ProfilePage to render an interpretive line below
 * the stats grid.
 */

const N = (v) => (Number.isFinite(v) ? v : 0);

/**
 * One-line interpretation of stats. Order matters: earlier branches win
 * over later ones. Empty archive ALWAYS wins (no other line makes sense
 * before the first game).
 *
 * @param {object} stats   shape from /api/stats/me
 * @returns {string}       Arabic prose
 */
function getProfileInsight(stats) {
  const s = stats || {};
  const games = N(s.gamesPlayed);
  if (games === 0) {
    return 'الأرشيف فاضي لسه. أول قضية هتبدأ ترسم هويتك.';
  }
  const winRate = N(s.winRate);
  if (winRate >= 60) {
    return 'أداؤك قوي، وقراراتك غالبًا بتقرب الفريق من الحقيقة.';
  }
  const timesMafiozo = N(s.timesMafiozo);
  const timesInnocent = N(s.timesInnocent);
  if (timesMafiozo > 0 && timesMafiozo > timesInnocent) {
    return 'واضح إن الظل اختارك أكتر من مرة.';
  }
  // High survival is "averaging at least 3 surviving rounds per game".
  // Using a per-game rate keeps the line meaningful for both casual and
  // hardcore players.
  const totalSurvival = N(s.totalSurvivalRounds);
  if (games > 0 && totalSurvival / games >= 3) {
    return 'بتعرف تعيش لآخر النفس في القضية.';
  }
  return 'أسلوبك لسه بيتشكل مع كل قضية.';
}

/**
 * Short role-tendency tag. Returns one of:
 *   'mafiozo_leaning' | 'innocent_leaning' | 'obvious_suspect_leaning'
 *   | 'balanced' | 'unknown'
 *
 * Used to drive a small badge in the identity card. NEVER reveals
 * per-game role assignments — just a counted preference summary which
 * is already public data on /api/stats/me.
 */
function getRoleTendency(stats) {
  const s = stats || {};
  const games = N(s.gamesPlayed);
  if (games === 0) return 'unknown';
  const m = N(s.timesMafiozo);
  const i = N(s.timesInnocent);
  const o = N(s.timesObviousSuspect);
  if (m === 0 && i === 0 && o === 0) return 'unknown';
  if (m > i && m > o) return 'mafiozo_leaning';
  if (o > i && o > m) return 'obvious_suspect_leaning';
  if (i > m && i > o) return 'innocent_leaning';
  return 'balanced';
}

/**
 * Human-friendly Arabic label for a role-tendency tag.
 */
function formatRoleTendency(tag) {
  switch (tag) {
    case 'mafiozo_leaning':         return 'بيظهر كظل أكتر من غيره';
    case 'obvious_suspect_leaning': return 'بيتلبّس دور المشتبه الواضح';
    case 'innocent_leaning':        return 'بيشتغل من جنب المحققين';
    case 'balanced':                return 'دوره بيتغيّر من قضية لقضية';
    case 'unknown':
    default:                        return 'دوره لسه بيتحدد';
  }
}

/**
 * formatStatLabel — clamp a numeric stat to a friendly representation.
 * Used by the hero chip row.
 */
function formatStatLabel(value) {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) return value.toLocaleString('en-US');
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
  return String(value);
}

export {
  getProfileInsight,
  getRoleTendency,
  formatRoleTendency,
  formatStatLabel,
};
