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
