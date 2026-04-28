/**
 * Hotfix — AI Host ready player count sync.
 *
 * Pinned guarantees:
 *   - _computeAiReadyProgress returns total = real suspect count
 *     (not 0) regardless of whether anyone has clicked ready yet.
 *   - Host is never counted as a suspect.
 *   - Phantom rows never inflate total.
 *   - aiReadyPlayers Set is filtered against current real-suspect ids
 *     (stale entries never satisfy the quorum).
 *   - canStart honours suspects + ready + customSeatGate + state.
 *   - getRoomPublicData embeds aiHostReadyProgress for AI lobbies and
 *     null for HUMAN lobbies.
 *   - Disconnect path drops the user from aiReadyPlayers and broadcasts
 *     a fresh progress payload (static-source pin — actual broadcast
 *     wired through the mock io captured here).
 *   - Custom seat gate failure surfaces both required and current
 *     counts in the error string (regression of the original bug).
 */
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const GameManager = require('../game/GameManager');
const {
  _computeAiReadyProgressOf,
} = require('../game/GameManager');

function makeMockIo() {
  const events = [];
  return {
    to(roomId) {
      return {
        emit(event, payload) { events.push({ roomId, event, payload }); },
      };
    },
    on() {},
    _events: events,
  };
}

function makeAiLobby({ suspectCount = 0, hostId = null, config = null,
                       phantomCount = 0, state = 'LOBBY',
                       aiStartInProgress = false } = {}) {
  const players = new Map();
  if (hostId !== null) {
    players.set(hostId, {
      id: hostId, username: `host_${hostId}`, socketId: 'sH',
      isHost: true, isAlive: true,
    });
  }
  for (let i = 0; i < suspectCount; i++) {
    const id = 1000 + i;
    players.set(id, {
      id, username: `S${i}`, socketId: `s${i}`,
      isHost: false, isAlive: true,
    });
  }
  for (let i = 0; i < phantomCount; i++) {
    players.set(`phantom_${i}`, { id: undefined, username: i % 2 === 0 ? undefined : `Ghost${i}` });
  }
  return {
    id: 'AIROOM', mode: 'AI',
    hostId, creatorId: hostId,
    state,
    players,
    config,
    aiReadyPlayers: new Set(),
    aiStartInProgress,
  };
}

// ---------------------------------------------------------------------------
// 1. Total count reflects real suspects on the very first call
// ---------------------------------------------------------------------------

test('HF.1 AI room with 3 suspects + 0 ready → total=3 not 0', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.total, 3, `total must reflect 3 real suspects: ${JSON.stringify(p)}`);
  assert.equal(p.ready, 0);
  assert.equal(p.required, 3);
  assert.equal(p.minSuspects, 3);
  assert.equal(p.enoughSuspects, true);
  assert.equal(p.enoughReady, false);
  assert.equal(p.customSeatGate, true);
  assert.equal(p.canStart, false);
});

test('HF.2 AI room with 3 suspects + 3 ready → canStart=true', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  // Mark all suspects ready.
  for (const p of lobby.players.values()) {
    if (!p.isHost) lobby.aiReadyPlayers.add(p.id);
  }
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.total, 3);
  assert.equal(p.ready, 3);
  assert.equal(p.canStart, true);
});

test('HF.3 Human host inside players Map is NOT counted in total', () => {
  const gm = new GameManager(makeMockIo(), null);
  // Synthesize a HUMAN-ish lobby: 1 host + 3 suspects, mode='AI' so the
  // helper is exercised. The host's isHost flag is the source of truth.
  const lobby = makeAiLobby({ hostId: 99, suspectCount: 3 });
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.total, 3, 'host must not be counted as a suspect');
});

test('HF.4 Phantom rows never inflate the suspect total', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3, phantomCount: 4 });
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.total, 3, 'phantom rows must not be counted');
});

// ---------------------------------------------------------------------------
// 2. Stale ready Set filtering
// ---------------------------------------------------------------------------

test('HF.5 stale ready ids are filtered out before quorum check', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  // Inject a stale id (player who left). The Set still has 3 entries
  // by count alone, but only 2 are valid suspects.
  const validIds = [...lobby.players.values()].filter(p => !p.isHost).map(p => p.id);
  lobby.aiReadyPlayers.add(validIds[0]);
  lobby.aiReadyPlayers.add(validIds[1]);
  lobby.aiReadyPlayers.add(99999);   // stale id — never existed
  gm.lobbies.set(lobby.id, lobby);

  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.ready, 2, `stale id must be dropped, got ready=${p.ready}`);
  assert.equal(lobby.aiReadyPlayers.has(99999), false,
    'stale id must be pruned from the live Set');
});

