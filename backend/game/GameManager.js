const crypto = require('crypto');

// AI polish (C2 / C3). Imported via lazy try/require so test harnesses
// that do not exercise the AI path don't require the whole AI subtree.
let _ai = null;
function getAi() {
  if (_ai !== null) return _ai;
  try {
    _ai = require('../services/ai');
  } catch (_) {
    _ai = false; // sentinel — AI module unavailable; polish becomes a no-op.
  }
  return _ai;
}

/**
 * GameManager — multiplayer state machine for Mafiozo.
 *
 * Phase flow (post-finalize):
 *   ROLE_REVEAL (30 s)
 *     ↓
 *   PUBLIC_CHARACTER_OVERVIEW (10 s)
 *     ↓
 *   CLUE_REVEAL (45 s)
 *     ↓
 *   VOTING (30 s — early-close logic lands in Commit 2)
 *     ↓
 *   loop CLUE_REVEAL until clueIndex === 2, then POST_GAME
 *
 * Privacy contract:
 *   - `your_role_card` is the ONLY event that may carry a player's gameRole.
 *   - It is sent with `this.io.to(socketId).emit(...)` — never broadcast.
 *   - `full_state_update` carries ONLY `publicCharacterCards` — strict allow-
 *     list of {playerId, username, storyCharacterName, storyCharacterRole,
 *     suspiciousDetail}. Never spread `roleAssignments`.
 *   - In blind mode, the `gameRole` field is OMITTED from the private card
 *     entirely (not set to null) — DevTools observers cannot infer it exists.
 */

// Deterministic NPC fallback characters when archive provides fewer characters
// than players. Templates only — no real names, no leak risk.
const NPC_SHELLS = [
  { name: 'ضيف غامض',      role: 'زائر',           suspicious_detail: 'كان واقف بعيد عن الجميع طول الليل، وعينه على الباب.' },
  { name: 'عامل المكان',    role: 'عامل',           suspicious_detail: 'دخل وخرج كذا مرة من غير ما حد ياخد باله.' },
  { name: 'شاهد متردد',    role: 'شاهد',           suspicious_detail: 'حكى قصة ناقصة وكأنه بيخبي حاجة.' },
  { name: 'زائر مجهول',    role: 'زائر',           suspicious_detail: 'محدش يتذكر إزاي دخل ولا مين دعاه.' },
  { name: 'خادم ساكت',     role: 'خادم',           suspicious_detail: 'سمع كل اللي اتقال بس مش بيتكلم.' },
  { name: 'صديق قديم',     role: 'معرفة',          suspicious_detail: 'ظهر فجأة بعد سنين غياب في نفس الليلة.' },
];

const VALID_REVEAL_MODES = new Set(['normal', 'blind']);

/**
 * Cryptographically-secure Fisher-Yates shuffle. Returns a NEW array.
 */
function secureShuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = crypto.randomInt(0, i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Pad archive characters up to N with deterministic NPC shells.
 * Returns an array of EXACTLY N character objects.
 */
function padCharactersToCount(archiveCharacters, n) {
  const base = Array.isArray(archiveCharacters) ? archiveCharacters.slice(0, n) : [];
  if (base.length >= n) return base;
  const needed = n - base.length;
  for (let i = 0; i < needed; i++) {
    const tpl = NPC_SHELLS[i % NPC_SHELLS.length];
    // Disambiguate with arabic numerals if we wrap.
    const suffix = i >= NPC_SHELLS.length ? ` ${i + 1}` : '';
    base.push({
      name: tpl.name + suffix,
      role: tpl.role,
      suspicious_detail: tpl.suspicious_detail,
    });
  }
  return base;
}

/**
 * Decode a Base64 archive emitted by routes/scenarios.js.
 * Returns the parsed object or null on failure. Never throws.
 */
function safelyDecodeArchive(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  try {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && Array.isArray(obj.characters) && Array.isArray(obj.clues)) {
      return obj;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Build an objective string for a hidden role.
 */
function objectiveFor(gameRole) {
  switch (gameRole) {
    case 'mafiozo':
      return 'أنت المافيوزو. مهمتك إنك تضلل التحقيق وتنجو من التصويت.';
    case 'obvious_suspect':
      return 'أنت المشتبه الواضح. شكلك مريب جدًا، لكن الحقيقة إنك بريء. دافع عن نفسك.';
    case 'innocent':
    default:
      return 'أنت بريء. مهمتك إنك تراقب التناقضات وتكشف المافيوزو.';
  }
}

function roleLabelArabic(gameRole) {
  switch (gameRole) {
    case 'mafiozo':         return 'المافيوزو';
    case 'obvious_suspect': return 'المشتبه الواضح';
    case 'innocent':        return 'بريء';
    default:                return null;
  }
}

// ---------------------------------------------------------------------------
// ID normalization helpers.
//
// users.id in Postgres is SERIAL → JS Number on the wire. lobby.players is
// a Map keyed by that Number. But ANY object that uses an id as a key
// (votes{}, tally{}, roleAssignments{}) coerces the key to a String — and
// Object.entries() / Object.keys() always returns String keys. That means
// `eliminatedId = topTargets[0]` (from Object.entries(tally)) is a String,
// and `lobby.players.get("42")` on a Number-keyed Map returns undefined.
//
// These helpers do not assume a single canonical type — they try the raw
// value, the Number form, and the String form, in that order. Use them
// anywhere a Map.get(id) is reading an id that came through an object key.
// ---------------------------------------------------------------------------
function getPlayerById(lobby, id) {
  if (!lobby || id === undefined || id === null) return null;
  if (lobby.players.has(id)) return lobby.players.get(id);
  const asNum = Number(id);
  if (Number.isFinite(asNum) && lobby.players.has(asNum)) return lobby.players.get(asNum);
  const asStr = String(id);
  if (lobby.players.has(asStr)) return lobby.players.get(asStr);
  return null;
}

function getRoleAssignment(lobby, id) {
  const ra = lobby && lobby.gameData && lobby.gameData.roleAssignments;
  if (!ra || id === undefined || id === null) return null;
  // Object keys are always String, so `ra[42]` and `ra["42"]` index the same
  // slot — but be explicit so the intent is obvious to future readers.
  return ra[id] || ra[String(id)] || ra[Number(id)] || null;
}

function sameId(a, b) {
  if (a === b) return true;
  if (a === undefined || a === null || b === undefined || b === null) return false;
  return String(a) === String(b);
}

class GameManager {
  constructor(io, db) {
    this.io = io;
    this.db = db;
    this.lobbies = new Map();
    this.userSocketMap = new Map();

    this.io.on('connection', (socket) => {
      console.log('Client connected:', socket.id);

      socket.on('disconnect', () => {
        this.handleDisconnect(socket);
      });

      socket.on('authenticate', (data) => {
        const { user } = data || {};
        if (user && user.id) {
          this.userSocketMap.set(user.id, socket.id);
          socket.userId = user.id;
          socket.username = user.username;
        }
      });

      socket.on('create_room', (data, callback) => {
        const safeCb = typeof callback === 'function' ? callback : () => {};
        if (!socket.userId || !socket.username) {
          return safeCb({ success: false, message: 'لازم تسجّل دخولك قبل ما تفتح غرفة.' });
        }
        const roomId = this.generateRoomId();
        const mode = (data && data.mode) === 'AI' ? 'AI' : 'HUMAN';
        const requestedReveal = (data && data.roleRevealMode || '').toLowerCase();
        const roleRevealMode = VALID_REVEAL_MODES.has(requestedReveal) ? requestedReveal : 'normal';

        this.lobbies.set(roomId, {
          id: roomId,
          creatorId: socket.userId,
          hostId: mode === 'HUMAN' ? socket.userId : 'AI_HOST',
          mode,
          roleRevealMode,
          players: new Map(),
          state: 'LOBBY',
          gameData: null,
        });

        this.joinRoom(socket, roomId, mode === 'HUMAN');
        safeCb({ success: true, roomId });
      });

      socket.on('join_room', (data, callback) => {
        const safeCb = typeof callback === 'function' ? callback : () => {};
        const { roomId } = data || {};
        if (!socket.userId || !socket.username) {
          return safeCb({ success: false, message: 'لازم تسجّل دخولك قبل ما تنضم للغرفة.' });
        }
        if (!roomId || !this.lobbies.has(roomId)) {
          return safeCb({ success: false, message: 'الغرفة غير موجودة' });
        }
        const isHost = this.lobbies.get(roomId).hostId === socket.userId;
        this.joinRoom(socket, roomId, isHost);
        safeCb({ success: true, roomId });
      });

      socket.on('get_game_state', (data) => {
        const { roomId } = data || {};
        if (!roomId) return;
        socket.currentRoom = roomId;
        const lobby = this.lobbies.get(roomId);
        if (lobby) {
          socket.emit('full_state_update', this.buildPublicState(roomId));
          // If we're past role assignment, also re-send the player's private
          // card so a refreshed tab gets it back.
          this.resendPrivateRoleCardTo(socket, lobby);
        }
      });

      socket.on('start_game_setup', (data) => {
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (lobby && this.isAuthorizedHost(socket, lobby)) {
          // Broadcast to OTHER sockets in the room. The sender (host) is
          // already navigating manually — to /host-dashboard for HUMAN mode
          // (where they craft the archive) or to /game/<roomId> for AI mode
          // (where they finalized seconds ago). If we echoed `game_started`
          // back to the host, the LobbyPage listener would race the manual
          // navigate() and bounce a HUMAN host away from /host-dashboard
          // before they can write the archive — visible only on localhost
          // because the round-trip is sub-millisecond there.
          socket.to(roomId).emit('game_started', { id: roomId });
        }
      });

      socket.on('finalize_archive', (data, ack) => {
        const safeAck = typeof ack === 'function' ? ack : () => {};
        const { archive, raw, clues, roomId: bodyRoomId } = data || {};
        const roomId = bodyRoomId || socket.currentRoom;

        if (!roomId) {
          return safeAck({ success: false, error: 'الغرفة غير محددة. ابدأ من الساحة من جديد.' });
        }
        const lobby = this.lobbies.get(roomId);
        if (!lobby) {
          return safeAck({ success: false, error: 'الغرفة مش موجودة. ممكن تكون اتقفلت.' });
        }
        if (!this.isAuthorizedHost(socket, lobby)) {
          return safeAck({ success: false, error: 'مش مسموح لك تختم الأرشيف للغرفة دي.' });
        }
        if (!archive || !raw) {
          return safeAck({ success: false, error: 'الأرشيف ناقص. ولّد السيناريو الأول.' });
        }

        // Decode the archive so we can extract characters for role assignment.
        const decoded = safelyDecodeArchive(archive);
        if (!decoded) {
          return safeAck({ success: false, error: 'الأرشيف مش مفهوم. ولّده تاني.' });
        }

        const eligible = [...lobby.players.values()].filter(p => p && p.id && p.username && !p.isHost);
        if (eligible.length < 1) {
          return safeAck({ success: false, error: 'محتاج لاعب واحد على الأقل عشان توزع الأدوار.' });
        }

        const { roleAssignments, publicCharacterCards } = this.assignRoles(eligible, decoded);

        lobby.state = 'IN_GAME';
        lobby.gameData = {
          archiveBase64: archive,
          rawScenario: raw,
          decodedArchive: decoded,                  // server-only
          clues: Array.isArray(clues) && clues.length === 3
            ? clues
            : (Array.isArray(decoded.clues) && decoded.clues.length === 3 ? decoded.clues : ['دليل 1...', 'دليل 2...', 'دليل 3...']),
          clueIndex: 0,
          phase: 'ROLE_REVEAL',
          timer: 30,
          interval: null,
          isPaused: false,
          votes: {},
          roleRevealMode: lobby.roleRevealMode,
          roleAssignments,                          // server-only — NEVER broadcast
          publicCharacterCards,                     // safe to broadcast
          votingHistory: [],                        // [{ round, votes, eliminatedId, wasMafiozo, reason }]
          eliminatedIds: [],                        // ordered list of eliminated player ids
          outcome: null,                            // 'investigators_win' | 'mafiozo_survives' | null
          lastVoteResult: null,                     // last computed vote_result payload (for refresh)
        };

        socket.currentRoom = roomId;

        // Send each player their PRIVATE role card individually.
        for (const card of Object.values(roleAssignments)) {
          const player = lobby.players.get(card.playerId);
          if (!player || !player.socketId) continue;
          this.io.to(player.socketId).emit('your_role_card', this.buildPrivateRoleCard(lobby, card));
        }

        // Public broadcast — sanitised.
        this.broadcastFullState(roomId);
        this.startRoomTimer(roomId);

        return safeAck({ success: true, roomId, phase: 'ROLE_REVEAL', roleRevealMode: lobby.roleRevealMode });
      });

      // Player can re-request their private card after a refresh.
      socket.on('request_role_card', (data) => {
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby) return;
        this.resendPrivateRoleCardTo(socket, lobby);
      });

      socket.on('submit_vote', (data) => {
        const { roomId, targetId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby || !lobby.gameData) return;
        if (lobby.gameData.phase !== 'VOTING') return;

        const voter = getPlayerById(lobby, socket.userId);
        if (!voter) return;

        // --- voter eligibility (server-enforced; UI hides controls but cannot be trusted)
        // Hosts NEVER vote. Eliminated players DO vote (jury rule) — they
        // just can't be targeted anymore (handled below).
        if (voter.isHost) {
          return socket.emit('vote_rejected', { reason: 'host_cannot_vote', message: 'المضيف ما بيصوّتش.' });
        }

        // --- target validation + canonical-id resolution
        // We store the live player's `id` (matching the Map key type) rather
        // than the raw client-provided value so the closeVoting tally can
        // round-trip it back into a Map.get() without a type mismatch.
        let canonicalTarget;
        if (targetId === 'skip') {
          canonicalTarget = 'skip';
        } else {
          const target = getPlayerById(lobby, targetId);
          if (!target) {
            return socket.emit('vote_rejected', { reason: 'unknown_target', message: 'اللاعب اللي اخترته مش موجود.' });
          }
          if (target.isHost) {
            return socket.emit('vote_rejected', { reason: 'cannot_vote_host', message: 'مش ممكن تصوّت على المضيف.' });
          }
          if (!target.isAlive) {
            return socket.emit('vote_rejected', { reason: 'target_eliminated', message: 'الشخص ده خرج من اللعبة بالفعل.' });
          }
          canonicalTarget = target.id;
        }

        // Vote change is allowed before close — just overwrite.
        lobby.gameData.votes[voter.id] = canonicalTarget;
        socket.emit('vote_registered', { userId: voter.id, targetId: canonicalTarget });
        this.emitVotingProgress(roomId);

        // Early close: if every voting PARTICIPANT (alive or eliminated)
        // has cast a vote, end immediately. Eliminated jurors count too.
        const participants = this.getVotingParticipants(lobby);
        const votedCount = participants.filter(p => lobby.gameData.votes[p.id] !== undefined).length;
        if (participants.length > 0 && votedCount >= participants.length) {
          this.closeVoting(roomId, 'all_voted');
        }
      });

      // Host-controlled phase actions. Named, phase-aware, and ALWAYS gated
      // server-side. Old clients that emit without an ack still work; the new
      // frontend uses the ack to surface success / Arabic error.
      socket.on('host_control', (data, ack) => {
        const safeAck = typeof ack === 'function' ? ack : () => {};
        const { action, roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby) {
          return safeAck({ success: false, error: 'الغرفة مش موجودة.' });
        }
        if (!this.isAuthorizedHost(socket, lobby)) {
          // Tell THIS client only — don't broadcast the rejection.
          socket.emit('host_action_rejected', {
            action,
            reason: 'not_host',
            message: 'مش مسموح بالعملية دي إلا للمضيف.',
          });
          return safeAck({ success: false, error: 'مش مسموح بالعملية دي إلا للمضيف.' });
        }

        // `end_session` doesn't need active gameData.
        if (action === 'end_session') {
          this.stopRoomTimer(lobby);
          this.io.to(roomId).emit('session_ended', { reason: 'host_ended' });
          this.lobbies.delete(roomId);
          return safeAck({ success: true });
        }

        if (!lobby.gameData) {
          return safeAck({ success: false, error: 'اللعبة لسه ما بدتش.' });
        }
        const phase = lobby.gameData.phase;

        switch (action) {
          // -- timer-only actions, valid in any active phase ----------------
          case 'pause':
            lobby.gameData.isPaused = true;
            this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
            return safeAck({ success: true, phase });

          case 'resume':
            lobby.gameData.isPaused = false;
            this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
            return safeAck({ success: true, phase });

          case 'extend_timer':
          case 'extend': // legacy alias
            lobby.gameData.timer += 30;
            this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
            return safeAck({ success: true, phase });

          // -- phase advancement actions, each phase-checked ----------------
          case 'start_first_clue':
            if (phase === 'ROLE_REVEAL' || phase === 'PUBLIC_CHARACTER_OVERVIEW') {
              this.stopRoomTimer(lobby);
              this.enterPhase(lobby, 'CLUE_REVEAL', 45);
              this.startRoomTimer(roomId);
              return safeAck({ success: true, phase: 'CLUE_REVEAL' });
            }
            return safeAck({ success: false, error: 'ما ينفعش تبدأ الدليل دلوقتي.' });

          case 'skip_public_overview':
            if (phase === 'PUBLIC_CHARACTER_OVERVIEW') {
              this.stopRoomTimer(lobby);
              this.enterPhase(lobby, 'CLUE_REVEAL', 45);
              this.startRoomTimer(roomId);
              return safeAck({ success: true, phase: 'CLUE_REVEAL' });
            }
            return safeAck({ success: false, error: 'مش في طور الاستعراض دلوقتي.' });

          case 'start_voting_now':
          case 'end_discussion_now':
            if (phase === 'CLUE_REVEAL') {
              this.stopRoomTimer(lobby);
              this.enterPhase(lobby, 'VOTING', 30);
              this.startRoomTimer(roomId);
              return safeAck({ success: true, phase: 'VOTING' });
            }
            return safeAck({ success: false, error: 'مش في طور المناقشة دلوقتي.' });

          case 'close_voting_now':
            if (phase === 'VOTING') {
              this.closeVoting(roomId, 'host');
              return safeAck({ success: true });
            }
            return safeAck({ success: false, error: 'مفيش تصويت مفتوح حاليًا.' });

          case 'continue_next_round':
          case 'reveal_next_clue': {
            if (phase !== 'VOTE_RESULT' || lobby.gameData.outcome) {
              return safeAck({ success: false, error: 'مش الوقت المناسب لتقديم دليل جديد.' });
            }
            this.stopRoomTimer(lobby);
            lobby.gameData.clueIndex += 1;
            if (lobby.gameData.clueIndex >= lobby.gameData.clues.length) {
              // Should normally have been ended by closeVoting; safety net.
              lobby.gameData.outcome = lobby.gameData.outcome || 'mafiozo_survives';
              this.enterPhase(lobby, 'FINAL_REVEAL', 0);
              return safeAck({ success: true, phase: 'FINAL_REVEAL' });
            }
            this.enterPhase(lobby, 'CLUE_REVEAL', 45);
            this.startRoomTimer(roomId);
            return safeAck({ success: true, phase: 'CLUE_REVEAL' });
          }

          case 'trigger_final_reveal': {
            if (phase === 'FINAL_REVEAL') {
              return safeAck({ success: false, error: 'الكشف النهائي شغّال بالفعل.' });
            }
            // Decide outcome from current state. If mafiozo was eliminated,
            // investigators win. Otherwise, mafiozo survives.
            const mafiozoRec = Object.values(lobby.gameData.roleAssignments || {})
              .find(r => r.gameRole === 'mafiozo');
            lobby.gameData.outcome = (mafiozoRec && !mafiozoRec.isAlive)
              ? 'investigators_win'
              : 'mafiozo_survives';
            this.stopRoomTimer(lobby);
            this.enterPhase(lobby, 'FINAL_REVEAL', 0);
            return safeAck({ success: true, phase: 'FINAL_REVEAL' });
          }

          // -- legacy aliases kept so old clients keep working --------------
          case 'skip':
            // Old "skip" used to zero the timer. Map to safe phase advance
            // depending on current phase.
            if (phase === 'CLUE_REVEAL') {
              this.stopRoomTimer(lobby);
              this.enterPhase(lobby, 'VOTING', 30);
              this.startRoomTimer(roomId);
              return safeAck({ success: true, phase: 'VOTING' });
            }
            if (phase === 'VOTING') {
              this.closeVoting(roomId, 'host');
              return safeAck({ success: true });
            }
            // Fall through: treat as a small timer nudge.
            lobby.gameData.timer = Math.max(0, lobby.gameData.timer - 5);
            this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
            return safeAck({ success: true, phase });

          default:
            return safeAck({ success: false, error: 'العملية مش معروفة.' });
        }
      });

      // Player-driven readiness during CLUE_REVEAL. When ALL voting
      // participants (non-host, alive OR eliminated) press "ready", the
      // discussion ends early and the round transitions to VOTING. Host is
      // excluded — host can still force start_voting_now via host_control.
      socket.on('ready_to_vote', (data) => {
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby || !lobby.gameData) return;
        if (lobby.gameData.phase !== 'CLUE_REVEAL') {
          return socket.emit('ready_to_vote_rejected', {
            reason: 'wrong_phase',
            message: 'لا يمكنك إعلان الاستعداد للتصويت الآن.',
          });
        }
        const player = getPlayerById(lobby, socket.userId);
        // Eliminated jurors CAN ready up — only host and unknown sockets are blocked.
        if (!player || player.isHost) {
          return socket.emit('ready_to_vote_rejected', {
            reason: 'not_eligible',
            message: 'لا يمكنك إعلان الاستعداد للتصويت الآن.',
          });
        }
        if (!lobby.gameData.readyToVote) lobby.gameData.readyToVote = {};
        lobby.gameData.readyToVote[player.id] = true;

        const participants = this.getVotingParticipants(lobby);
        const ready = participants.filter(p => lobby.gameData.readyToVote[p.id]).length;
        this.io.to(roomId).emit('ready_to_vote_progress', { ready, total: participants.length });

        if (participants.length > 0 && ready >= participants.length) {
          this.stopRoomTimer(lobby);
          this.enterPhase(lobby, 'VOTING', 30);
          this.startRoomTimer(roomId);
        }
      });

      // Player-driven extension during VOTING. When >= ceil(70%) of voting
      // participants (non-host, alive OR eliminated) request more time, the
      // timer gains exactly 15s. Limited to ONE successful extension per
      // VOTING round (voteExtensionUsed flag).
      socket.on('request_vote_extension', (data) => {
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby || !lobby.gameData) return;
        if (lobby.gameData.phase !== 'VOTING') {
          return socket.emit('vote_extension_rejected', {
            reason: 'wrong_phase',
            message: 'تمديد التصويت متاح فقط أثناء التصويت.',
          });
        }
        if (lobby.gameData.voteExtensionUsed) {
          return socket.emit('vote_extension_rejected', {
            reason: 'used',
            message: 'تم استخدام التمديد لهذه الجولة.',
          });
        }
        const player = getPlayerById(lobby, socket.userId);
        // Eliminated jurors CAN request — only host and unknown sockets blocked.
        if (!player || player.isHost) {
          return socket.emit('vote_extension_rejected', {
            reason: 'not_eligible',
            message: 'مش مسموح لك تطلب تمديد التصويت.',
          });
        }
        if (!lobby.gameData.voteExtensionRequests) lobby.gameData.voteExtensionRequests = {};
        if (lobby.gameData.voteExtensionRequests[player.id]) {
          return socket.emit('vote_extension_rejected', {
            reason: 'already_requested',
            message: 'طلبك متسجّل بالفعل.',
          });
        }
        lobby.gameData.voteExtensionRequests[player.id] = true;

        const participants = this.getVotingParticipants(lobby);
        const requested = participants.filter(p => lobby.gameData.voteExtensionRequests[p.id]).length;
        const required = Math.max(1, Math.ceil(participants.length * 0.7));

        let activated = false;
        let secondsAdded = 0;
        if (requested >= required) {
          lobby.gameData.timer += 15;
          lobby.gameData.voteExtensionUsed = true;
          activated = true;
          secondsAdded = 15;
          this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
        }
        this.io.to(roomId).emit('vote_extension_progress', {
          requested,
          total: participants.length,
          required,
          activated,
          secondsAdded,
        });
      });

      // Legacy `force_phase` is kept for backwards-compat with deployed clients
      // but routes through the same named-action handler so the safety rules
      // (auth, phase validity, timer cleanup, no double transitions) all apply.
      socket.on('force_phase', (data) => {
        const { phase, roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby || !this.isAuthorizedHost(socket, lobby) || !lobby.gameData) return;
        const cur = lobby.gameData.phase;
        // Map legacy intent to a safe named action.
        if (phase === 'VOTING' && cur === 'CLUE_REVEAL') {
          this.stopRoomTimer(lobby);
          this.enterPhase(lobby, 'VOTING', 30);
          this.startRoomTimer(roomId);
          return;
        }
        if (phase === 'CLUE_REVEAL' && cur === 'VOTE_RESULT' && !lobby.gameData.outcome) {
          this.stopRoomTimer(lobby);
          lobby.gameData.clueIndex += 1;
          if (lobby.gameData.clueIndex >= lobby.gameData.clues.length) {
            lobby.gameData.outcome = lobby.gameData.outcome || 'mafiozo_survives';
            this.enterPhase(lobby, 'FINAL_REVEAL', 0);
          } else {
            this.enterPhase(lobby, 'CLUE_REVEAL', 45);
            this.startRoomTimer(roomId);
          }
          return;
        }
        // Anything else: ignore. We refuse to allow arbitrary phase jumps now.
      });
    });
  }

  // -------------------------------------------------------------------------
  // Authorization
  // -------------------------------------------------------------------------

  /**
   * Both HUMAN-mode hosts and AI-mode creators count as authorized hosts.
   * Fixes the long-standing AI-mode "headless host" bug.
   */
  isAuthorizedHost(socket, lobby) {
    if (!lobby || !socket.userId) return false;
    if (lobby.hostId === socket.userId) return true;
    if (lobby.mode === 'AI' && lobby.creatorId === socket.userId) return true;
    return false;
  }

  // -------------------------------------------------------------------------
  // Role assignment
  // -------------------------------------------------------------------------

  /**
   * Deterministically assigns story characters AND hidden game roles.
   * Story characters and game roles are shuffled INDEPENDENTLY, so the
   * archive's narrative mafiozo isn't deterministically the real mafiozo.
   *
   * @param {Array} eligiblePlayers - non-host alive players
   * @param {Object} archive        - decoded archive {characters, mafiozo, ...}
   * @returns {{ roleAssignments: object, publicCharacterCards: array }}
   */
  assignRoles(eligiblePlayers, archive) {
    const N = eligiblePlayers.length;
    const characters = padCharactersToCount(archive.characters, N);

    // Independent shuffles so character != game role mapping.
    const shuffledChars = secureShuffle(characters).slice(0, N);
    const shuffledPlayers = secureShuffle(eligiblePlayers);

    // Hidden-role allocation:
    //   index 0 → mafiozo
    //   index 1 → obvious_suspect (only if N >= 4)
    //   rest    → innocent
    const gameRoleByIndex = new Array(N).fill('innocent');
    gameRoleByIndex[0] = 'mafiozo';
    if (N >= 4) gameRoleByIndex[1] = 'obvious_suspect';

    const roleAssignments = {};
    const publicCharacterCards = [];

    shuffledPlayers.forEach((player, i) => {
      const ch = shuffledChars[i];
      const gameRole = gameRoleByIndex[i];

      // Mark the live player record with the role so future commits
      // (voting, final reveal) can read from one place.
      player.role = gameRole;
      player.storyCharacterName = ch.name;

      roleAssignments[player.id] = {
        playerId: player.id,
        username: player.username,
        gameRole,                              // server-only
        storyCharacterName: ch.name,
        storyCharacterRole: ch.role,
        suspiciousDetail: ch.suspicious_detail,
        isAlive: true,
      };

      publicCharacterCards.push({
        playerId: player.id,
        username: player.username,
        storyCharacterName: ch.name,
        storyCharacterRole: ch.role,
        suspiciousDetail: ch.suspicious_detail,
      });
    });

    if (process.env.NODE_ENV !== 'production') {
      console.log(`[role] assigned ${N} cards (mode=${archive.title ? 'archive' : 'unknown'})`);
    }

    return { roleAssignments, publicCharacterCards };
  }

  /**
   * Build the private role-card payload for a single player.
   * In BLIND mode the gameRole / roleLabelArabic / objective are intentionally
   * stripped — even the field names are absent on the wire.
   */
  buildPrivateRoleCard(lobby, assignment) {
    const mode = lobby.roleRevealMode || 'normal';
    const base = {
      mode,
      playerId: assignment.playerId,
      username: assignment.username,
      storyCharacterName: assignment.storyCharacterName,
      storyCharacterRole: assignment.storyCharacterRole,
      suspiciousDetail: assignment.suspiciousDetail,
      warning: 'ممنوع تكشف بطاقتك للاعبين التانيين.',
    };
    if (mode === 'blind') {
      return {
        ...base,
        objective: 'راقب، اسأل، ودافع عن نفسك. الحقيقة مش كاملة عند حد.',
        warning: 'في طور عمياني، أنت لا تعرف حقيقتك الكاملة.',
      };
    }
    // Normal mode includes hidden-role fields.
    return {
      ...base,
      gameRole: assignment.gameRole,
      roleLabelArabic: roleLabelArabic(assignment.gameRole),
      objective: objectiveFor(assignment.gameRole),
      canRevealRoleToOthers: false,
    };
  }

  /**
   * If a player refreshes/reconnects after role assignment, re-send their card.
   */
  resendPrivateRoleCardTo(socket, lobby) {
    if (!lobby || !lobby.gameData || !lobby.gameData.roleAssignments) return;
    const assignment = lobby.gameData.roleAssignments[socket.userId];
    if (!assignment) return;
    socket.emit('your_role_card', this.buildPrivateRoleCard(lobby, assignment));
  }

  // -------------------------------------------------------------------------
  // Timer / phase machine
  // -------------------------------------------------------------------------

  startRoomTimer(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby || !lobby.gameData) return;
    if (lobby.gameData.interval) clearInterval(lobby.gameData.interval);

    lobby.gameData.interval = setInterval(() => {
      if (!lobby.gameData.isPaused) {
        lobby.gameData.timer -= 1;
        this.io.to(roomId).emit('timer_update', Math.max(0, lobby.gameData.timer));

        if (lobby.gameData.timer <= 0) {
          this.handlePhaseEnd(roomId);
        }
      }
    }, 1000);
  }

  /**
   * Stop the per-second timer cleanly. Used when voting closes early or the
   * game ends. Idempotent.
   */
  stopRoomTimer(lobby) {
    if (lobby && lobby.gameData && lobby.gameData.interval) {
      clearInterval(lobby.gameData.interval);
      lobby.gameData.interval = null;
    }
  }

  /**
   * Set the next phase + duration in one place. Always broadcasts.
   * If a fresh timer is needed, the caller restarts it via startRoomTimer.
   */
  enterPhase(lobby, phase, durationSeconds) {
    if (!lobby || !lobby.gameData) return;
    lobby.gameData.phase = phase;
    lobby.gameData.timer = durationSeconds;
    if (phase === 'CLUE_REVEAL') {
      // Per-round readiness reset. Broadcast a zeroed progress so any client
      // that missed the previous reset shows the correct count. Total counts
      // ALL voting participants (eliminated jurors included).
      lobby.gameData.readyToVote = {};
      const participantCount = this.getVotingParticipants(lobby).length;
      this.broadcastFullState(lobby.id);
      this.io.to(lobby.id).emit('ready_to_vote_progress', { ready: 0, total: participantCount });
      // C2: optional AI clue-transition flavor. Fired only on rounds 2+
      // (the first CLUE_REVEAL has no previous result to bridge from).
      if (lobby.gameData.clueIndex > 0) {
        this._polishClueTransition(lobby);
      }
      return;
    }
    if (phase === 'VOTING') {
      // Always start a voting round CLEAN — votes reset, extension reset,
      // fresh progress emit. Total counts ALL voting participants
      // (eliminated jurors included).
      lobby.gameData.votes = {};
      lobby.gameData.voteExtensionRequests = {};
      lobby.gameData.voteExtensionUsed = false;
      this.broadcastFullState(lobby.id);
      this.emitVotingProgress(lobby.id);
      const participantCount = this.getVotingParticipants(lobby).length;
      this.io.to(lobby.id).emit('vote_extension_progress', {
        requested: 0,
        total: participantCount,
        required: Math.max(1, Math.ceil(participantCount * 0.7)),
        activated: false,
        secondsAdded: 0,
      });
      return;
    }
    if (phase === 'FINAL_REVEAL') {
      // Build the cinematic reveal once, deterministically, from session data.
      // Stored on gameData so reconnecting clients can recover it.
      try {
        if (!lobby.gameData.finalReveal) {
          lobby.gameData.finalReveal = this.buildFinalReveal(lobby);
        }
      } catch (err) {
        console.error('[reveal] buildFinalReveal failed:', err && err.message);
        lobby.gameData.finalReveal = this.buildSafeMinimalReveal(lobby);
      }
      this.broadcastFullState(lobby.id);
      // C3: optional AI polish — fire and forget. Deterministic reveal
      // already shipped; this only attaches optional flavor fields when
      // the AI returns and the lobby is still in FINAL_REVEAL.
      this._polishFinalReveal(lobby);
      return;
    }
    this.broadcastFullState(lobby.id);
  }

  /**
   * Voting PARTICIPANTS: every real non-host player, alive OR eliminated.
   * Used for early-close totals, ready-to-vote totals, vote-extension
   * threshold, and the voted/eligible count in vote_result. Eliminated
   * players remain jury-style voters so a small alive pool can't get stuck.
   */
  getVotingParticipants(lobby) {
    if (!lobby) return [];
    return [...lobby.players.values()].filter(p => p && p.id && p.username && !p.isHost);
  }

  /**
   * Vote TARGETS: real non-host ALIVE players. Used for candidate validation
   * in submit_vote. Eliminated players can no longer be targeted.
   */
  getVoteTargets(lobby) {
    if (!lobby) return [];
    return [...lobby.players.values()].filter(p => p && p.id && p.username && !p.isHost && p.isAlive);
  }

  /**
   * Strict per-id check: does this id resolve to a non-host alive player?
   */
  isValidVoteTarget(lobby, targetId) {
    const target = getPlayerById(lobby, targetId);
    return !!(target && !target.isHost && target.isAlive);
  }

  /**
   * Emit lightweight voting progress: { voted, total }. No identities.
   */
  emitVotingProgress(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby || !lobby.gameData) return;
    const participants = this.getVotingParticipants(lobby);
    const votes = lobby.gameData.votes || {};
    const voted = participants.filter(p => votes[p.id] !== undefined).length;
    this.io.to(roomId).emit('voting_progress', { voted, total: participants.length });
  }

  /**
   * Tally votes from the current VOTING round, decide elimination,
   * push to votingHistory, then transition to VOTE_RESULT.
   *
   * @param {string} roomId
   * @param {'all_voted'|'timer'} reason
   */
  closeVoting(roomId, reason = 'timer') {
    const lobby = this.lobbies.get(roomId);
    if (!lobby || !lobby.gameData) return;
    if (lobby.gameData.phase !== 'VOTING') return; // already closed

    this.stopRoomTimer(lobby);

    const participants = this.getVotingParticipants(lobby);
    const votes = lobby.gameData.votes || {};

    // Tally — count votes from every voting participant (alive OR eliminated
    // jurors). A vote whose target is no longer a valid candidate (host or
    // eliminated by an earlier round) is silently dropped, NOT applied,
    // because eliminated players cannot be re-targeted.
    const tally = {}; // targetId → count
    for (const v of participants) {
      const t = votes[v.id];
      if (t === undefined) continue; // didn't vote
      if (t !== 'skip' && !this.isValidVoteTarget(lobby, t)) continue; // stale target
      tally[t] = (tally[t] || 0) + 1;
    }

    // Determine outcome.
    let eliminatedId = null;
    let outcomeReason = 'tie';      // 'majority' | 'tie' | 'no-vote' | 'all-skip'
    let wasMafiozo = false;

    const totalVotesCast = Object.values(tally).reduce((a, b) => a + b, 0);
    if (totalVotesCast === 0) {
      outcomeReason = 'no-vote';
    } else {
      // Exclude 'skip' from elimination candidates.
      const playerEntries = Object.entries(tally).filter(([k]) => k !== 'skip');
      if (playerEntries.length === 0) {
        outcomeReason = 'all-skip';
      } else {
        const max = Math.max(...playerEntries.map(([, c]) => c));
        const topTargets = playerEntries.filter(([, c]) => c === max).map(([k]) => k);
        if (topTargets.length === 1) {
          // CRITICAL: Object.entries() returns String keys, but lobby.players
          // is a Map keyed by Number (the SERIAL user id). Resolve via the
          // helper, then capture the live player's CANONICAL id for every
          // downstream read so Map.get and roleAssignments[id] never miss.
          const rawTopId = topTargets[0];
          const elim = getPlayerById(lobby, rawTopId);
          if (elim && !elim.isHost && elim.isAlive) {
            eliminatedId = elim.id;             // canonical, matches Map key
            outcomeReason = 'majority';
            elim.isAlive = false;
            const roleRec = getRoleAssignment(lobby, eliminatedId);
            if (roleRec) roleRec.isAlive = false;
            wasMafiozo = !!(roleRec && roleRec.gameRole === 'mafiozo');
            lobby.gameData.eliminatedIds.push(eliminatedId);
          } else {
            // Top-voted id doesn't resolve to a valid candidate (gone, host,
            // already eliminated) — treat as no elimination rather than
            // half-write inconsistent state. Should be unreachable thanks to
            // the stale-target filter above.
            outcomeReason = 'no-vote';
          }
        } else {
          outcomeReason = 'tie';
        }
      }
    }

    // Resolve eliminated username with a stable fallback. The live record
    // and role assignment are both keyed off the canonical id we just
    // captured, so this is now an unconditional success when eliminatedId
    // is set — but keep the fallback chain for safety on future paths.
    const resolvedElimUsername = eliminatedId
      ? (getPlayerById(lobby, eliminatedId)?.username
         || getRoleAssignment(lobby, eliminatedId)?.username
         || null)
      : null;

    // Push to history — used by Commit 4's final reveal.
    const round = (lobby.gameData.clueIndex || 0) + 1;
    lobby.gameData.votingHistory.push({
      round,
      votes: { ...votes },          // shallow copy of {voterId: targetId}
      tally: { ...tally },
      eliminatedId,
      eliminatedUsername: resolvedElimUsername,
      wasMafiozo,
      reason: outcomeReason,
      closedBy: reason,
    });

    // Build the broadcast-safe vote_result payload. NEVER includes mafiozo
    // identity beyond the boolean wasMafiozo on the eliminated player.
    const voteResult = {
      round,
      eliminatedId,
      eliminatedUsername: resolvedElimUsername,
      wasMafiozo,
      reason: outcomeReason,
      tally: { ...tally },
      eligibleCount: participants.length,
      votedCount: participants.filter(p => votes[p.id] !== undefined).length,
    };
    lobby.gameData.lastVoteResult = voteResult;

    this.io.to(roomId).emit('vote_result', voteResult);

    // C2: optional AI polish — fire and forget. The deterministic vote_result
    // already shipped above; this only adds an optional 'vote_result_flavor'
    // event that the frontend renders if/when it arrives.
    this._polishVoteResult(lobby, voteResult);

    // Decide what comes next.
    const lastClueReached = lobby.gameData.clueIndex >= lobby.gameData.clues.length - 1;
    if (wasMafiozo) {
      // Investigators win — reveal screen handles the cinematic ending.
      lobby.gameData.outcome = 'investigators_win';
      this.enterPhase(lobby, 'VOTE_RESULT', 8);
      this.startRoomTimer(roomId);
      return;
    }

    if (lastClueReached) {
      // Last round ended without catching the mafiozo → mafiozo survives.
      lobby.gameData.outcome = 'mafiozo_survives';
      this.enterPhase(lobby, 'VOTE_RESULT', 8);
      this.startRoomTimer(roomId);
      return;
    }

    // Game continues — show vote result briefly, then next clue.
    this.enterPhase(lobby, 'VOTE_RESULT', 8);
    this.startRoomTimer(roomId);
  }

  handlePhaseEnd(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby || !lobby.gameData) return;
    const cur = lobby.gameData.phase;

    if (cur === 'ROLE_REVEAL') {
      this.enterPhase(lobby, 'PUBLIC_CHARACTER_OVERVIEW', 10);
      return;
    }
    if (cur === 'PUBLIC_CHARACTER_OVERVIEW') {
      this.enterPhase(lobby, 'CLUE_REVEAL', 45);
      return;
    }
    if (cur === 'CLUE_REVEAL') {
      this.enterPhase(lobby, 'VOTING', 30);
      return;
    }
    if (cur === 'VOTING') {
      // Timer ran out. Close voting using current votes.
      this.closeVoting(roomId, 'timer');
      return;
    }
    if (cur === 'VOTE_RESULT') {
      // Decide where to go after the result screen.
      if (lobby.gameData.outcome) {
        // Game over — go to the cinematic reveal phase.
        // Commit 4 will fully render this; for now POST_GAME falls back to
        // the legacy single-line ending in the frontend.
        this.enterPhase(lobby, 'FINAL_REVEAL', 0);
        this.stopRoomTimer(lobby);
      } else {
        // Continue to next clue.
        lobby.gameData.clueIndex++;
        this.enterPhase(lobby, 'CLUE_REVEAL', 45);
      }
      return;
    }
    if (cur === 'FINAL_REVEAL' || cur === 'POST_GAME') {
      this.stopRoomTimer(lobby);
      return;
    }
  }

  // -------------------------------------------------------------------------
  // FINAL REVEAL — deterministic cinematic case conclusion
  //
  // Built once when the phase enters FINAL_REVEAL. Variable per session
  // because every helper consumes real session data (player names,
  // assignments, voting history, outcome, mode). No two games produce the
  // same prose, even when the archive is identical.
  // -------------------------------------------------------------------------

  /**
   * Top-level builder. Returns a fully-populated finalReveal payload OR a
   * safe minimal reveal if anything is missing.
   */
  buildFinalReveal(lobby) {
    const gd = lobby && lobby.gameData;
    if (!gd) return this.buildSafeMinimalReveal(lobby);

    const archive = gd.decodedArchive || {};
    const assignments = gd.roleAssignments || {};
    const votingHistory = gd.votingHistory || [];
    const allRecs = Object.values(assignments);

    const mafiozoRec = allRecs.find(r => r.gameRole === 'mafiozo') || null;
    const obviousRec = allRecs.find(r => r.gameRole === 'obvious_suspect') || null;
    const outcome = gd.outcome || 'unknown';
    const mode = gd.roleRevealMode || 'normal';

    const ctx = {
      archive, assignments, allRecs, votingHistory,
      mafiozoRec, obviousRec, outcome, mode,
      players: Array.from(lobby.players.values()),
    };

    return {
      title: archive.title || 'القضية المختومة',
      outcome,
      winnerLabel: this._winnerLabel(outcome),
      winnerTone:
        outcome === 'investigators_win' ? 'gold'
        : outcome === 'mafiozo_survives' ? 'red'
        : 'neutral',
      roleRevealMode: mode,
      headline: this._buildOutcomeHeadline(ctx),
      caseSummary: this._buildCaseSummary(ctx),
      truth: this._buildTruth(ctx),
      obviousSuspect: this._buildObviousSuspect(ctx),
      players: this._buildPlayerCards(ctx),
      clues: this._buildClueAnalyses(ctx),
      votingTimeline: this._buildVotingTimeline(ctx),
      dramaticBeats: this._buildDramaticBeats(ctx),
      finalParagraph: this._buildFinalParagraph(ctx),
      ctas: { newGame: 'ابدأ جلسة جديدة', backToLobby: 'ارجع للساحة' },
    };
  }

  buildSafeMinimalReveal(lobby) {
    const gd = lobby && lobby.gameData;
    return {
      title: gd?.decodedArchive?.title || 'القضية المختومة',
      outcome: gd?.outcome || 'unknown',
      winnerLabel: this._winnerLabel(gd?.outcome),
      winnerTone: 'neutral',
      roleRevealMode: gd?.roleRevealMode || 'normal',
      headline: { title: 'انتهت الجلسة', subtitle: 'الأرشيف اتفك على الحاضرين.' },
      caseSummary: { title: gd?.decodedArchive?.title || 'القضية', story: gd?.decodedArchive?.story || '', reconstruction: '', closingLine: 'الجلسة وقفت بدري.' },
      truth: null, obviousSuspect: null, players: [], clues: [], votingTimeline: [],
      dramaticBeats: [], finalParagraph: 'الجلسة وقفت قبل ما يكتمل المشهد.',
      ctas: { newGame: 'ابدأ جلسة جديدة', backToLobby: 'ارجع للساحة' },
    };
  }

  _winnerLabel(outcome) {
    if (outcome === 'investigators_win') return 'انتصر التحقيق';
    if (outcome === 'mafiozo_survives')  return 'المافيوزو نجا';
    return 'انتهت الجلسة';
  }

  _roleLabelArabic(role) {
    if (role === 'mafiozo')         return 'المافيوزو';
    if (role === 'obvious_suspect') return 'المشتبه الواضح';
    if (role === 'innocent')        return 'بريء';
    return null;
  }

  // ----- HEADLINE ----------------------------------------------------------
  _buildOutcomeHeadline(ctx) {
    const { outcome, votingHistory, mafiozoRec, obviousRec, mode } = ctx;
    const elimRound = mafiozoRec
      ? votingHistory.find(v => v.eliminatedId === mafiozoRec.playerId)?.round
      : null;

    if (outcome === 'investigators_win') {
      if (elimRound === 1) return {
        title: 'كشف مبكر — الحقيقة طلعت من الجولة الأولى',
        subtitle: 'الساحة قرأت الخيوط قبل ما تتلخبط، والمافيوزو ما لقاش وقت يدافع.',
      };
      if (elimRound === 2) return {
        title: 'لحظة الحسم — الجولة التانية فضحت الكبير',
        subtitle: 'الدليل الأول لخبط الصورة، لكن الدليل التاني فتح عين الساحة.',
      };
      if (elimRound === 3) return {
        title: 'في آخر لحظة — التحقيق لحق المافيوزو',
        subtitle: 'الانعطافة قلبت الموازين، والساحة قبضت في النهاية.',
      };
      return {
        title: 'كشف المافيوزو — قضية مغلقة',
        subtitle: 'الأرشيف اتفك. الحقيقة طلعت.',
      };
    }

    if (outcome === 'mafiozo_survives') {
      const obviousElim = obviousRec
        ? votingHistory.find(v => v.eliminatedId === obviousRec.playerId)
        : null;
      if (obviousElim) return {
        title: 'المافيوزو نجا — والمشتبه الواضح دفع التمن',
        subtitle: 'التضليل اشتغل بالظبط زي ما كان مخطط له. الساحة اختارت الواجهة، وفاتت اللي ورا.',
      };
      const mafiozoNeverTargeted = mafiozoRec
        && !votingHistory.some(v => v.tally && v.tally[mafiozoRec.playerId]);
      if (mafiozoNeverTargeted) return {
        title: 'اختفاء كامل — المافيوزو ما ظهرش في أي تصويت',
        subtitle: 'الساحة شافت كل حد إلا اللي قدامها. اللعبة كسبتها بالصمت.',
      };
      if (mode === 'blind') return {
        title: 'في طور عمياني، الحقيقة فضلت متدارية',
        subtitle: 'حتى صاحب السر ماكانش يعرف. الساحة كانت قريبة، لكن مفيش حد ماسك الخيط كامل.',
      };
      return {
        title: 'المافيوزو نجا — الحقيقة فضلت متدارية',
        subtitle: 'الساحة كانت قريبة، لكن الخيط الصح ما اتمسكش لحد الجرس الأخير.',
      };
    }

    return { title: 'انتهت الجلسة', subtitle: 'الأرشيف اتفك على الحاضرين.' };
  }

  // ----- CASE SUMMARY ------------------------------------------------------
  _buildCaseSummary(ctx) {
    return {
      title: ctx.archive.title || 'القضية المختومة',
      story: ctx.archive.story || '',
      reconstruction: this._buildReconstruction(ctx),
      closingLine: this._buildCaseClosingLine(ctx),
    };
  }

  _buildReconstruction(ctx) {
    const { mafiozoRec, obviousRec, outcome, archive } = ctx;
    if (!mafiozoRec) return archive.story || '';

    const charRef = `${mafiozoRec.storyCharacterName} (${mafiozoRec.storyCharacterRole})`;
    const playerRef = mafiozoRec.username;

    const p1 = `وراء كل تفصيلة في القضية كان فيه إيد واحدة بتحركها. ${playerRef} اللي كان بيلعب دور ${charRef} هو اللي رسم الموقف من البداية.`;

    let p2;
    if (obviousRec) {
      const obviousChar = `${obviousRec.storyCharacterName} (${obviousRec.storyCharacterRole})`;
      p2 = `أما ${obviousRec.username} اللي كان شخصيته ${obviousChar}، فالمكان والتوقيت خلاه يبان أكتر مشتبه فيه. كل تفصيلة عنه كانت بترسم ظله أكبر من الحقيقة.`;
    } else {
      p2 = `ما كانش فيه مشتبه واضح يلفت الانتباه عنه. ${playerRef} اضطر يخبي نفسه في تفاصيل صغيرة بدل ما يستخبى ورا واجهة.`;
    }

    let p3;
    if (outcome === 'investigators_win') {
      p3 = `بس الساحة كانت بتقرا الخيوط الصح في الوقت الصح. الكشف ما تأخرش.`;
    } else if (outcome === 'mafiozo_survives') {
      p3 = `الساحة شافت الواجهة، لكن الحقيقة فضلت متدارية تحت طبقة من الشك.`;
    } else {
      p3 = `الجلسة وقفت قبل ما يكتمل المشهد، لكن الأرشيف فضل ساكن.`;
    }

    return [p1, p2, p3].join('\n\n');
  }

  _buildCaseClosingLine(ctx) {
    if (ctx.outcome === 'investigators_win') return 'القضية مغلقة. الحق رجع لأصحابه.';
    if (ctx.outcome === 'mafiozo_survives')  return 'القضية فاضلة مفتوحة في الورق، لكن مقفولة في الأرشيف.';
    return 'انتهت الجلسة.';
  }

  // ----- TRUTH (mafiozo reveal) -------------------------------------------
  _buildTruth(ctx) {
    const { mafiozoRec, votingHistory, mode } = ctx;
    if (!mafiozoRec) return null;

    const elimRound = votingHistory.find(v => v.eliminatedId === mafiozoRec.playerId)?.round;
    let explanation;

    if (elimRound) {
      explanation = `${mafiozoRec.username} كان مخبي نفسه ورا شخصية ${mafiozoRec.storyCharacterName}. الساحة لاحظت تفصيلة "${mafiozoRec.suspiciousDetail}" بس في الجولة ${elimRound} الخيط ربط نفسه بنفسه.`;
    } else {
      const closeRound = votingHistory.find(v =>
        v.tally && v.tally[mafiozoRec.playerId] && v.eliminatedId !== mafiozoRec.playerId
      );
      if (closeRound) {
        explanation = `${mafiozoRec.username} كان قريب من الفضيحة في الجولة ${closeRound.round}، لكن الساحة ما اتأكدتش من تفصيلة "${mafiozoRec.suspiciousDetail}" في الوقت المناسب.`;
      } else {
        explanation = `${mafiozoRec.username} نجح يخبي تفصيلة "${mafiozoRec.suspiciousDetail}" تحت طبقات من الشك. ولا في جولة وحدة الصوت اتجه ناحيته بشكل حقيقي.`;
      }
    }

    if (mode === 'blind') {
      explanation += ` الأخطر إن اللعبة كانت "عمياني"، يعني ${mafiozoRec.username} نفسه ماكانش يعرف إنه المافيوزو وقت اللعب. الحقيقة اتكشفت دلوقتي الأول مرة.`;
    }

    return {
      mafiozoPlayerId: mafiozoRec.playerId,
      mafiozoUsername: mafiozoRec.username,
      mafiozoCharacterName: mafiozoRec.storyCharacterName,
      mafiozoStoryRole: mafiozoRec.storyCharacterRole,
      mafiozoSuspiciousDetail: mafiozoRec.suspiciousDetail,
      mafiozoExplanation: explanation,
    };
  }

  // ----- OBVIOUS SUSPECT --------------------------------------------------
  _buildObviousSuspect(ctx) {
    const { obviousRec, votingHistory } = ctx;
    if (!obviousRec) return null;

    const elimRound = votingHistory.find(v => v.eliminatedId === obviousRec.playerId)?.round;
    let explanation;
    if (elimRound) {
      explanation = `${obviousRec.username} طلع من اللعبة في الجولة ${elimRound}، والساحة كانت متأكدة إنها مسكت المافيوزو. لكن تفصيلة "${obviousRec.suspiciousDetail}" كانت غطاء، مش حقيقة.`;
    } else {
      explanation = `${obviousRec.username} عاش في ضوء الشبهة طول الجلسة. تفصيلة "${obviousRec.suspiciousDetail}" خلت كل اتهام يلمسه أول، لكن في الحقيقة كان بريء بالكامل.`;
    }

    return {
      playerId: obviousRec.playerId,
      username: obviousRec.username,
      characterName: obviousRec.storyCharacterName,
      storyRole: obviousRec.storyCharacterRole,
      suspiciousDetail: obviousRec.suspiciousDetail,
      explanation,
    };
  }

  // ----- PLAYER ROSTER ----------------------------------------------------
  _buildPlayerCards(ctx) {
    return ctx.allRecs.map(rec => {
      const elimRound = ctx.votingHistory.find(v => v.eliminatedId === rec.playerId)?.round || null;
      return {
        playerId: rec.playerId,
        username: rec.username,
        characterName: rec.storyCharacterName,
        storyRole: rec.storyCharacterRole,
        suspiciousDetail: rec.suspiciousDetail,
        gameRole: rec.gameRole,
        roleLabelArabic: this._roleLabelArabic(rec.gameRole),
        status: rec.isAlive ? 'survived' : 'eliminated',
        eliminatedRound: elimRound,
        survived: !!rec.isAlive,
      };
    });
  }

  // ----- CLUE ANALYSES ----------------------------------------------------
  _buildClueAnalyses(ctx) {
    const { archive, mafiozoRec, obviousRec, votingHistory } = ctx;
    const clues = Array.isArray(archive.clues) ? archive.clues : [];
    return clues.map((text, i) => {
      const type      = i === 0 ? 'red_herring' : i === 1 ? 'web' : i === 2 ? 'twist' : 'extra';
      const typeLabel = i === 0 ? 'تمويه'        : i === 1 ? 'ربط' : i === 2 ? 'انعطافة'  : 'حاسم';

      let surfaceMeaning, realMeaning;

      if (i === 0) {
        surfaceMeaning = obviousRec
          ? `بدا إن الدليل بيشاور على ${obviousRec.username}. كل التفاصيل خلت اللاعبين يجمعوا حول شخصيته.`
          : `بدا إن الدليل بيلمح للي عنده تفاصيل غريبة، والساحة لقت نفسها بتنط بين أسامي.`;
        realMeaning = mafiozoRec
          ? `لكن الدليل كان مصمم عشان يبعد الشك عن المافيوزو الحقيقي. اللي كان عند ${mafiozoRec.username} من شبهات فضل خفيف وما لفت نظر حد.`
          : `الدليل كان مصمم عشان يبعد الشك عن المافيوزو الحقيقي.`;
      } else if (i === 1) {
        surfaceMeaning = `بدا إن الدليل بيوصل بين أكتر من شخصية، والكل بقا فيه احتمال يبقى متورط.`;
        realMeaning = mafiozoRec
          ? `الحقيقة إن الدليل كان شبكة متشابكة، أحد خيوطها كان تفصيلة ${mafiozoRec.username} المريبة، لكنه ما كانش الخيط الواضح.`
          : `الحقيقة إن الدليل كان شبكة، فيها كل التفاصيل الصغيرة بتلتقي في نقطة واحدة.`;
      } else {
        // Twist — vary by whether it triggered the right elimination.
        const round = votingHistory.find(v => v.round === (i + 1));
        const caughtMaf = round && round.eliminatedId === mafiozoRec?.playerId;
        if (caughtMaf) {
          surfaceMeaning = `الدليل كان قلبة كاملة. تفصيلة صغيرة في تصرف ${mafiozoRec?.username || 'حد منكم'} غيّرت تفسير كل حاجة.`;
          realMeaning = `هنا الساحة قراها صح، وكشفت الحقيقة في الجولة الأخيرة.`;
        } else if (mafiozoRec) {
          surfaceMeaning = `الدليل كان قلبة، بس مش كل اللاعبين قروها صح.`;
          realMeaning = `كان الخيط اللي يكشف ${mafiozoRec.username}، لكن التصويت اتجه ناحية تانية، والمافيوزو نجا.`;
        } else {
          surfaceMeaning = `الدليل كان قلبة في القراءة، لكن السياق ضاع وسط الشك.`;
          realMeaning = `الانعطافة الحقيقية فضلت في الأرشيف.`;
        }
      }

      return { index: i, text, surfaceMeaning, realMeaning, type, typeLabel };
    });
  }

  // ----- VOTING TIMELINE --------------------------------------------------
  _buildVotingTimeline(ctx) {
    const { votingHistory, obviousRec } = ctx;
    return votingHistory.map(round => {
      const elimUsername = round.eliminatedUsername;
      let summary;

      if (round.reason === 'majority' && round.wasMafiozo) {
        summary = `الساحة قرأت الخيط صح في الجولة ${round.round} وقبضت على ${elimUsername} اللي طلع المافيوزو.`;
      } else if (round.reason === 'majority' && !round.wasMafiozo) {
        summary = `${elimUsername} خرج بأغلبية، لكنه كان بريء. الكشف لسه بعيد.`;
        if (obviousRec && round.eliminatedId === obviousRec.playerId) {
          summary += ` التضليل اشتغل بالظبط: المشتبه الواضح اتقبل قبل ما الساحة تشوف الخيط الحقيقي.`;
        }
      } else if (round.reason === 'tie') {
        summary = `الجولة ${round.round} انتهت بتعادل. محدش خرج، والشك فضل موزع.`;
      } else if (round.reason === 'no-vote') {
        summary = `الجولة ${round.round} عدّت بدون تصويت حاسم. الجو كان مشوش.`;
      } else if (round.reason === 'all-skip') {
        summary = `كل الساحة امتنعت عن التصويت في الجولة ${round.round}. مفيش حد كان متأكد.`;
      } else {
        summary = `الجولة ${round.round} انتهت من غير حسم.`;
      }

      if (round.closedBy === 'all_voted') {
        summary += ` (كل اللاعبين صوتوا قبل ما الوقت يخلص.)`;
      } else if (round.closedBy === 'host') {
        summary += ` (الكبير قفل التصويت بدري.)`;
      }

      return {
        round: round.round,
        votes: round.votes,
        tally: round.tally,
        eliminatedId: round.eliminatedId,
        eliminatedUsername: round.eliminatedUsername,
        wasMafiozo: round.wasMafiozo,
        reason: round.reason,
        closedBy: round.closedBy,
        summary,
      };
    });
  }

  // ----- DRAMATIC BEATS (variable bullet lines) ---------------------------
  _buildDramaticBeats(ctx) {
    const beats = [];
    const { votingHistory, mafiozoRec, obviousRec, mode, outcome } = ctx;

    if (votingHistory.length > 0) {
      const firstElim = votingHistory[0]?.eliminatedUsername;
      if (firstElim) beats.push(`أول صوت طلع ${firstElim} من الساحة.`);
    }

    if (obviousRec) {
      const obvElim = votingHistory.find(v => v.eliminatedId === obviousRec.playerId);
      if (obvElim) beats.push(`الجولة ${obvElim.round} شهدت سقوط المشتبه الواضح. ${obviousRec.username} كان فعلًا بريء.`);
    }

    const ties = votingHistory.filter(v => v.reason === 'tie').length;
    if (ties > 0) beats.push(`في ${ties} جولة من الجلسة، الساحة وقعت في تعادل. التردد كان أحد أسلحة المافيوزو.`);

    const noVotes = votingHistory.filter(v => v.reason === 'no-vote' || v.reason === 'all-skip').length;
    if (noVotes > 0) beats.push(`${noVotes} جولة عدت من غير تصويت حاسم. الساحة كانت مترددة.`);

    if (mode === 'blind') {
      beats.push(`في طور عمياني، حتى صاحب السر ماكانش يعرف. كل لاعب كان شايف نص الصورة بس.`);
    }

    if (outcome === 'mafiozo_survives' && mafiozoRec) {
      const everReceivedVote = votingHistory.some(v => v.tally && v.tally[mafiozoRec.playerId]);
      if (!everReceivedVote) {
        beats.push(`الأخطر إن ${mafiozoRec.username} ما اتصوّتش عليه في ولا جولة. اختفاؤه كان مثالي.`);
      }
    }

    if (outcome === 'investigators_win' && mafiozoRec) {
      const round = votingHistory.find(v => v.eliminatedId === mafiozoRec.playerId);
      if (round && round.closedBy === 'all_voted') {
        beats.push(`القرار في الجولة الحاسمة كان جماعي. كل الساحة شافت الخيط في نفس اللحظة.`);
      }
    }

    return beats;
  }

  // ----- FINAL PARAGRAPH --------------------------------------------------
  _buildFinalParagraph(ctx) {
    const { outcome, mode, mafiozoRec, votingHistory } = ctx;

    if (outcome === 'investigators_win') {
      const round = mafiozoRec ? votingHistory.find(v => v.eliminatedId === mafiozoRec.playerId)?.round : null;
      const where = round ? `في الجولة ${round}` : 'في النهاية';
      return `${where}، الساحة قدرت تكسر صمت المافيوزو وتقرا الخيط الصح. التحقيق كان قريب على الحقيقة من بدري، والصبر دفع تمنه. القضية اتقفلت، والأرشيف اتفك على عدالة.`;
    }
    if (outcome === 'mafiozo_survives') {
      const baseLine = `الأرشيف يقول: ${mafiozoRec?.username || 'حد منكم'} كان المافيوزو الحقيقي، وكسب اللعبة بهدوء.`;
      if (mode === 'blind') {
        return `${baseLine} في طور عمياني، الحقيقة كانت متدارية حتى عن أصحابها. مفيش أحد كان ماسك الخيط كامل، والمافيوزو نفسه كان معجب من النتيجة. الجلسة بتكشف دلوقتي الأول مرة كل التفاصيل اللي ما اتقالتش.`;
      }
      return `${baseLine} الساحة كانت قريبة من الحقيقة، لكن الخيط الصح ما اتمسكش في الوقت المناسب. النتيجة دلوقتي مكتوبة، والمافيوزو نام مرتاح.`;
    }
    return `الجلسة وقفت قبل ما يكتمل المشهد، لكن الأرشيف فضل ساكن. الكبير سلّم المفاتيح للحاضرين.`;
  }

  // -------------------------------------------------------------------------
  // Broadcast (public, sanitised)
  // -------------------------------------------------------------------------

  /**
   * Build the snapshot that goes to EVERYONE in the room. Strict allow-list:
   * never include roleAssignments or any per-player gameRole.
   */
  buildPublicState(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby) return null;
    const gd = lobby.gameData;
    return {
      phase: gd?.phase || 'LOBBY',
      timer: gd?.timer || 0,
      archive: gd?.archiveBase64 || '',
      currentClue: gd?.clues?.[gd.clueIndex] || '',
      clueIndex: gd?.clueIndex ?? 0,
      totalClues: gd?.clues?.length || 0,
      hostId: lobby.hostId,
      roleRevealMode: lobby.roleRevealMode || 'normal',
      publicCharacterCards: gd?.publicCharacterCards || [],
      eliminatedIds: gd?.eliminatedIds || [],
      lastVoteResult: gd?.lastVoteResult || null,
      outcome: gd?.outcome || null,
      // The full cinematic reveal payload — INCLUDED ONLY DURING FINAL_REVEAL.
      // Before that, finalReveal is undefined here, so hidden roles never
      // leak into the broadcast prematurely.
      finalReveal: gd?.phase === 'FINAL_REVEAL' ? (gd.finalReveal || null) : undefined,
      players: Array.from(lobby.players.values())
        // Safety net: filter any record missing id/username so phantom rows
        // never reach the UI even if a future code path forgets to validate.
        .filter(p => p && p.id && p.username)
        .map(p => ({
          id: p.id,
          username: p.username,
          isAlive: p.isAlive,
          isHost: p.isHost,
          // NOTE: deliberately NO `role`, NO `storyCharacterName`. The character
          // mapping travels in publicCharacterCards above so the client can
          // join by playerId without seeing it twice.
        })),
    };
  }

  broadcastFullState(roomId) {
    const payload = this.buildPublicState(roomId);
    if (payload) this.io.to(roomId).emit('full_state_update', payload);
  }

  // -------------------------------------------------------------------------
  // AI polish (C2 / C3) — fire-and-forget. Each method:
  //   - captures a snapshot of the relevant identifiers
  //   - calls the AI service (which never throws)
  //   - on success, re-acquires the live lobby and verifies it is still
  //     in the same phase / round before delivering the flavor
  //   - emits a small optional event the frontend renders if it arrives
  //
  // Privacy: alive Mafiozo identities are passed as forbiddenTerms to the
  // line validator (so the AI cannot expose them), NEVER as prompt input.
  // For final reveal the game is over — names are public.
  // -------------------------------------------------------------------------

  _aliveMafiozoForbiddenTerms(lobby) {
    const ra = (lobby && lobby.gameData && lobby.gameData.roleAssignments) || {};
    const out = [];
    for (const r of Object.values(ra)) {
      if (r && r.gameRole === 'mafiozo' && r.isAlive) {
        if (r.username) out.push(r.username);
        if (r.storyCharacterName) out.push(r.storyCharacterName);
      }
    }
    return out;
  }

  _polishVoteResult(lobby, voteResult) {
    const ai = getAi();
    if (!ai || typeof ai.embellishVoteResult !== 'function') return;
    const roomId = lobby.id;
    const round = voteResult.round;
    const totalRounds = (lobby.gameData.clues || []).length;
    const forbiddenTerms = this._aliveMafiozoForbiddenTerms(lobby);

    Promise.resolve(ai.embellishVoteResult({
      round, totalRounds,
      reason: voteResult.reason,
      eliminatedUsername: voteResult.eliminatedUsername || null,
      wasMafiozo: !!voteResult.wasMafiozo,
      outcome: lobby.gameData.outcome || null,
      votedCount: voteResult.votedCount,
      eligibleCount: voteResult.eligibleCount,
      mode: lobby.roleRevealMode || 'normal',
      forbiddenTerms,
    })).then((result) => {
      if (!result || !result.line) return;
      const lobbyNow = this.lobbies.get(roomId);
      if (!lobbyNow || !lobbyNow.gameData) return;
      // Stale-response guard: deliver only if lastVoteResult is still the
      // same round (next round hasn't started, lobby hasn't ended).
      const lvr = lobbyNow.gameData.lastVoteResult;
      if (!lvr || lvr.round !== round) return;
      lvr.flavor = { line: result.line, source: result.source || null };
      this.io.to(roomId).emit('vote_result_flavor', { round, line: result.line });
    }).catch(() => { /* swallow */ });
  }

  _polishClueTransition(lobby) {
    const ai = getAi();
    if (!ai || typeof ai.embellishClueTransition !== 'function') return;
    const roomId = lobby.id;
    const totalRounds = (lobby.gameData.clues || []).length;
    const clueIndexAtFire = lobby.gameData.clueIndex;
    const previous = lobby.gameData.lastVoteResult || null;
    const forbiddenTerms = this._aliveMafiozoForbiddenTerms(lobby);

    Promise.resolve(ai.embellishClueTransition({
      nextRound: clueIndexAtFire + 1,
      totalRounds,
      previousResultReason: previous ? previous.reason : null,
      previousEliminationPublicName: previous ? (previous.eliminatedUsername || null) : null,
      gameContinues: true,
      mode: lobby.roleRevealMode || 'normal',
      forbiddenTerms,
    })).then((result) => {
      if (!result || !result.line) return;
      const lobbyNow = this.lobbies.get(roomId);
      if (!lobbyNow || !lobbyNow.gameData) return;
      // Only deliver if we're still in the SAME CLUE_REVEAL round.
      if (lobbyNow.gameData.phase !== 'CLUE_REVEAL') return;
      if (lobbyNow.gameData.clueIndex !== clueIndexAtFire) return;
      this.io.to(roomId).emit('clue_transition_flavor', {
        round: clueIndexAtFire + 1,
        line: result.line,
      });
    }).catch(() => { /* swallow */ });
  }

  _polishFinalReveal(lobby) {
    const ai = getAi();
    if (!ai || typeof ai.embellishFinalReveal !== 'function') return;
    const roomId = lobby.id;
    const fr = lobby.gameData.finalReveal;
    if (!fr) return;

    // Build a compact, safe input. NEVER include archive_b64.
    const truth = fr.truth || {};
    const mafiozoNames = Array.isArray(truth.mafiozos) && truth.mafiozos.length
      ? truth.mafiozos.map(m => ({
          username: m && m.username ? String(m.username) : '',
          characterName: m && m.characterName ? String(m.characterName) : '',
        }))
      : (truth.mafiozoUsername
          ? [{ username: String(truth.mafiozoUsername), characterName: String(truth.mafiozoCharacterName || '') }]
          : []);
    const votingSummary = (lobby.gameData.votingHistory || []).slice(0, 8).map(h => ({
      round: h.round,
      eliminatedUsername: h.eliminatedUsername || null,
      wasMafiozo: !!h.wasMafiozo,
      reason: h.reason,
    }));
    const totalRounds = (lobby.gameData.clues || []).length;

    Promise.resolve(ai.embellishFinalReveal({
      outcome: lobby.gameData.outcome,
      totalRounds,
      revealMode: lobby.roleRevealMode || 'normal',
      mafiozoNames,
      votingSummary,
    })).then((result) => {
      if (!result || !result.polish) return;
      const lobbyNow = this.lobbies.get(roomId);
      if (!lobbyNow || !lobbyNow.gameData) return;
      if (lobbyNow.gameData.phase !== 'FINAL_REVEAL') return;
      if (!lobbyNow.gameData.finalReveal) return;
      lobbyNow.gameData.finalReveal.aiPolish = result.polish;
      this.io.to(roomId).emit('final_reveal_polish', { polish: result.polish });
    }).catch(() => { /* swallow */ });
  }

  // -------------------------------------------------------------------------
  // Lobby helpers
  // -------------------------------------------------------------------------

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  joinRoom(socket, roomId, isHost = false) {
    // Defensive: refuse any socket that did not authenticate. Without
    // userId/username, lobby.players.set(undefined, {username: undefined, ...})
    // would create a phantom "مشتبه" row counted in PLAYERS·N — exactly the
    // QA stop-class failure we are blocking here.
    if (!socket.userId || !socket.username) {
      socket.emit('join_rejected', {
        reason: 'unauthenticated',
        message: 'لازم تسجّل دخولك قبل ما تنضم للغرفة.',
      });
      return;
    }
    socket.join(roomId);
    const lobby = this.lobbies.get(roomId);
    if (!lobby) return;
    if (isHost && lobby.mode === 'AI') return; // AI host slot is virtual

    lobby.players.set(socket.userId, {
      id: socket.userId,
      username: socket.username,
      socketId: socket.id,
      isHost,
      isAlive: true,
      role: null,                 // populated by assignRoles
      storyCharacterName: null,   // populated by assignRoles
    });

    socket.currentRoom = roomId;
    this.io.to(roomId).emit('room_update', this.getRoomPublicData(roomId));
  }

  handleDisconnect(socket) {
    if (socket.currentRoom) {
      const lobby = this.lobbies.get(socket.currentRoom);
      if (lobby && lobby.players.has(socket.userId)) {
        // leave them inside for state reconnection
      }
    }
  }

  getRoomPublicData(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby) return null;
    const playersArr = Array.from(lobby.players.values())
      .filter(p => p && p.id && p.username)
      .map(p => ({
        id: p.id, username: p.username, isHost: p.isHost, isAlive: p.isAlive,
      }));
    return {
      id: lobby.id,
      state: lobby.state,
      players: playersArr,
      mode: lobby.mode,
      roleRevealMode: lobby.roleRevealMode || 'normal',
      creatorId: lobby.creatorId,
    };
  }
}

module.exports = GameManager;
