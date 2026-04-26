/**
 * Postgres connection pool for Neon (or any Postgres).
 *
 * Exposes:
 *   pool          - the raw pg.Pool
 *   query(text,p) - parameterized query helper
 *   ready         - a promise that resolves once migrations have run
 *
 * The legacy `db.run` / `db.get` / `db.all` SQLite callbacks are gone —
 * call sites must now use `await query(...)` or `await pool.query(...)`.
 */
const { Pool } = require('pg');
const config = require('./config/env');
const { runMigrations } = require('./db/migrate');

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Neon requires SSL; setting rejectUnauthorized=false avoids needing the CA bundle.
  ssl: { rejectUnauthorized: false },
  // Free-tier sizing: keep the pool small so we don't exhaust Neon's connection cap.
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});

pool.on('error', (err) => {
  // Background errors on idle clients (e.g., Neon auto-suspend).
  // Don't crash — pg will discard the bad client and create a new one.
  console.error('⚠️  Postgres idle client error:', err.message);
});

async function query(text, params) {
  return pool.query(text, params);
}

// Boot-time: connect, run migrations, expose `ready` so server.js can await.
const ready = (async () => {
  // Neon may take 1–2s to wake from auto-suspend on the first request.
  // Try once, retry once on failure.
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const client = await pool.connect();
      await client.query('SELECT 1');
      client.release();
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
      console.warn(`⚠️  Postgres connect attempt ${attempt + 1} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 1500));
    }
  }
  if (lastErr) {
    console.error('❌ Could not connect to Postgres. Check DATABASE_URL.');
    throw lastErr;
  }

  console.log('✅ Connected to Postgres.');
  await runMigrations(pool);
})();

module.exports = { pool, query, ready };
