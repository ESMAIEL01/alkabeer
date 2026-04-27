/**
 * Pure helpers for the history route. No express, no DB, no JWT —
 * importable from tests with zero production dependencies installed.
 */

const LIMIT_MIN = 1;
const LIMIT_MAX = 50;
const LIMIT_DEFAULT = 10;

const LIMITS = Object.freeze({ LIMIT_MIN, LIMIT_MAX, LIMIT_DEFAULT });

/**
 * Parse + clamp ?limit and ?offset query parameters.
 * Defaults: limit=10, offset=0. Limit clamped to [1..50].
 * Invalid input falls back to defaults — pagination is best-effort.
 */
function parsePagination(q) {
  const qq = q || {};
  const limitRaw = parseInt(qq.limit, 10);
  const offsetRaw = parseInt(qq.offset, 10);
  const limit = Number.isFinite(limitRaw)
    ? Math.max(LIMIT_MIN, Math.min(LIMIT_MAX, limitRaw))
    : LIMIT_DEFAULT;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
  return { limit, offset };
}

/**
 * Map a joined participant + session row into the safe public history
 * shape. Allow-listed fields ONLY. NEVER surfaces archive_b64,
 * final_reveal, voting_history, or roleAssignments — those live on
 * D4's archive replay endpoint with its own participants gate.
 */
function mapHistoryRow(row) {
  if (!row) return null;
  return {
    id:                  row.id || row.game_id || null,
    scenarioTitle:       row.scenario_title || null,
    hostMode:            row.host_mode || null,
    revealMode:          row.reveal_mode || null,
    outcome:             row.outcome || null,
    role:                row.game_role || null,
    storyCharacterName:  row.story_character_name || null,
    storyCharacterRole:  row.story_character_role || null,
    eliminatedAtRound:   Number.isFinite(row.eliminated_at_round) ? row.eliminated_at_round : null,
    wasWinner:           typeof row.was_winner === 'boolean' ? row.was_winner : null,
    endedAt:             row.ended_at || null,
    createdAt:           row.created_at || null,
  };
}

module.exports = { parsePagination, mapHistoryRow, LIMITS };