// ---------------------------------------------------------------------------
// 3. Custom seat gate
// ---------------------------------------------------------------------------

test('HF.6 custom playerCount=5 with 3 suspects → customSeatGate=false + helpful error', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({
    suspectCount: 3,
    config: { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 },
  });
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.customSeatGate, false);
  assert.ok(p.customSeatError, 'error must be present');
  // Error must mention BOTH the required (5) and current (3) counts.
  assert.ok(p.customSeatError.includes('5'), `error must include "5": ${p.customSeatError}`);
  assert.ok(p.customSeatError.includes('3'), `error must include "3": ${p.customSeatError}`);
  assert.equal(p.canStart, false);
});

test('HF.7 custom playerCount=5 with 5 suspects + 3 ready → canStart=true', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({
    suspectCount: 5,
    config: { isCustom: true, playerCount: 5, mafiozoCount: 2, clueCount: 4 },
  });
  const validIds = [...lobby.players.values()].filter(p => !p.isHost).map(p => p.id);
  for (let i = 0; i < 3; i++) lobby.aiReadyPlayers.add(validIds[i]);
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.total, 5);
  assert.equal(p.ready, 3);
  assert.equal(p.customSeatGate, true);
  assert.equal(p.canStart, true);
});

// ---------------------------------------------------------------------------
// 4. State + race-lock gates
// ---------------------------------------------------------------------------

test('HF.8 canStart=false while aiStartInProgress is true (race lock)', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({
    suspectCount: 3, aiStartInProgress: true,
  });
  for (const p of lobby.players.values()) {
    if (!p.isHost) lobby.aiReadyPlayers.add(p.id);
  }
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.inProgress, true);
  assert.equal(p.canStart, false);
});

test('HF.9 canStart=false once state moves out of LOBBY', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({
    suspectCount: 3, state: 'IN_GAME',
  });
  for (const p of lobby.players.values()) {
    if (!p.isHost) lobby.aiReadyPlayers.add(p.id);
  }
  gm.lobbies.set(lobby.id, lobby);
  const p = _computeAiReadyProgressOf(gm, lobby);
  assert.equal(p.canStart, false);
});

// ---------------------------------------------------------------------------
// 5. getRoomPublicData embeds aiHostReadyProgress for AI lobbies
// ---------------------------------------------------------------------------

test('HF.10 getRoomPublicData includes aiHostReadyProgress for AI rooms', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3 });
  gm.lobbies.set(lobby.id, lobby);
  const data = gm.getRoomPublicData(lobby.id);
  assert.ok(data, 'public data must be built');
  assert.ok('aiHostReadyProgress' in data,
    'aiHostReadyProgress key must exist on AI room public data');
  assert.ok(data.aiHostReadyProgress);
  assert.equal(data.aiHostReadyProgress.total, 3);
  assert.equal(data.aiHostReadyProgress.ready, 0);
});

test('HF.11 getRoomPublicData returns aiHostReadyProgress=null for HUMAN rooms', () => {
  const gm = new GameManager(makeMockIo(), null);
  // Human-host shape: mode='HUMAN', hostId=999, 3 suspects.
  const players = new Map();
  players.set(999, { id: 999, username: 'host', socketId: 'sH', isHost: true, isAlive: true });
  for (let i = 0; i < 3; i++) {
    players.set(1000 + i, { id: 1000 + i, username: `P${i}`, socketId: `s${i}`,
      isHost: false, isAlive: true });
  }
  const lobby = {
    id: 'HUMANROOM', mode: 'HUMAN', hostId: 999, creatorId: 999,
    state: 'LOBBY', players, config: null,
  };
  gm.lobbies.set(lobby.id, lobby);
  const data = gm.getRoomPublicData(lobby.id);
  assert.ok(data);
  assert.equal(data.aiHostReadyProgress, null,
    'HUMAN rooms must carry aiHostReadyProgress=null');
});

