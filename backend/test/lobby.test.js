/**
 * Lobby / phantom-player regression tests.
 *
 * Pins the contract added in Commit 6e:
 *   - joinRoom REJECTS any socket without authenticated userId+username
 *   - lobby.players never contains an entry keyed by undefined
 *   - buildPublicState.players defensively filters phantom rows even if
 *     one somehow got injected
 *   - getRoomPublicData reports only real players
 *
 * Tests use a synthetic socket — minimal subset of the real Socket.IO
 * API surface (id, userId, username, join, emit). No real Socket.IO
 * server, no DB, no network.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const GameManager = require('../game/GameManager');

function makeMockIo() {
  const events = [];
  return {
    to() { return { emit(event, payload) { events.push({ event, payload }); } }; },
    on() {},
    _events: events,
  };
}

/**
 * Mock socket. Real Socket.IO sockets carry a lot more — we only model
 * the fields GameManager.joinRoom actually touches:
 *   id          — used as socketId on the player record
 *   userId      — set by 'authenticate' handler in production
 *   username    — set by 'authenticate' handler in production
 *   join(room)  — called inside joinRoom on success
 *   emit(...)   — called inside joinRoom on rejection
 *   currentRoom — written inside joinRoom on success
 */
function makeMockSocket({ id = 'sock_x', userId, username } = {}) {
  const emits = [];
  return {
    id,
    userId,
    username,
    rooms: new Set(),
    join(roomId) { this.rooms.add(roomId); },
    emit(event, payload) { emits.push({ event, payload }); },
    _emits: emits,
  };
}

function setupEmptyLobby(gm, opts = {}) {
  const lobby = {
    id: 'ROOMX',
    creatorId: 101,
    hostId: opts.hostId || 101,
    mode: opts.mode || 'AI',
    roleRevealMode: 'normal',
    state: 'LOBBY',
    players: new Map(),
    gameData: null,
  };
  gm.lobbies.set('ROOMX', lobby);
  return lobby;
}

// ---------------------------------------------------------------------------

test('1. Unauthenticated socket cannot create a phantom player', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = setupEmptyLobby(gm);

  // No userId, no username — exactly what an un-authenticate'd socket looks like.
  const socket = makeMockSocket({});
  gm.joinRoom(socket, 'ROOMX', false);

  assert.equal(lobby.players.size, 0, 'lobby must remain empty');
  // Refusal is communicated to THIS socket only, not broadcast.
  const rej = socket._emits.find(e => e.event === 'join_rejected');
  assert.ok(rej, 'join_rejected emitted to the unauthenticated socket');
  assert.equal(rej.payload.reason, 'unauthenticated');
  // No room_update fired — broadcast never happened.
  assert.equal(io._events.find(e => e.event === 'room_update'), undefined,
    'no room_update broadcast for an unauthenticated rejection');
});

test('2. joinRoom with undefined userId or undefined username does not add a player', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = setupEmptyLobby(gm);

  // Half-authenticated: userId set but no username.
  const sA = makeMockSocket({ id: 'sA', userId: 42, username: undefined });
  gm.joinRoom(sA, 'ROOMX', false);
  assert.equal(lobby.players.size, 0, 'half-auth must be refused');

  // Half-authenticated: username set but no userId.
  const sB = makeMockSocket({ id: 'sB', userId: undefined, username: 'no_id' });
  gm.joinRoom(sB, 'ROOMX', false);
  assert.equal(lobby.players.size, 0, 'half-auth (no userId) must be refused');

  // The phantom Map slot specifically must not exist.
  assert.equal(lobby.players.has(undefined), false,
    'lobby.players[undefined] must never appear');
});

test('3. Valid authenticated user appears in room_update broadcast', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = setupEmptyLobby(gm);

  const socket = makeMockSocket({ id: 'sA', userId: 202, username: 'A' });
  gm.joinRoom(socket, 'ROOMX', false);

  assert.equal(lobby.players.size, 1, 'one valid join, one player');
  assert.equal(lobby.players.get(202).username, 'A');
  assert.equal(lobby.players.get(202).socketId, 'sA');
  assert.equal(lobby.players.get(202).isHost, false);
  assert.equal(lobby.players.get(202).isAlive, true);
  assert.equal(socket.currentRoom, 'ROOMX');
  assert.ok(socket.rooms.has('ROOMX'), 'socket.io join("ROOMX") was called');

  const update = io._events.find(e => e.event === 'room_update');
  assert.ok(update, 'room_update emitted');
  const rosterIds = update.payload.players.map(p => p.id);
  assert.deepEqual(rosterIds, [202]);
  assert.equal(update.payload.players[0].username, 'A');
});

test('4. buildPublicState.players filters phantom/malformed rows even if injected', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  const lobby = setupEmptyLobby(gm);

  // One real player + one direct phantom injection. The defensive filter
  // in buildPublicState must drop the phantom regardless.
  lobby.players.set(202, { id: 202, username: 'A', socketId: 's1', isHost: false, isAlive: true });
  lobby.players.set('phantom', { id: undefined, username: undefined, isHost: false, isAlive: true });
  lobby.gameData = {
    phase: 'LOBBY', timer: 0, archiveBase64: '', clues: [], clueIndex: 0,
    publicCharacterCards: [], eliminatedIds: [], lastVoteResult: null, outcome: null,
  };

  const state = gm.buildPublicState('ROOMX');
  const ids = state.players.map(p => p.id);
  assert.deepEqual(ids, [202], 'phantom must be filtered out of broadcast');
  // Defense in depth: getRoomPublicData should also filter.
  const room = gm.getRoomPublicData('ROOMX');
  assert.equal(room.players.length, 1);
  assert.equal(room.players[0].id, 202);
});

test('5. Roster count equals real users only across mixed join attempts', () => {
  const io = makeMockIo();
  const gm = new GameManager(io, null);
  // Use HUMAN mode so the host slot is real (in AI mode the host is virtual
  // and is intentionally NOT inserted into lobby.players).
  const lobby = setupEmptyLobby(gm, { mode: 'HUMAN' });

  // 3 valid, 2 unauthenticated.
  gm.joinRoom(makeMockSocket({ id: 's1', userId: 101, username: 'host' }), 'ROOMX', true);
  gm.joinRoom(makeMockSocket({ id: 's2', userId: 202, username: 'A' }),    'ROOMX', false);
  gm.joinRoom(makeMockSocket({ id: 's3', userId: 303, username: 'B' }),    'ROOMX', false);
  gm.joinRoom(makeMockSocket({ id: 's4' /* unauth */ }),                   'ROOMX', false);
  gm.joinRoom(makeMockSocket({ id: 's5', userId: undefined, username: 'x' }), 'ROOMX', false);

  assert.equal(lobby.players.size, 3, 'unauth attempts must not add players');
  // Public roster also matches.
  const room = gm.getRoomPublicData('ROOMX');
  assert.equal(room.players.length, 3);
  const ids = room.players.map(p => p.id).sort();
  assert.deepEqual(ids, [101, 202, 303]);
});
