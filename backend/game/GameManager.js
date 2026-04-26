const crypto = require('crypto');

/**
 * GameManager — multiplayer state machine for AlKabeer.
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
          this.io.to(roomId).emit('game_started', { id: roomId });
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

        const eligible = [...lobby.players.values()].filter(p => !p.isHost);
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
        if (lobby && lobby.gameData && lobby.gameData.phase === 'VOTING') {
          lobby.gameData.votes[socket.userId] = targetId;
          socket.emit('vote_registered', { userId: socket.userId, targetId });
        }
      });

      socket.on('host_control', (data) => {
        const { action, roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (lobby && this.isAuthorizedHost(socket, lobby) && lobby.gameData) {
          if (action === 'pause')        lobby.gameData.isPaused = true;
          else if (action === 'resume')  lobby.gameData.isPaused = false;
          else if (action === 'extend')  lobby.gameData.timer += 30;
          else if (action === 'skip')    lobby.gameData.timer = 0;

          this.io.to(roomId).emit('timer_update', lobby.gameData.timer);
        }
      });

      socket.on('force_phase', (data) => {
        const { phase, roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (lobby && this.isAuthorizedHost(socket, lobby) && lobby.gameData) {
          lobby.gameData.phase = phase;
          lobby.gameData.timer = 60;
          if (phase === 'CLUE_REVEAL' && lobby.gameData.clueIndex < 2) {
            lobby.gameData.clueIndex++;
          }
          this.broadcastFullState(roomId);
        }
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

  handlePhaseEnd(roomId) {
    const lobby = this.lobbies.get(roomId);
    if (!lobby || !lobby.gameData) return;
    let shouldContinue = true;

    const cur = lobby.gameData.phase;
    if (cur === 'ROLE_REVEAL') {
      lobby.gameData.phase = 'PUBLIC_CHARACTER_OVERVIEW';
      lobby.gameData.timer = 10;
    } else if (cur === 'PUBLIC_CHARACTER_OVERVIEW') {
      lobby.gameData.phase = 'CLUE_REVEAL';
      lobby.gameData.timer = 45;
    } else if (cur === 'CLUE_REVEAL') {
      lobby.gameData.phase = 'VOTING';
      lobby.gameData.timer = 30;
    } else if (cur === 'VOTING') {
      // Per-round voting + elimination land in Commit 2. For now: same legacy
      // behavior — clear votes and either advance clues or end.
      if (lobby.gameData.clueIndex < 2) {
        lobby.gameData.clueIndex++;
        lobby.gameData.phase = 'CLUE_REVEAL';
        lobby.gameData.timer = 45;
        lobby.gameData.votes = {};
      } else {
        lobby.gameData.phase = 'POST_GAME';
        lobby.gameData.timer = 0;
        shouldContinue = false;
      }
    }

    this.broadcastFullState(roomId);
    if (!shouldContinue && lobby.gameData.interval) {
      clearInterval(lobby.gameData.interval);
    }
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
      hostId: lobby.hostId,
      roleRevealMode: lobby.roleRevealMode || 'normal',
      publicCharacterCards: gd?.publicCharacterCards || [],
      players: Array.from(lobby.players.values()).map(p => ({
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
  // Lobby helpers
  // -------------------------------------------------------------------------

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  joinRoom(socket, roomId, isHost = false) {
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
    const playersArr = Array.from(lobby.players.values()).map(p => ({
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