test('HF.12 getRoomPublicData returns aiHostReadyProgress=null once AI room moves out of LOBBY', () => {
  const gm = new GameManager(makeMockIo(), null);
  const lobby = makeAiLobby({ suspectCount: 3, state: 'IN_GAME' });
  gm.lobbies.set(lobby.id, lobby);
  const data = gm.getRoomPublicData(lobby.id);
  assert.equal(data.aiHostReadyProgress, null,
    'in-game AI rooms must not surface ready progress (no longer relevant)');
});

// ---------------------------------------------------------------------------
// 6. Static-source: joinRoom and handleDisconnect emit progress for AI rooms
// ---------------------------------------------------------------------------

test('HF.13 joinRoom emits ai_host_ready_progress for AI lobbies (static source)', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'game', 'GameManager.js'),
    'utf8'
  );
  // Locate the joinRoom body and confirm the AI-room broadcast is present.
  const idx = text.indexOf('joinRoom(socket, roomId, isHost = false)');
  assert.ok(idx > 0, 'joinRoom must be defined');
  const body = text.slice(idx, idx + 2200);
  assert.match(body, /lobby\.mode\s*===\s*['"]AI['"]/);
  assert.match(body, /this\._computeAiReadyProgress\(lobby\)/);
  assert.match(body, /emit\(\s*['"]ai_host_ready_progress['"]/);
});

test('HF.14 handleDisconnect drops the user from aiReadyPlayers and re-broadcasts', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', 'game', 'GameManager.js'),
    'utf8'
  );
  // Match the METHOD DEFINITION (line-anchored, two spaces of class
  // indent), not the call-site `this.handleDisconnect(socket);`.
  const idx = text.indexOf('\n  handleDisconnect(socket)');
  assert.ok(idx > 0, 'handleDisconnect method must be defined');
  // The method body ends at the next top-level method (two-space + word).
  const tail = text.slice(idx + 1);
  const nextMethodIdx = tail.search(/\n  [a-zA-Z_]/g) + 1;
  // Slice only up to the next class member start to avoid grabbing the
  // whole rest of the file.
  const body = tail.slice(0, nextMethodIdx > 0 ? nextMethodIdx : 1500);
  assert.match(body, /aiReadyPlayers\.delete\(\s*socket\.userId\s*\)/);
  assert.match(body, /emit\(\s*['"]ai_host_ready_progress['"]/);
});

// ---------------------------------------------------------------------------
// 7. Frontend panel never shows "الموجود: 0" when suspects are visible
// ---------------------------------------------------------------------------

test('HF.15 frontend AiHostReadyPanel uses visibleSuspectCount fallback for total', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'LobbyPage.jsx'),
    'utf8'
  );
  // The panel signature must accept visibleSuspectCount.
  assert.match(text, /function AiHostReadyPanel\(\{[^}]*visibleSuspectCount/);
  // The `total` calculation must take Math.max of backendTotal and
  // visibleTotal — direct line-level pin.
  assert.match(text, /Math\.max\(backendTotal,\s*visibleTotal\)/);
  // The misleading old copy must be GONE — no more "(الموجود: 0)" template
  // that always renders 0 when progress is null.
  assert.equal(/\(الموجود: \$\{total\}\)/.test(text), false,
    'old "(الموجود: ${total})" copy must be replaced');
  // The new copy includes "الموجود الآن:" — the spec wording.
  assert.match(text, /الموجود الآن:/);
});

test('HF.16 LobbyPage passes visibleSuspectCount derived from real non-host players', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'LobbyPage.jsx'),
    'utf8'
  );
  // The prop must be computed from players.filter(p => ... && !p.isHost).
  assert.match(text,
    /visibleSuspectCount=\{players\.filter\([^)]*!p\.isHost[^)]*\)\.length\}/);
});

test('HF.17 LobbyPage room_update consumes embedded aiHostReadyProgress', () => {
  const text = fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'frontend', 'src', 'pages', 'LobbyPage.jsx'),
    'utf8'
  );
  // The room_update handler must apply data.aiHostReadyProgress when
  // present so the panel sees the count without waiting for an explicit
  // ai_host_ready_progress event.
  const idx = text.indexOf("socket.on('room_update'");
  assert.ok(idx > 0);
  const body = text.slice(idx, idx + 800);
  assert.match(body, /aiHostReadyProgress/);
  assert.match(body, /setAiReadyProgress/);
});
