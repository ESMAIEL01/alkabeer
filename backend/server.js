/**
 * AlKabeer backend entry point.
 *
 * Boots in this order:
 *   1. Validate env (config/env.js throws if anything is missing).
 *   2. Connect to Postgres + run migrations (database.js exposes a `ready` promise).
 *   3. Build Express + Socket.IO with production CORS, helmet, trust proxy.
 *   4. Wire routes + rate limiters + global error handler.
 *   5. Start listening on PORT (Fly.io expects 0.0.0.0).
 */
const config = require('./config/env');           // must be first — validates env.

const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const { Server } = require('socket.io');

const db = require('./database');
const authRoutes = require('./routes/auth');
const scenarioRoutes = require('./routes/scenarios');
const { authLimiter, aiLimiter } = require('./middleware/rateLimit');
const GameManager = require('./game/GameManager');

// --- CORS allow-list ------------------------------------------------------
// In production we only allow the deployed frontend.
// In development we additionally allow Vite's default dev server.
const allowedOrigins = new Set([
  config.frontendUrl,
  ...config.extraCorsOrigins,
]);
if (!config.isProd) {
  allowedOrigins.add('http://localhost:5173');
  allowedOrigins.add('http://localhost:5174');
  allowedOrigins.add('http://127.0.0.1:5173');
}

function corsOriginCheck(origin, callback) {
  // Allow same-origin / curl / mobile webviews (no Origin header).
  if (!origin) return callback(null, true);
  if (allowedOrigins.has(origin)) return callback(null, true);
  return callback(new Error(`Origin ${origin} not allowed by CORS`));
}

// --- Express setup --------------------------------------------------------
const app = express();
const server = http.createServer(app);

// Fly.io and Vercel both sit behind a proxy. Trust X-Forwarded-* so req.ip
// and rate-limiting see the real client IP, not the load balancer.
app.set('trust proxy', 1);

app.use(helmet({
  // We're a JSON API; CSP enforcement happens on the frontend host (Vercel).
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));
app.use(cors({ origin: corsOriginCheck, credentials: false }));
app.use(express.json({ limit: '64kb' }));

// --- Health check ---------------------------------------------------------
// Returns 200 once Postgres is reachable. Used by Fly.io health probes,
// UptimeRobot keep-warm, and the frontend's bootstrap check.
app.get('/api/status', async (_req, res) => {
  let dbHealthy = false;
  try {
    await db.query('SELECT 1');
    dbHealthy = true;
  } catch {
    dbHealthy = false;
  }
  res.status(dbHealthy ? 200 : 503).json({
    status: dbHealthy ? 'ok' : 'degraded',
    env: config.nodeEnv,
    db: dbHealthy ? 'up' : 'down',
    ai: config.gemini.apiKey ? 'configured' : 'fallback-only',
    time: new Date().toISOString(),
  });
});

// --- Routes ---------------------------------------------------------------
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/scenarios', aiLimiter, scenarioRoutes);

// 404 for unknown API routes
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint not found.' });
});

// --- Socket.IO ------------------------------------------------------------
const io = new Server(server, {
  cors: { origin: corsOriginCheck, methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

new GameManager(io, db);

// --- Global error handler -------------------------------------------------
// Always JSON. Never leak stack traces to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  console.error(`[${req.method} ${req.originalUrl}]`, err);
  if (err && err.message && err.message.startsWith('Origin ')) {
    return res.status(403).json({ error: 'CORS: origin not allowed.' });
  }
  res.status(500).json({ error: 'حصل خطأ غير متوقع. جرب تاني.' });
});

// --- Start ----------------------------------------------------------------
async function start() {
  try {
    await db.ready;
  } catch (err) {
    console.error('❌ Boot aborted: database not ready.', err.message);
    process.exit(1);
  }

  // 0.0.0.0 is required so Fly.io's load balancer can reach us.
  server.listen(config.port, '0.0.0.0', () => {
    console.log(`🚀 Mafiozo backend listening on 0.0.0.0:${config.port}`);
    console.log(`🌐 Allowed origins: ${[...allowedOrigins].join(', ') || '(none)'}`);
  });
}

// Graceful shutdown so Fly's rolling deploys close sockets cleanly.
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down.`);
  io.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start();
