/**
 * Central REST client for the AlKabeer frontend.
 *
 * Single place that knows the backend URL, attaches the JWT, and normalizes
 * errors so every page can just `await api.post('/api/auth/login', body)`.
 */

// Vite inlines import.meta.env.* at build time. Throw loudly if it's missing
// in production so we don't silently default to localhost.
const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:5000';

if (import.meta.env.PROD && !import.meta.env.VITE_API_URL) {
  // Surface in the browser console immediately on production builds.
  // eslint-disable-next-line no-console
  console.error(
    '[Mafiozo] VITE_API_URL is not set on this production build. ' +
    'Set it in Vercel → Project → Settings → Environment Variables, then redeploy.'
  );
}

export const apiUrl = API_URL;

const TOKEN_KEY = 'mafToken';
const USER_KEY = 'mafUser';

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

export function getStoredUser() {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setSession({ token, user }) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  if (user) localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

class ApiError extends Error {
  constructor(message, status, payload) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.payload = payload;
  }
}

async function request(path, { method = 'GET', body, signal, headers = {} } = {}) {
  const token = getToken();
  const finalHeaders = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  };

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: finalHeaders,
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (networkErr) {
    throw new ApiError('تعذّر الاتصال بالخادم. اتأكد من الإنترنت.', 0, { cause: networkErr.message });
  }

  let payload = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try { payload = await res.json(); } catch { /* ignore */ }
  } else {
    payload = { raw: await res.text().catch(() => '') };
  }

  if (!res.ok) {
    const message =
      (payload && (payload.error || payload.message)) ||
      `طلب فشل (${res.status}).`;
    if (res.status === 401) {
      // Token rejected — clear so AuthPage re-prompts.
      clearSession();
    }
    throw new ApiError(message, res.status, payload);
  }
  return payload;
}

export const api = {
  url: API_URL,
  get: (path, opts) => request(path, { ...opts, method: 'GET' }),
  post: (path, body, opts) => request(path, { ...opts, method: 'POST', body }),
  put: (path, body, opts) => request(path, { ...opts, method: 'PUT', body }),
  del: (path, opts) => request(path, { ...opts, method: 'DELETE' }),
};

// Health check — used by App boot for an "offline" banner if backend is cold.
export async function pingBackend() {
  try {
    const data = await api.get('/api/status');
    return { ok: true, ...data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export { ApiError };
