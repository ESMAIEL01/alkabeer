/**
 * Pure helpers for the archive replay route. No express, no DB, no JWT —
 * importable from tests with zero production dependencies installed.
 */

/**
 * Decide whether the caller may read the archive for a given game.
 * Inputs:
 *   participantRows — array of { user_id } for the game (joined or all)
 *   callerId        — req.user.id from the auth middleware
 *   isAdmin         — req.user.isAdmin (defaults false until F2)
 * Returns true if the caller appears in the participants list OR is an
 * admin. Treats null/undefined inputs conservatively (denies).
 */
function canReadArchive(participantRows, callerId, isAdmin) {
  if (isAdmin === true) return true;
  if (callerId === null || callerId === undefined) return false;
  if (!Array.isArray(participantRows)) return false;
  for (const r of participantRows) {
    if (!r) continue;
    const uid = r.user_id !== undefined ? r.user_id : r.userId;
    if (uid === callerId) return true;
    if (uid !== null && uid !== undefined && String(uid) === String(callerId)) return true;
  }
  return false;
}

/** Map a game_sessions row to the safe public session shape. */
function mapSessionRow(row) {
  if (!row) return null;
  return {
    id:            row.id || null,
    scenarioTitle: row.scenario_title || null,
    hostMode:      row.host_mode || null,
    revealMode:    row.reveal_mode || null,
    outcome:       row.outcome || null,
    customConfig:  row.custom_config || null,
    endedAt:       row.ended_at || null,
    createdAt:     row.created_at || null,
    // Intentionally NOT surfaced: archive_b64, voting_history,
    // final_reveal, host_user_id. (final_reveal + voting_history are
    // returned at the response root via separate sanitized fields.)
  };
}

/**
 * Map participant rows to the public archive-replay shape. The game has
 * already reached FINAL_REVEAL by the time a row is in game_participants,
 * so role disclosure is permitted by the existing privacy contract.
 */
function mapParticipantRow(row) {
  if (!row) return null;
  return {
    userId:               row.user_id !== undefined ? row.user_id : null,
    username:             row.username || null,
    wasHost:              row.was_host === true,
    gameRole:             row.game_role || null,
    storyCharacterName:   row.story_character_name || null,
    storyCharacterRole:   row.story_character_role || null,
    eliminatedAtRound:    Number.isFinite(row.eliminated_at_round) ? row.eliminated_at_round : null,
    wasWinner:            typeof row.was_winner === 'boolean' ? row.was_winner : null,
  };
}

/** Pull caller-specific summary from a participant row (no other-player leak). */
function buildCallerSummary(participantRow) {
  if (!participantRow) {
    return { role: null, storyCharacterName: null, storyCharacterRole: null, wasWinner: null, eliminatedAtRound: null };
  }
  return {
    role:                 participantRow.game_role || null,
    storyCharacterName:   participantRow.story_character_name || null,
    storyCharacterRole:   participantRow.story_character_role || null,
    wasWinner:            typeof participantRow.was_winner === 'boolean' ? participantRow.was_winner : null,
    eliminatedAtRound:    Number.isFinite(participantRow.eliminated_at_round) ? participantRow.eliminated_at_round : null,
  };
}

/**
 * Sanitize the voting_history JSONB before sending to the client. Each
 * entry is allow-listed: round, eliminatedId, eliminatedUsername,
 * wasMafiozo, reason, closedBy. The full per-voter target map is
 * intentionally NOT surfaced — knowing who voted for whom is private
 * deduction information that even participants do not need post-hoc.
 */
function sanitizeVotingHistory(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map(h => {
    if (!h || typeof h !== 'object') return null;
    return {
      round:              Number.isFinite(h.round) ? h.round : null,
      eliminatedId:       h.eliminatedId !== undefined ? h.eliminatedId : null,
      eliminatedUsername: h.eliminatedUsername || null,
      wasMafiozo:         h.wasMafiozo === true,
      reason:             h.reason || null,
      closedBy:           h.closedBy || null,
    };
  }).filter(x => x !== null);
}

module.exports = {
  canReadArchive,
  mapSessionRow,
  mapParticipantRow,
  buildCallerSummary,
  sanitizeVotingHistory,
};
