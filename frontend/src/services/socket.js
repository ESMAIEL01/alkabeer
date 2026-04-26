import { io } from 'socket.io-client';
import { apiUrl } from './api';

/**
 * Socket.IO client.
 *
 * Connects to the same origin used by the REST API (VITE_API_URL).
 * `autoConnect: false` — we connect explicitly via connectSocket() once we
 * have a JWT, so the server's `authenticate` event has data on first arrival.
 */
export const socket = io(apiUrl, {
  autoConnect: false,
  transports: ['websocket', 'polling'],
  reconnection: true,
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
  reconnectionDelayMax: 10_000,
  timeout: 20_000,
});

let _isConnecting = false;

export function connectSocket(token, user) {
  if (!token || !user) return;
  if (socket.connected || _isConnecting) return;
  _isConnecting = true;

  // Re-authenticate every time the socket (re)connects so reconnects after a
  // mobile network blip restore the user binding on the server side.
  const onConnect = () => {
    socket.emit('authenticate', { token, user });
    // If we already had an active room, rejoin it after reconnect so the
    // server's room membership is restored. Use a callback to avoid stalls.
    const roomId = getActiveRoomId();
    if (roomId) {
      socket.emit('join_room', { roomId }, () => { /* best-effort */ });
    }
  };
  socket.off('connect', onConnect);
  socket.on('connect', onConnect);

  socket.once('connect_error', (err) => {
    console.warn('[socket] connect_error:', err && err.message);
  });

  socket.connect();
  _isConnecting = false;
}

export function disconnectSocket() {
  if (socket.connected) socket.disconnect();
}

// ---------------------------------------------------------------------------
// Active room tracking — single source of truth on the client.
//
// Lives in sessionStorage (per-tab) so a refresh on /game/:roomId can rejoin,
// but a second tab/incognito session represents a different player.
// ---------------------------------------------------------------------------
const ACTIVE_ROOM_KEY = 'mafActiveRoom';

export function setActiveRoomId(roomId) {
  if (!roomId) return;
  try { sessionStorage.setItem(ACTIVE_ROOM_KEY, String(roomId)); } catch { /* ignore */ }
}

export function getActiveRoomId() {
  try { return sessionStorage.getItem(ACTIVE_ROOM_KEY) || null; } catch { return null; }
}

export function clearActiveRoomId() {
  try { sessionStorage.removeItem(ACTIVE_ROOM_KEY); } catch { /* ignore */ }
}

/**
 * Promise-based wrapper around socket.emit with a Socket.IO acknowledgement
 * callback. Resolves with the server's ack payload, rejects on timeout.
 *
 * Usage:
 *   const result = await emitWithAck('finalize_archive', { roomId, archive }, 8000);
 */
export function emitWithAck(event, payload, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('socket-ack-timeout'));
    }, timeoutMs);

    try {
      socket.emit(event, payload, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(response);
      });
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    }
  });
}
