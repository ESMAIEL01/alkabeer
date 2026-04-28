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

// F1 — privacy-safe analytics events. Lazy-required for the same reason as
// the AI module. Wrapped in fireEvent(...) so calls are always non-blocking
// and never throw, even if the analytics module fails to load (test harness
// without DB) or the DB write fails.
let _analytics = null;
function getAnalytics() {
  if (_analytics !== null) return _analytics;
  try {
    _analytics = require('../services/analytics');
  } catch (_) {
    _analytics = false;
  }
  return _analytics;
}
function fireEvent(args) {
  try {
    const a = getAnalytics();
    if (!a || typeof a.logEvent !== 'function') return;
    Promise.resolve(a.logEvent(args)).catch(() => { /* swallow */ });
  } catch { /* swallow */ }
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

// ---------------------------------------------------------------------------
// E1 — Custom Mode game config (multi-Mafiozo / variable clue count).
//
// Default behavior (rawConfig null/missing): isCustom=false, mafiozoCount=1,
// clueCount=3, obviousSuspectEnabled when N>=4 — exactly the pre-E1 logic.
// Custom config: explicit playerCount/mafiozoCount/clueCount with per-field
// validation. The lobby object stores the normalized config on lobby.config
// (or null for default games) so all downstream readers can branch on
// resolveLobbyConfig(lobby).
// ---------------------------------------------------------------------------

const CUSTOM_PLAYER_MIN  = 3;
const CUSTOM_PLAYER_MAX  = 8;
const CUSTOM_CLUE_MIN    = 1;
const CUSTOM_CLUE_MAX    = 5;
const DEFAULT_CLUE_COUNT = 3;
const DEFAULT_MAFIOZO_COUNT = 1;

function maxMafiozoForPlayerCount(n) {
  // Keep at least one innocent + (optional) obvious_suspect. The cap
  // floor((N - 1) / 2) ensures Mafiozos < non-Mafiozos so investigators
  // remain numerically meaningful.
  if (!Number.isFinite(n) || n < 2) return 0;
  return Math.floor((n - 1) / 2);
}

/**
 * Validate a raw config blob from create_room / future archive endpoints.
 * Returns { ok, errors[], normalized }. Never throws.
 */
function validateGameConfig(rawConfig) {
  const errors = [];
  if (rawConfig === null || rawConfig === undefined) {
    return { ok: true, errors, normalized: null };
  }
  if (typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return { ok: false, errors: ['الإعداد المخصص لازم يكون كائن.'], normalized: null };
  }
  const playerCount = Number.parseInt(rawConfig.playerCount, 10);
  const mafiozoCount = Number.parseInt(rawConfig.mafiozoCount, 10);
  const clueCount    = Number.parseInt(rawConfig.clueCount, 10);

  if (!Number.isFinite(playerCount) || playerCount < CUSTOM_PLAYER_MIN || playerCount > CUSTOM_PLAYER_MAX) {
    errors.push(`عدد اللاعبين لازم يكون من ${CUSTOM_PLAYER_MIN} لـ ${CUSTOM_PLAYER_MAX}.`);
  }
  const maxMafiozo = maxMafiozoForPlayerCount(playerCount);
  if (!Number.isFinite(mafiozoCount) || mafiozoCount < 1 || mafiozoCount > maxMafiozo) {
    errors.push(`عدد المافيوزو لازم يكون من 1 لـ ${Math.max(1, maxMafiozo)}.`);
  }
  if (!Number.isFinite(clueCount) || clueCount < CUSTOM_CLUE_MIN || clueCount > CUSTOM_CLUE_MAX) {
    errors.push(`عدد الأدلة لازم يكون من ${CUSTOM_CLUE_MIN} لـ ${CUSTOM_CLUE_MAX}.`);
  }
  if (errors.length) return { ok: false, errors, normalized: null };

  // obviousSuspectEnabled: respect explicit boolean if supplied; otherwise
  // default to true when there is room for one (N >= 4 and at least one
  // innocent slot remains after Mafiozos + obvious_suspect).
  const slotsAfterMafiozos = playerCount - mafiozoCount;
  const enableByDefault = playerCount >= 4 && slotsAfterMafiozos >= 2;
  const obviousSuspectEnabled = (typeof rawConfig.obviousSuspectEnabled === 'boolean')
    ? (rawConfig.obviousSuspectEnabled && enableByDefault)
    : enableByDefault;

  return {
    ok: true,
    errors: [],
    normalized: {
      isCustom: true,
      playerCount, mafiozoCount, clueCount, obviousSuspectEnabled,
    },
  };
}

/**
 * Synthesize the default config for a given joined-non-host count. Returns
 * isCustom=false. Used by callers that need to branch uniformly on a config
 * object even for default games.
 */
function getDefaultGameConfig(actualPlayerCount) {
  const N = Number.isFinite(actualPlayerCount) ? actualPlayerCount : 0;
  return {
    isCustom: false,
    playerCount: N,
    mafiozoCount: DEFAULT_MAFIOZO_COUNT,
    clueCount: DEFAULT_CLUE_COUNT,
    // Default behavior preserved: enable obvious_suspect only at N>=4.
    obviousSuspectEnabled: N >= 4,
  };
}

/**
 * Best-effort normalization for a possibly partial input. Used by
 * create_room. Returns { ok, errors, normalized } where normalized is
 * either a full custom config or null (default mode).
 */
function normalizeGameConfig(rawConfig) {
  return validateGameConfig(rawConfig);
}

/**
 * Resolve a config for the lobby, defaulting from actual non-host players
 * when no custom config is set. Always returns a fully-populated config
 * object so role-assignment / final-reveal code can read uniformly.
 */
function resolveLobbyConfig(lobby) {
  if (!lobby) return getDefaultGameConfig(0);
  if (lobby.config && lobby.config.isCustom) return lobby.config;
  const eligibleCount = Array.from((lobby.players || new Map()).values())
    .filter(p => p && p.id && p.username && !p.isHost).length;
  return getDefaultGameConfig(eligibleCount);
}

// ---------------------------------------------------------------------------
// Player-count semantics (FixPack v2 / Commit 1)
//
// Custom Mode is documented as "playerCount = number of participating SUSPECT
// players". A human host who is only hosting is NEVER counted as a suspect.
// AI Host rooms have no human host; everyone joined is a suspect. These
// helpers make the semantics explicit so the validator's error copy can
// quote both the required count and the actual count, eliminating the prior
// ambiguous "محتاج 3 لاعبين" message.
// ---------------------------------------------------------------------------

/**
 * Real players: any record with id + username. Phantom rows (missing id or
 * missing username) are filtered out at this layer so every downstream caller
 * sees a clean list.
 */
function getRealPlayers(lobby) {
  if (!lobby || !lobby.players) return [];
  return Array.from(lobby.players.values()).filter(p => p && p.id && p.username);
}

/**
 * Host players: real players whose isHost flag is truthy. In AI Host rooms
 * this is always empty (the AI host slot is virtual). In Human Host rooms
 * this is exactly one player (the creator).
 */
function getHostPlayers(lobby) {
  return getRealPlayers(lobby).filter(p => p.isHost);
}

/**
 * Suspect players: real players who participate in the game as
 * card/voting players. Excludes the human host because hosting != playing.
 */
function getSuspectPlayers(lobby) {
  return getRealPlayers(lobby).filter(p => !p.isHost);
}

/**
 * Count of suspect players currently joined to this lobby.
 */
function getCurrentSuspectCount(lobby) {
  return getSuspectPlayers(lobby).length;
}

/**
 * Required suspect count for a config:
 *   - Default mode (no custom config): no requirement → returns null.
 *   - Custom mode: cfg.playerCount is the exact number of suspect seats.
 */
function getCustomRequiredSuspectCount(config) {
  if (!config || !config.isCustom) return null;
  return Number.isFinite(config.playerCount) ? config.playerCount : null;
}

/**
 * Custom-mode start gate: the ARCHIVE-FINALIZE step must observe exactly
 * config.playerCount eligible non-host (suspect) players. Default mode skips
 * this check entirely. Returns { ok, error?, current?, required? }.
 *
 * The error message includes BOTH required and current counts to remove
 * the ambiguity reported in the FixPack v2 screenshot.
 *
 * @param {object} lobby
 * @param {object} [explicitConfig] optional override; defaults to lobby.config
 */
function validateCustomStartCount(lobby, explicitConfig) {
  const cfg = explicitConfig === undefined ? (lobby && lobby.config) : explicitConfig;
  const required = getCustomRequiredSuspectCount(cfg);
  if (required === null) return { ok: true };
  const current = getCurrentSuspectCount(lobby);
  if (current !== required) {
    return {
      ok: false,
      required,
      current,
      error: `الإعداد المخصص يحتاج ${required} لاعبين مشاركين بالضبط قبل الختم. الموجود الآن: ${current}.`,
    };
  }
  return { ok: true, required, current };
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

        // E1: optional Custom Mode config. null/undefined = default behavior.
        const cfgResult = normalizeGameConfig(data && data.config);
        if (!cfgResult.ok) {
          return safeCb({ success: false, message: cfgResult.errors[0] || 'الإعداد المخصص غير صالح.' });
        }

        this.lobbies.set(roomId, {
          id: roomId,
          creatorId: socket.userId,
          hostId: mode === 'HUMAN' ? socket.userId : 'AI_HOST',
          mode,
          roleRevealMode,
          config: cfgResult.normalized,    // null = default; object = custom
          players: new Map(),
          state: 'LOBBY',
          gameData: null,
          createdAt: new Date().toISOString(),
          // FixPack v2 / Commit 3: AI Host ready quorum state. Only used in
          // AI mode; ignored by Human Host rooms.
          aiReadyPlayers: new Set(),
          aiStartInProgress: false,
        });

        // F1: privacy-safe session.created event. Carries config metadata
        // (counts only) and the host's user id. NEVER carries the host
        // username, the AI host persona, the archive, or any identity.
        const cfgN = cfgResult.normalized || {};
        fireEvent({
          eventType: 'session.created',
          userId: socket.userId,
          gameId: roomId,
          payload: {
            mode,
            roleRevealMode,
            isCustom: !!cfgN.isCustom,
            playerCount: Number.isFinite(cfgN.playerCount) ? cfgN.playerCount : null,
            mafiozoCount: Number.isFinite(cfgN.mafiozoCount) ? cfgN.mafiozoCount : null,
            clueCount: Number.isFinite(cfgN.clueCount) ? cfgN.clueCount : null,
          },
        });

        this.joinRoom(socket, roomId, mode === 'HUMAN');
        safeCb({ success: true, roomId, config: cfgResult.normalized });
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

      // ---------------------------------------------------------------------
      // FixPack v2 / Commit 3 — AI Host ready quorum.
      //
      // AI Host rooms have NO human host pressing a seal button. Instead,
      // any suspect player can press "ready"; once 3+ are ready (and any
      // custom playerCount is satisfied), the server generates the archive
      // automatically and enters ROLE_REVEAL. Race-safe via the
      // aiStartInProgress flag — a concurrent third click cannot trigger
      // duplicate generation.
      // ---------------------------------------------------------------------
      socket.on('ai_host_ready', (data, ack) => {
        const safeAck = typeof ack === 'function' ? ack : () => {};
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby) {
          return safeAck({ success: false, error: 'الغرفة مش موجودة.' });
        }
        if (lobby.mode !== 'AI') {
          return safeAck({ success: false, error: 'هذا الزر متاح فقط في غرف الكبير الاصطناعي.' });
        }
        if (lobby.state !== 'LOBBY') {
          return safeAck({ success: false, error: 'اللعبة بدأت بالفعل.' });
        }
        if (!socket.userId) {
          return safeAck({ success: false, error: 'لازم تسجّل دخولك الأول.' });
        }
        // Player must be a real suspect in the lobby (not host, not phantom).
        const me = getPlayerById(lobby, socket.userId);
        if (!me || me.isHost || !me.id || !me.username) {
          return safeAck({ success: false, error: 'لازم تكون لاعب مشارك في الغرفة.' });
        }

        // Idempotent toggle: if already ready, just echo progress; otherwise add.
        if (!lobby.aiReadyPlayers) lobby.aiReadyPlayers = new Set();
        const wasReady = lobby.aiReadyPlayers.has(me.id);
        if (!wasReady) lobby.aiReadyPlayers.add(me.id);

        // Compute progress + threshold AFTER the add.
        const progress = this._computeAiReadyProgress(lobby);
        this.io.to(roomId).emit('ai_host_ready_progress', progress);
        safeAck({ success: true, ...progress });

        // Check quorum + start (race-safe via aiStartInProgress).
        if (progress.canStart && !lobby.aiStartInProgress) {
          lobby.aiStartInProgress = true;
          this.io.to(roomId).emit('ai_host_starting', { roomId });
          // Fire-and-forget; the helper handles its own errors and broadcasts
          // a final 'ai_host_failed' event on unrecoverable failure.
          Promise.resolve(this._aiHostGenerateAndStart(lobby))
            .catch((err) => {
              console.warn('[ai-host] generate-and-start failed:', err && err.message);
              lobby.aiStartInProgress = false;
              this.io.to(roomId).emit('ai_host_failed', {
                error: 'تعذّر بدء اللعبة. حاولوا تاني بعد لحظة.',
              });
            });
        }
      });

      // Player explicitly cancels their ready signal (rare, but supported).
      socket.on('ai_host_unready', (data, ack) => {
        const safeAck = typeof ack === 'function' ? ack : () => {};
        const { roomId } = data || {};
        const lobby = this.lobbies.get(roomId);
        if (!lobby || lobby.mode !== 'AI' || lobby.state !== 'LOBBY') {
          return safeAck({ success: false });
        }
        if (lobby.aiStartInProgress) {
          // Once generation started, ready signals are locked.
          return safeAck({ success: false, error: 'الكبير بدأ يبني الأرشيف بالفعل.' });
        }
        if (lobby.aiReadyPlayers && socket.userId) {
          lobby.aiReadyPlayers.delete(socket.userId);
        }
        const progress = this._computeAiReadyProgress(lobby);
        this.io.to(roomId).emit('ai_host_ready_progress', progress);
        safeAck({ success: true, ...progress });
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

        // E1: custom-mode start gate. Default mode skips this check.
        const startGate = validateCustomStartCount(lobby);
        if (!startGate.ok) {
          return safeAck({ success: false, error: startGate.error });
        }

        // E1/E4: resolve config (default or custom) once and use everywhere.
        const cfg = resolveLobbyConfig(lobby);
        const expectedClueCount = cfg.clueCount;

        // Validate decoded archive clue count for custom mode. Default mode
        // keeps the existing tolerant fallback.
        const decodedClues = Array.isArray(decoded.clues) ? decoded.clues : [];
        if (cfg.isCustom && decodedClues.length !== expectedClueCount) {
          return safeAck({
            success: false,
            error: `الأرشيف المخصص محتاج ${expectedClueCount} أدلة بالضبط.`,
          });
        }

        const { roleAssignments, publicCharacterCards } = this.assignRoles(eligible, decoded, cfg);

        // Resolve final clue list. Priority:
        //   1. Caller-supplied `clues` array of expected length
        //   2. decoded.clues of expected length
        //   3. Deterministic placeholders padded to expected length
        let finalClues;
        if (Array.isArray(clues) && clues.length === expectedClueCount) {
          finalClues = clues;
        } else if (decodedClues.length === expectedClueCount) {
          finalClues = decodedClues;
        } else {
          finalClues = Array.from({ length: expectedClueCount }, (_, i) => `دليل ${i + 1}...`);
        }

        lobby.state = 'IN_GAME';
        lobby.gameData = {
          archiveBase64: archive,
          rawScenario: raw,
          decodedArchive: decoded,                  // server-only
          clues: finalClues,
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

        // F1: privacy-safe session.archive_sealed event. Carries the
        // archive provenance label (gemini/openrouter/fallback when the
        // host route resolved it; AI source not always known here) and
        // config counts only. Never the archive body, never identities.
        fireEvent({
          eventType: 'session.archive_sealed',
          userId: socket.userId,
          gameId: roomId,
          payload: {
            archiveSource: typeof decoded.source === 'string' ? decoded.source : 'unknown',
            isCustom: !!cfg.isCustom,
            playerCount: Number.isFinite(cfg.playerCount) ? cfg.playerCount : null,
            mafiozoCount: Number.isFinite(cfg.mafiozoCount) ? cfg.mafiozoCount : null,
            clueCount: Number.isFinite(cfg.clueCount) ? cfg.clueCount : null,
          },
        });

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

        // F1: privacy-safe vote.cast event. NEVER carries voter id, target
        // id, or username — only targetKind ('player' | 'skip') and the
        // current round (clueIndex+1). Voter user id goes in the user_id
        // column, which is per-row admin-visible but allow-listed off all
        // public surfaces.
        fireEvent({
          eventType: 'vote.cast',
          userId: voter.id,
          gameId: roomId,
          payload: {
            targetKind: canonicalTarget === 'skip' ? 'skip' : 'player',
            round: (Number.isFinite(lobby.gameData.clueIndex) ? lobby.gameData.clueIndex : 0) + 1,
          },
        });

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
          // F1: feature.ready_to_vote_used — every participant readied up.
          fireEvent({
            eventType: 'feature.ready_to_vote_used',
            userId: socket.userId,
            gameId: roomId,
            payload: {
              round: (Number.isFinite(lobby.gameData.clueIndex) ? lobby.gameData.clueIndex : 0) + 1,
              eligibleCount: participants.length,
              readyCount: ready,
            },
          });
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
          // F1: feature.vote_extension_activated. Counters only.
          fireEvent({
            eventType: 'feature.vote_extension_activated',
            userId: socket.userId,
            gameId: roomId,
            payload: {
              round: (Number.isFinite(lobby.gameData.clueIndex) ? lobby.gameData.clueIndex : 0) + 1,
              eligibleCount: participants.length,
              requestedCount: requested,
              requiredCount: required,
              secondsAdded,
            },
          });
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
  assignRoles(eligiblePlayers, archive, config) {
    const N = eligiblePlayers.length;
    const characters = padCharactersToCount(archive.characters, N);

    // Independent shuffles so character != game role mapping.
    const shuffledChars = secureShuffle(characters).slice(0, N);
    const shuffledPlayers = secureShuffle(eligiblePlayers);

    // E1: config-aware allocation. config.mafiozoCount controls how many
    // hidden Mafiozos exist; config.obviousSuspectEnabled controls whether
    // an obvious_suspect slot is allocated. Default config (cfg.isCustom
    // false) preserves the pre-E1 behavior bit-for-bit:
    //   index 0          → mafiozo
    //   index 1          → obvious_suspect (only if N >= 4)
    //   rest             → innocent
    const cfg = (config && typeof config === 'object') ? config : getDefaultGameConfig(N);
    const M  = Math.max(1, Math.min(cfg.mafiozoCount || 1, N - 1));
    const enableObvious = !!cfg.obviousSuspectEnabled && N >= 4 && (N - M) >= 2;

    const gameRoleByIndex = new Array(N).fill('innocent');
    for (let i = 0; i < M; i++) gameRoleByIndex[i] = 'mafiozo';
    if (enableObvious) gameRoleByIndex[M] = 'obvious_suspect';

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
    const previousPhase = lobby.gameData.phase || null;
    lobby.gameData.phase = phase;
    lobby.gameData.timer = durationSeconds;

    // F1: privacy-safe session.phase_transition event. Counters only.
    fireEvent({
      eventType: 'session.phase_transition',
      userId: Number.isFinite(lobby.creatorId) ? lobby.creatorId : null,
      gameId: lobby.id,
      payload: {
        phase,
        previousPhase,
        round: (Number.isFinite(lobby.gameData.clueIndex) ? lobby.gameData.clueIndex : 0) + 1,
        durationSeconds: Number.isFinite(durationSeconds) ? durationSeconds : null,
      },
    });
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
        fireEvent({
          eventType: 'error.phase_machine',
          userId: Number.isFinite(lobby.creatorId) ? lobby.creatorId : null,
          gameId: lobby.id,
          payload: {
            phase: 'FINAL_REVEAL',
            kind: 'buildFinalReveal_failed',
            note: (err && err.message ? String(err.message) : 'unknown').slice(0, 200),
          },
        });
      }
      this.broadcastFullState(lobby.id);
      // C3: optional AI polish — fire and forget. Deterministic reveal
      // already shipped; this only attaches optional flavor fields when
      // the AI returns and the lobby is still in FINAL_REVEAL.
      this._polishFinalReveal(lobby);
      // D1: persist completed session + bump player stats. Fire-and-forget;
      // never blocks gameplay; idempotent (ON CONFLICT DO NOTHING on the
      // session row gates the participants + stats writes too).
      this.persistSessionAndStats(lobby).catch(() => { /* swallow */ });
      // F1: privacy-safe session.ended event. Counters + outcome label only.
      const cfgEnded = lobby.config || {};
      const startedAt = lobby.createdAt ? Date.parse(lobby.createdAt) : null;
      const durationSec = (Number.isFinite(startedAt))
        ? Math.max(0, Math.round((Date.now() - startedAt) / 1000))
        : null;
      const totalRounds = Array.isArray(lobby.gameData.clues) ? lobby.gameData.clues.length : null;
      fireEvent({
        eventType: 'session.ended',
        userId: Number.isFinite(lobby.creatorId) ? lobby.creatorId : null,
        gameId: lobby.id,
        payload: {
          outcome: lobby.gameData.outcome || 'unknown',
          rounds: totalRounds,
          durationSec,
          isCustom: !!cfgEnded.isCustom,
          playerCount: Number.isFinite(cfgEnded.playerCount) ? cfgEnded.playerCount : null,
          mafiozoCount: Number.isFinite(cfgEnded.mafiozoCount) ? cfgEnded.mafiozoCount : null,
          clueCount: Number.isFinite(cfgEnded.clueCount) ? cfgEnded.clueCount : null,
        },
      });
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

    // E2: multi-Mafiozo win-condition support. Compute remaining alive
    // Mafiozos AFTER any elimination above (closeVoting already mutated
    // roleAssignments[id].isAlive when wasMafiozo). Investigators only
    // win when ALL Mafiozos are eliminated. Default single-Mafiozo games
    // collapse to the original behavior (totalMafiozos=1; eliminating it
    // sets aliveMafiozos=0 immediately).
    const allRoleRecs = Object.values(lobby.gameData.roleAssignments || {});
    const totalMafiozos = allRoleRecs.filter(r => r.gameRole === 'mafiozo').length;
    const aliveMafiozos = allRoleRecs.filter(r => r.gameRole === 'mafiozo' && r.isAlive).length;

    // Build the broadcast-safe vote_result payload. NEVER includes mafiozo
    // identity beyond the boolean wasMafiozo on the eliminated player. The
    // mafiozosRemaining + totalMafiozos counters are SAFE: counts only,
    // not identities.
    const voteResult = {
      round,
      eliminatedId,
      eliminatedUsername: resolvedElimUsername,
      wasMafiozo,
      reason: outcomeReason,
      tally: { ...tally },
      eligibleCount: participants.length,
      votedCount: participants.filter(p => votes[p.id] !== undefined).length,
      mafiozosRemaining: aliveMafiozos,
      totalMafiozos,
    };
    lobby.gameData.lastVoteResult = voteResult;

    this.io.to(roomId).emit('vote_result', voteResult);

    // F1: vote.early_close event when the vote ended ahead of timer (every
    // participant voted, or host force-closed). Counters only — never the
    // tally itself, never identities.
    if (reason === 'all_voted' || reason === 'host') {
      fireEvent({
        eventType: 'vote.early_close',
        userId: Number.isFinite(lobby.creatorId) ? lobby.creatorId : null,
        gameId: roomId,
        payload: {
          reason,
          round,
          eligibleCount: participants.length,
          votedCount: voteResult.votedCount,
        },
      });
    }

    // C2: optional AI polish — fire and forget. The deterministic vote_result
    // already shipped above; this only adds an optional 'vote_result_flavor'
    // event that the frontend renders if/when it arrives.
    this._polishVoteResult(lobby, voteResult);

    // Decide what comes next.
    const lastClueReached = lobby.gameData.clueIndex >= lobby.gameData.clues.length - 1;

    // E2 win logic:
    //   - Mafiozo eliminated AND no Mafiozos remain → investigators_win
    //   - Mafiozo eliminated but some still alive → game continues (or
    //     ends as mafiozo_survives if this was the last clue)
    //   - non-Mafiozo eliminated, last clue reached, Mafiozos still alive
    //     → mafiozo_survives
    //   - tie / no-vote / all-skip on last clue with Mafiozos alive
    //     → mafiozo_survives
    if (wasMafiozo && aliveMafiozos === 0) {
      lobby.gameData.outcome = 'investigators_win';
      this.enterPhase(lobby, 'VOTE_RESULT', 8);
      this.startRoomTimer(roomId);
      return;
    }

    if (lastClueReached && aliveMafiozos > 0) {
      // Final-round close: no Mafiozos caught means at least one survives.
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
    const { allRecs, votingHistory, mode } = ctx;
    const allMafiozoRecs = allRecs.filter(r => r.gameRole === 'mafiozo');
    if (allMafiozoRecs.length === 0) return null;

    // E3: build a per-Mafiozo array describing each one. Single-Mafiozo
    // games yield length=1 and the legacy singular fields (preserved
    // below for older clients) match the first item.
    const mafiozos = allMafiozoRecs.map(rec => {
      const elimRound = votingHistory.find(v => v.eliminatedId === rec.playerId)?.round || null;
      const survived = !elimRound;

      let explanation;
      if (elimRound) {
        explanation = `${rec.username} كان مخبي نفسه ورا شخصية ${rec.storyCharacterName}. الساحة لاحظت تفصيلة "${rec.suspiciousDetail}" بس في الجولة ${elimRound} الخيط ربط نفسه بنفسه.`;
      } else {
        const closeRound = votingHistory.find(v =>
          v.tally && v.tally[rec.playerId] && v.eliminatedId !== rec.playerId
        );
        if (closeRound) {
          explanation = `${rec.username} كان قريب من الفضيحة في الجولة ${closeRound.round}، لكن الساحة ما اتأكدتش من تفصيلة "${rec.suspiciousDetail}" في الوقت المناسب.`;
        } else {
          explanation = `${rec.username} نجح يخبي تفصيلة "${rec.suspiciousDetail}" تحت طبقات من الشك. ولا في جولة وحدة الصوت اتجه ناحيته بشكل حقيقي.`;
        }
      }
      if (mode === 'blind' && survived) {
        explanation += ` الأخطر إن اللعبة كانت "عمياني"، يعني ${rec.username} نفسه ماكانش يعرف إنه المافيوزو وقت اللعب.`;
      }

      return {
        playerId: rec.playerId,
        username: rec.username,
        characterName: rec.storyCharacterName,
        storyRole: rec.storyCharacterRole,
        suspiciousDetail: rec.suspiciousDetail,
        eliminatedAtRound: elimRound,
        survived,
        explanation,
      };
    });

    // First Mafiozo seeds the legacy singular fields (preserves old
    // FinalRevealView fallback rendering bit-for-bit when length===1).
    const first = allMafiozoRecs[0];
    return {
      // E3: array shape — preferred by clients new enough to read it.
      mafiozos,
      mafiozoCount: allMafiozoRecs.length,
      // Legacy singular fields — DO NOT REMOVE. Older client builds
      // (cached Vercel deploys) may still rely on these names.
      mafiozoPlayerId:         first.playerId,
      mafiozoUsername:         first.username,
      mafiozoCharacterName:    first.storyCharacterName,
      mafiozoStoryRole:        first.storyCharacterRole,
      mafiozoSuspiciousDetail: first.suspiciousDetail,
      mafiozoExplanation:      mafiozos[0].explanation,
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
      // E1: safe public config view. Exposes only metadata the UI needs;
      // NEVER includes role assignments, identities, or hidden truth.
      customConfig: lobby.config && lobby.config.isCustom
        ? {
            isCustom: true,
            playerCount: lobby.config.playerCount,
            mafiozoCount: lobby.config.mafiozoCount,
            clueCount: lobby.config.clueCount,
          }
        : null,
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
  // D1 — Session + stats persistence.
  //
  // Called fire-and-forget on entering FINAL_REVEAL, AFTER the deterministic
  // reveal has been built and broadcast. Hard guarantees:
  //   - Never throws. DB failures are caught and logged short.
  //   - Idempotent: re-entry skips via lobby.gameData.persistenceStarted /
  //     lobby.gameData.persisted AND via INSERT ... ON CONFLICT DO NOTHING
  //     on the session row. Stats are bumped only when the session insert
  //     actually inserted a row.
  //   - Privacy: writes hidden roles ONLY because phase === FINAL_REVEAL
  //     (game is over and the existing privacy contract permits it).
  //   - Skips when this.db is missing or has no .query (test-injection path).
  //
  // Returns one of:
  //   { ok: true,  sessionId, participantCount }
  //   { ok: true,  skipped: true, reason: 'already_persisted' }
  //   { ok: false, reason: 'no_lobby' | 'wrong_phase' | 'no_final_reveal'
  //                       | 'in_progress' | 'no_db' | 'persist_failed' }
  // -------------------------------------------------------------------------

  async persistSessionAndStats(lobby) {
    if (!lobby || !lobby.gameData) return { ok: false, reason: 'no_lobby' };
    if (lobby.gameData.phase !== 'FINAL_REVEAL') return { ok: false, reason: 'wrong_phase' };
    if (!lobby.gameData.finalReveal) return { ok: false, reason: 'no_final_reveal' };
    if (lobby.gameData.persisted) return { ok: true, skipped: true, reason: 'already_persisted' };
    if (lobby.gameData.persistenceStarted) return { ok: false, reason: 'in_progress' };
    if (!this.db || typeof this.db.query !== 'function') return { ok: false, reason: 'no_db' };

    lobby.gameData.persistenceStarted = true;

    const useTransaction = !!(this.db.pool && typeof this.db.pool.connect === 'function');
    let client = null;
    try {
      if (useTransaction) {
        client = await this.db.pool.connect();
        await client.query('BEGIN');
      }
      const queryFn = client ? client.query.bind(client) : this.db.query;

      // ---- Build session row ------------------------------------------------
      const archive = lobby.gameData.decodedArchive || {};
      const fr = lobby.gameData.finalReveal || {};
      const scenarioTitle =
        (typeof archive.title === 'string' && archive.title.trim()) ? archive.title.trim()
        : (typeof fr.caseTitle === 'string' && fr.caseTitle.trim()) ? fr.caseTitle.trim()
        : (typeof fr.title === 'string' && fr.title.trim()) ? fr.title.trim()
        : null;

      const hostUserId =
        (lobby.mode === 'HUMAN' && Number.isFinite(lobby.hostId)) ? lobby.hostId
        : (Number.isFinite(lobby.creatorId)) ? lobby.creatorId
        : (Number.isFinite(lobby.hostId)) ? lobby.hostId
        : null;

      const sessionParams = [
        String(lobby.id),
        hostUserId,
        lobby.mode || 'UNKNOWN',
        lobby.gameData.roleRevealMode || lobby.gameData.revealMode || lobby.roleRevealMode || 'normal',
        lobby.config ? JSON.stringify(lobby.config) : null,
        lobby.gameData.outcome || null,
        scenarioTitle,
        lobby.gameData.archiveBase64 || lobby.gameData.archive_b64 || lobby.archive_b64 || null,
        JSON.stringify(lobby.gameData.votingHistory || []),
        JSON.stringify(lobby.gameData.eliminatedIds || []),
        JSON.stringify(fr),
        lobby.createdAt || lobby.gameData.startedAt || null,
      ];

      const sessionResult = await queryFn(
        `INSERT INTO game_sessions
           (id, host_user_id, host_mode, reveal_mode, custom_config, outcome,
            scenario_title, archive_b64, voting_history, eliminated_ids,
            final_reveal, started_at, ended_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9::jsonb, $10::jsonb,
                 $11::jsonb, $12, NOW())
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        sessionParams
      );

      const inserted = !!(sessionResult && sessionResult.rows && sessionResult.rows.length);
      if (!inserted) {
        // Another path already persisted this session — finish cleanly without
        // double-counting stats.
        if (client) await client.query('COMMIT');
        lobby.gameData.persisted = true;
        return { ok: true, skipped: true, reason: 'already_persisted' };
      }

      // ---- Build participant + stats payloads ------------------------------
      const players = Array.from(lobby.players.values())
        .filter(p => p && p.id && p.username);
      const roleAssignments = lobby.gameData.roleAssignments || {};
      const votingHistory = Array.isArray(lobby.gameData.votingHistory) ? lobby.gameData.votingHistory : [];
      const outcome = lobby.gameData.outcome || null;
      const totalRounds =
        (Array.isArray(archive.clues) && archive.clues.length > 0) ? archive.clues.length
        : (Array.isArray(lobby.gameData.clues) && lobby.gameData.clues.length > 0) ? lobby.gameData.clues.length
        : (Array.isArray(votingHistory) ? votingHistory.length : 0);

      let participantCount = 0;
      for (const p of players) {
        const isHost = !!p.isHost;
        let gameRole = null;
        let storyCharacterName = null;
        let storyCharacterRole = null;
        let eliminatedAtRound = null;
        let wasWinner = null;

        if (!isHost) {
          const rec = getRoleAssignment(lobby, p.id) || roleAssignments[p.id] || null;
          if (rec) {
            gameRole = rec.gameRole || null;
            storyCharacterName = rec.storyCharacterName || rec.characterName || null;
            storyCharacterRole = rec.storyCharacterRole || rec.characterRole || null;
          }
          // Eliminated-round lookup using the canonical id helper.
          for (const h of votingHistory) {
            if (h && h.eliminatedId !== undefined && h.eliminatedId !== null && sameId(h.eliminatedId, p.id)) {
              eliminatedAtRound = h.round || null;
              break;
            }
          }
          // Winner determination from outcome + role.
          const isMafiozo = gameRole === 'mafiozo';
          if (outcome === 'investigators_win') wasWinner = !isMafiozo;
          else if (outcome === 'mafiozo_survives') wasWinner = isMafiozo;
          // otherwise null (tie/unknown)
        }

        await queryFn(
          `INSERT INTO game_participants
             (game_id, user_id, username, was_host, game_role,
              story_character_name, story_character_role,
              eliminated_at_round, was_winner)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (game_id, user_id) DO NOTHING`,
          [String(lobby.id), p.id, p.username, isHost, gameRole,
           storyCharacterName, storyCharacterRole, eliminatedAtRound, wasWinner]
        );
        participantCount++;

        // Stats: only non-host real players, only when we just inserted the
        // session row (idempotency boundary).
        if (!isHost) {
          const survivedRounds = (eliminatedAtRound !== null && Number.isFinite(eliminatedAtRound))
            ? eliminatedAtRound
            : totalRounds;
          await queryFn(
            `INSERT INTO user_stats
               (user_id, games_played, wins, losses,
                times_mafiozo, times_innocent, times_obvious_suspect,
                total_survival_rounds, favorite_mode, last_played_at)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, NOW())
             ON CONFLICT (user_id) DO UPDATE SET
               games_played          = user_stats.games_played + 1,
               wins                  = user_stats.wins + EXCLUDED.wins,
               losses                = user_stats.losses + EXCLUDED.losses,
               times_mafiozo         = user_stats.times_mafiozo + EXCLUDED.times_mafiozo,
               times_innocent        = user_stats.times_innocent + EXCLUDED.times_innocent,
               times_obvious_suspect = user_stats.times_obvious_suspect + EXCLUDED.times_obvious_suspect,
               total_survival_rounds = user_stats.total_survival_rounds + EXCLUDED.total_survival_rounds,
               favorite_mode         = COALESCE(EXCLUDED.favorite_mode, user_stats.favorite_mode),
               last_played_at        = EXCLUDED.last_played_at`,
            [
              p.id,
              wasWinner === true ? 1 : 0,
              wasWinner === false ? 1 : 0,
              gameRole === 'mafiozo' ? 1 : 0,
              gameRole === 'innocent' ? 1 : 0,
              gameRole === 'obvious_suspect' ? 1 : 0,
              survivedRounds,
              lobby.gameData.roleRevealMode || lobby.roleRevealMode || null,
            ]
          );
        }
      }

      if (client) await client.query('COMMIT');
      lobby.gameData.persisted = true;
      return { ok: true, sessionId: lobby.id, participantCount };
    } catch (err) {
      if (client) {
        try { await client.query('ROLLBACK'); } catch (_) { /* swallow */ }
      }
      lobby.gameData.persistenceStarted = false; // allow a future retry on transient error
      const msg = err && err.message ? String(err.message).slice(0, 120) : 'unknown';
      const code = err && err.code ? String(err.code) : '';
      console.warn('[persist] failed:', code || msg);
      return { ok: false, reason: 'persist_failed' };
    } finally {
      if (client && typeof client.release === 'function') client.release();
    }
  }

  // -------------------------------------------------------------------------
  // Lobby helpers
  // -------------------------------------------------------------------------

  generateRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
  }

  // -------------------------------------------------------------------------
  // FixPack v2 / Commit 3 — AI Host ready quorum helpers.
  //
  // Public surface (used by ai_host_ready / ai_host_unready handlers):
  //   _computeAiReadyProgress(lobby) → progress payload
  //   _requiredReadyCount(lobby)     → integer threshold for "canStart"
  //   _aiHostGenerateAndStart(lobby) → server-side archive + ROLE_REVEAL
  // -------------------------------------------------------------------------

  /**
   * Quorum threshold:
   *   - 3 minimum (the user-spec "at least 3 players must press start")
   *   - In Custom Mode, the suspect count must ALSO equal config.playerCount.
   *     We surface that as a separate `customSeatGate` boolean so the UI
   *     can show a clearer message ("you need exactly 5 players first").
   */
  _requiredReadyCount(lobby) {
    return 3;
  }

  /**
   * Progress payload broadcast on every ready/unready toggle. All counts
   * only — no identities, no player ids, no usernames.
   */
  _computeAiReadyProgress(lobby) {
    const suspects = getSuspectPlayers(lobby);
    const required = this._requiredReadyCount(lobby);
    const minSuspects = required;

    // FixPack v3 / Hotfix — filter the ready Set against the CURRENT
    // real-suspect ids. A stale id (player who left, or a phantom write)
    // must not satisfy the quorum. We also opportunistically prune the
    // Set in place so subsequent reads are O(1).
    const validSuspectIds = new Set(suspects.map(p => p.id));
    if (lobby.aiReadyPlayers && lobby.aiReadyPlayers.size > 0) {
      for (const id of Array.from(lobby.aiReadyPlayers)) {
        if (!validSuspectIds.has(id)) lobby.aiReadyPlayers.delete(id);
      }
    }
    const ready = lobby.aiReadyPlayers ? lobby.aiReadyPlayers.size : 0;

    // Custom Mode: the suspect-seat gate must pass before quorum is even
    // meaningful. Use the existing validateCustomStartCount helper so the
    // copy stays consistent with finalize_archive.
    const startGate = validateCustomStartCount(lobby);
    const customSeatGate = startGate.ok;

    const enoughSuspects = suspects.length >= minSuspects;
    const enoughReady = ready >= required;
    const canStart = enoughSuspects && enoughReady && customSeatGate &&
                     !lobby.aiStartInProgress && lobby.state === 'LOBBY';

    return {
      ready,
      total: suspects.length,
      required,
      minSuspects,
      enoughSuspects,
      enoughReady,
      customSeatGate,
      customSeatError: customSeatGate ? null : (startGate.error || null),
      canStart,
      inProgress: !!lobby.aiStartInProgress,
    };
  }

  /**
   * Server-side AI archive generation + ROLE_REVEAL transition. Called once
   * per lobby after quorum is reached. Race-safe via lobby.aiStartInProgress.
   *
   * Privacy:
   *   - The generated archive flows through the same code path as
   *     finalize_archive (assignRoles + buildPrivateRoleCard + broadcast),
   *     so the existing privacy invariants (no gameRole on broadcast,
   *     private role cards per-socket only) all apply.
   *   - On failure: deterministic fallback (services/ai already returns one)
   *     so the game ALWAYS starts.
   */
  async _aiHostGenerateAndStart(lobby) {
    const roomId = lobby.id;
    try {
      const ai = getAi();
      if (!ai || typeof ai.generateSealedArchive !== 'function') {
        // No AI module — use the built-in deterministic fallback directly.
        // We still want the game to start.
        const fb = ai && ai._buildFallbackArchive
          ? ai._buildFallbackArchive(this._aiInputForLobby(lobby))
          : null;
        if (!fb) throw new Error('ai_module_unavailable');
        return this._aiHostFinalize(lobby, fb, 'fallback');
      }
      const aiInput = this._aiInputForLobby(lobby);
      const result = await ai.generateSealedArchive(aiInput);
      if (!result || !result.archive) {
        throw new Error('archive_missing');
      }
      return this._aiHostFinalize(lobby, result.archive, result.source || 'unknown');
    } catch (err) {
      console.warn('[ai-host] _aiHostGenerateAndStart failed:', err && err.message);
      lobby.aiStartInProgress = false;
      this.io.to(roomId).emit('ai_host_failed', {
        error: 'تعذّر بدء اللعبة. حاولوا تاني بعد لحظة.',
      });
    }
  }

  /**
   * Build the AI input payload from the lobby's config + state.
   */
  _aiInputForLobby(lobby) {
    const cfg = resolveLobbyConfig(lobby);
    return {
      idea: 'جريمة مشوقة في القاهرة الكلاسيكية',
      players: cfg.playerCount || getCurrentSuspectCount(lobby) || 5,
      mood: 'مكس',
      difficulty: 'متوسط',
      clueCount: cfg.clueCount,
      mafiozoCount: cfg.mafiozoCount,
    };
  }

  /**
   * Apply the generated archive to the lobby exactly the way the
   * finalize_archive socket handler does. Single point of mutation so
   * the AI Host path and Human Host path produce identical lobby shape.
   */
  _aiHostFinalize(lobby, archive, source) {
    const roomId = lobby.id;
    const cfg = resolveLobbyConfig(lobby);
    const expectedClueCount = cfg.clueCount;

    // Reuse the same archive shape the Human Host path produces.
    const eligible = getSuspectPlayers(lobby);
    const { roleAssignments, publicCharacterCards } = this.assignRoles(eligible, archive, cfg);

    // Resolve final clue list (same priority as finalize_archive).
    const archiveClues = Array.isArray(archive.clues) ? archive.clues : [];
    const finalClues = archiveClues.length === expectedClueCount
      ? archiveClues
      : Array.from({ length: expectedClueCount }, (_, i) => archiveClues[i] || `دليل ${i + 1}...`);

    // Encode archive for storage parity with the Human Host path.
    const archiveBase64 = Buffer.from(JSON.stringify(archive), 'utf8').toString('base64');

    lobby.state = 'IN_GAME';
    lobby.gameData = {
      archiveBase64,
      rawScenario: typeof archive.story === 'string' ? archive.story : '',
      decodedArchive: archive,
      clues: finalClues,
      clueIndex: 0,
      phase: 'ROLE_REVEAL',
      timer: 30,
      interval: null,
      isPaused: false,
      votes: {},
      roleRevealMode: lobby.roleRevealMode,
      roleAssignments,
      publicCharacterCards,
      votingHistory: [],
      eliminatedIds: [],
      outcome: null,
      lastVoteResult: null,
    };

    // Send each suspect their PRIVATE role card (same channel as Human Host).
    for (const card of Object.values(roleAssignments)) {
      const player = lobby.players.get(card.playerId);
      if (!player || !player.socketId) continue;
      this.io.to(player.socketId).emit('your_role_card', this.buildPrivateRoleCard(lobby, card));
    }

    // Broadcast public state + tell every client to navigate to /game/<roomId>.
    this.broadcastFullState(roomId);
    this.io.to(roomId).emit('game_started', { id: roomId });
    this.startRoomTimer(roomId);

    // Telemetry parity with finalize_archive.
    fireEvent({
      eventType: 'session.archive_sealed',
      userId: lobby.creatorId,
      gameId: roomId,
      payload: {
        archiveSource: typeof source === 'string' ? source : 'unknown',
        isCustom: !!cfg.isCustom,
        playerCount: Number.isFinite(cfg.playerCount) ? cfg.playerCount : null,
        mafiozoCount: Number.isFinite(cfg.mafiozoCount) ? cfg.mafiozoCount : null,
        clueCount: Number.isFinite(cfg.clueCount) ? cfg.clueCount : null,
      },
    });

    return { ok: true };
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

    // FixPack v3 / Hotfix — AI Host ready count sync.
    // The legacy code emitted ai_host_ready_progress only on
    // ai_host_ready / ai_host_unready, so a fresh client viewing a
    // room with N joined suspects would still see total=0 until
    // someone clicked the button. Broadcast the recomputed progress
    // on every roster change so the panel reflects reality.
    if (lobby.mode === 'AI' && lobby.state === 'LOBBY') {
      const progress = this._computeAiReadyProgress(lobby);
      this.io.to(roomId).emit('ai_host_ready_progress', progress);
    }
  }

  handleDisconnect(socket) {
    if (!socket || !socket.currentRoom) return;
    const lobby = this.lobbies.get(socket.currentRoom);
    if (!lobby) return;

    // FixPack v3 / Hotfix — drop the disconnected user from the AI ready
    // Set so a stale id can never satisfy the quorum. We deliberately
    // leave the player record itself in lobby.players so a reconnect can
    // resume seamlessly; only the volatile ready signal is cleaned up.
    if (lobby.mode === 'AI' && lobby.state === 'LOBBY' && socket.userId
        && lobby.aiReadyPlayers && lobby.aiReadyPlayers.has(socket.userId)) {
      lobby.aiReadyPlayers.delete(socket.userId);
      const progress = this._computeAiReadyProgress(lobby);
      this.io.to(lobby.id).emit('ai_host_ready_progress', progress);
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
    // FixPack v3 / Hotfix — embed ai-host ready progress so the room_update
    // event is a single source of truth on every roster change. Default
    // (Human Host) rooms get null so the field is always present.
    const aiHostReadyProgress = (lobby.mode === 'AI' && lobby.state === 'LOBBY')
      ? this._computeAiReadyProgress(lobby)
      : null;
    return {
      id: lobby.id,
      state: lobby.state,
      players: playersArr,
      mode: lobby.mode,
      roleRevealMode: lobby.roleRevealMode || 'normal',
      creatorId: lobby.creatorId,
      aiHostReadyProgress,
    };
  }
}

module.exports = GameManager;

// Test/diagnostic exports — module-level helpers exposed so tests can pin
// the player-count semantics without standing up a full socket server.
// NOT part of the production surface; do NOT import these from routes/.
module.exports._getRealPlayers = getRealPlayers;
module.exports._getHostPlayers = getHostPlayers;
module.exports._getSuspectPlayers = getSuspectPlayers;
module.exports._getCurrentSuspectCount = getCurrentSuspectCount;
module.exports._getCustomRequiredSuspectCount = getCustomRequiredSuspectCount;
module.exports._validateCustomStartCount = validateCustomStartCount;
module.exports._normalizeGameConfig = normalizeGameConfig;
module.exports._maxMafiozoForPlayerCount = maxMafiozoForPlayerCount;
// FixPack v3 / Hotfix — exposed so tests can pin the ready-progress
// payload shape without standing up a real socket server.
module.exports._computeAiReadyProgressOf = function(gm, lobby) {
  return gm._computeAiReadyProgress(lobby);
};
