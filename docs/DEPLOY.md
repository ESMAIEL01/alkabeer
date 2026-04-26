# AlKabeer — Production Deployment Guide

This guide deploys the project to a fully public, free-tier production stack:

| Layer | Service | Free tier | Notes |
|---|---|---|---|
| Frontend | **Vercel** | Hobby | Default `*.vercel.app` domain |
| Backend  | **Fly.io** | Hobby (~3 shared VMs, 256 MB) | Frankfurt (`fra`) — best latency for Egypt |
| Database | **Neon Postgres** | 0.5 GB, auto-suspend | Already provisioned in Frankfurt |
| AI       | **Google Gemini** | Generous free tier | `gemini-2.5-pro` + `gemini-2.5-flash` |

After this guide a player on a phone in Cairo can open `https://alkabeer-prod.vercel.app`, register, and play with friends connected from anywhere.

> **Estimated time, first deploy:** ~30 minutes if accounts are already created. ~50 minutes from scratch.

---

## 0. Prerequisites

- **Node.js 20+** locally (`node -v`).
- **Git** + a GitHub account with this repo pushed.
- A **Neon** account → https://console.neon.tech
- A **Fly.io** account → https://fly.io  *(credit card required to verify, no charges on free tier).*
- A **Vercel** account → https://vercel.com
- A **Google AI Studio** account → https://aistudio.google.com/apikey

Install the Fly CLI:

```bash
# macOS / Linux:
curl -L https://fly.io/install.sh | sh
# Windows (PowerShell):
iwr https://fly.io/install.ps1 -useb | iex
flyctl auth login
```

---

## 1. Provision Neon Postgres

1. Sign in to https://console.neon.tech.
2. Create a project named **`alkabeer-prod`** in **AWS / EU Central 1 (Frankfurt)**.
3. After creation, open **Connection Details** → choose **"Pooled connection"** → copy the URL.
   Format:
   ```
   postgresql://neondb_owner:<PASSWORD>@ep-XXXXX-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require
   ```
4. Save this string somewhere safe. It is `DATABASE_URL`.

> The schema is created automatically on backend boot — you don't need to run anything in Neon's SQL editor.

---

## 2. Get a Gemini API key

1. Go to https://aistudio.google.com/apikey.
2. Click **Create API key** → choose / create a Google Cloud project.
3. Copy the key. **Never paste it into any file checked into git.**
4. Save it. It is `GEMINI_API_KEY`.

---

## 3. Generate a JWT secret

Generate a strong secret locally:

```bash
# Linux / macOS / Git Bash:
openssl rand -hex 64
# Windows PowerShell:
[Convert]::ToHexString([System.Security.Cryptography.RandomNumberGenerator]::GetBytes(64))
```

Copy the output. It is `JWT_SECRET`.

---

## 4. Local smoke test (optional but strongly recommended)

Before pushing to the cloud, confirm the backend boots against Neon.

```bash
cd backend
cp .env.example .env
# Edit .env and set: DATABASE_URL, GEMINI_API_KEY, JWT_SECRET
# Leave FRONTEND_URL=http://localhost:5173 for now.

npm install
npm run dev
```

You should see:

```
🔧 Environment: development
🔧 Frontend origin: http://localhost:5173
🔧 AI archive model: gemini-2.5-pro
✅ Connected to Postgres.
🗂  Applying migration: 001_init.sql
🗂  Migrations complete.
🚀 AlKabeer backend listening on 0.0.0.0:5000
```

In another shell:

```bash
curl http://localhost:5000/api/status
# {"status":"ok","env":"development","db":"up","ai":"configured", ...}
```

In a third shell run the frontend:

```bash
cd frontend
cp .env.example .env       # leaves VITE_API_URL=http://localhost:5000
npm install
npm run dev
# Open http://localhost:5173, register, create an AI room, start the game.
```

If everything works locally with Neon + Gemini, you are ready to deploy.

---

## 5. Deploy the backend to Fly.io

> **CAUTION:** When the Fly UI offers to deploy from a starter repo (e.g. `fly-apps/hello-fly`), **say no.** You want to deploy from your own repo.

From the repo root, run:

```bash
cd backend
flyctl launch --config fly.toml --no-deploy --copy-config --name alkabeer-prod --region fra
```

Answer the prompts:

- "Would you like to copy its configuration to the new app?" → **Yes** (it'll use the committed `fly.toml`).
- "Would you like to set up a Postgres database now?" → **No** (we use Neon).
- "Would you like to set up an Upstash Redis database now?" → **No**.
- "Create .dockerignore from .gitignore?" → **No** (we already have one).

Now set secrets (these become `process.env.*` inside the container):

```bash
flyctl secrets set \
  DATABASE_URL='postgresql://neondb_owner:<PASSWORD>@ep-XXXXX-pooler.eu-central-1.aws.neon.tech/neondb?sslmode=require' \
  GEMINI_API_KEY='<YOUR_GEMINI_KEY>' \
  JWT_SECRET='<YOUR_64_CHAR_HEX_SECRET>' \
  FRONTEND_URL='https://alkabeer-prod.vercel.app'
```

### Optional: OpenRouter fallback secrets

OpenRouter is a **secondary** AI fallback. Gemini stays primary. If you skip
this block the game still works — the provider chain becomes
`Gemini → built-in scenario`. Adding OpenRouter inserts an extra rung between
Gemini and the built-in fallback, which helps when Gemini briefly refuses a
mystery prompt or hits a quota.

**Honest caveats** before you wire it:

- The free OpenRouter model `nvidia/nemotron-3-super-120b-a12b:free` shares
  pooled rate limits with all free users. It may return 429 or 503 at peak
  times. Treat it as best-effort.
- Output is validated server-side before being accepted. If it fails the
  Arabic / structure / safety checks, the chain falls through to the
  built-in scenario.
- The OpenRouter key NEVER reaches the frontend — it lives in Fly secrets only.

```bash
flyctl secrets set \
  OPENROUTER_API_KEY='<YOUR_OPENROUTER_KEY>' \
  OPENROUTER_BASE_URL='https://openrouter.ai/api/v1' \
  OPENROUTER_FALLBACK_MODEL='nvidia/nemotron-3-super-120b-a12b:free' \
  OPENROUTER_TIMEOUT_MS='30000' \
  AI_FALLBACK_PROVIDER='openrouter'
```

> Set `AI_FALLBACK_PROVIDER` to anything other than `openrouter` (or leave it
> empty) to disable the fallback at runtime without removing the key.

> **Tip:** Quote each value in single quotes so your shell doesn't expand `$` characters from the password.

Deploy:

```bash
flyctl deploy
```

When the deploy finishes:

```bash
flyctl status
flyctl logs
curl https://alkabeer-prod.fly.dev/api/status
```

You should see `{"status":"ok","db":"up","ai":"configured"}`.

> **If the URL is different** (Fly may pick `alkabeer-prod-XXXX.fly.dev`), use whatever Fly prints. Update `FRONTEND_URL` and the Vercel env in the next steps to match.

---

## 6. Deploy the frontend to Vercel

1. Go to https://vercel.com/new.
2. Import the GitHub repo.
3. **Root Directory:** click "Edit" and set it to `frontend`.
4. **Framework Preset:** Vite (auto-detected).
5. **Environment Variables:** add a single one:
   - `VITE_API_URL` = `https://alkabeer-prod.fly.dev` *(use whatever Fly gave you)*
   - Apply to: **Production**, **Preview**, **Development** (all three).
6. Click **Deploy**.

Vercel will build and give you a URL like `https://alkabeer-prod.vercel.app`.

> **Important:** if you change `VITE_API_URL` later, you must trigger a new deploy from the Vercel dashboard. Vite inlines env vars at build time.

---

## 7. Reconnect the two halves

The backend's CORS allow-list reads `FRONTEND_URL`. If your final Vercel URL differs from the placeholder you set in step 5:

```bash
flyctl secrets set FRONTEND_URL='https://alkabeer-prod.vercel.app'
# Fly auto-restarts the app within ~30 seconds.
```

For Vercel preview URLs (`https://alkabeer-prod-git-feature-x.vercel.app`):

```bash
flyctl secrets set EXTRA_CORS_ORIGINS='https://alkabeer-prod-git-foo.vercel.app,https://alkabeer-prod-git-bar.vercel.app'
```

---

## 8. Verify from two devices in Egypt

**Device A (host)**:
1. Open `https://alkabeer-prod.vercel.app`.
2. Click **كضيف**, enter a name, submit.
3. Click **مضيف (بشري)**.
4. Note the room code (e.g. `M4F1A`).

**Device B (player) — different network, e.g. mobile data**:
1. Open the same URL OR scan the QR code from Device A.
2. Click **كضيف**, enter a name.
3. Paste the room code → **انضم للتحقيق**.

Both screens must update the player list in real time. If yes — Phase A is complete. 🎉

---

## 9. Optional: keep the backend warm

Free Fly machines can stop on idle even with `auto_stop_machines = "off"` if a CDN-level health probe fails. UptimeRobot catches this:

1. Sign up at https://uptimerobot.com (free).
2. Add a monitor:
   - Type: **HTTP(s)**
   - URL: `https://alkabeer-prod.fly.dev/api/status`
   - Interval: **5 minutes**

---

## 10. Rotation & secrets hygiene

| Secret | Where set | Rotation cadence |
|---|---|---|
| `DATABASE_URL` (Neon password) | Neon → Roles → Reset password → `flyctl secrets set …` | Every 90 days |
| `GEMINI_API_KEY` | AI Studio → Delete + Create → `flyctl secrets set …` | Every 90 days, **immediately** if exposed |
| `JWT_SECRET` | `openssl rand -hex 64` → `flyctl secrets set …` | Yearly (forces all sessions to log out) |

Never commit `.env`. The repo's `.gitignore` already excludes it, but always run `git status` before committing.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| Frontend shows "تعذّر الاتصال بالخادم" | `curl https://alkabeer-prod.fly.dev/api/status` — if it fails, `flyctl logs` for the cause. Most common: `FRONTEND_URL` doesn't match the Vercel domain → CORS rejects. |
| `db: down` in /api/status | Neon password rotated and `DATABASE_URL` is stale, or Neon is auto-suspended (wait 2s and retry). |
| AI always returns "fallback" source | Gemini failed AND (OpenRouter unconfigured OR also failed). `flyctl logs \| grep '\[ai\]'` shows which provider rejected. Common causes: missing/expired `GEMINI_API_KEY`, quota exhausted, or `AI_FALLBACK_PROVIDER` not set to `openrouter`. |
| AI returns "openrouter" source unexpectedly | Gemini is rejecting your prompts (often a content filter or quota). Check `flyctl logs \| grep '\[ai\] gemini'` for the reason. The game still works — this is the fallback chain doing its job. |
| 429 errors during testing | Rate limiter triggered — wait 60s or temporarily raise `AI_RATE_MAX` / `AUTH_RATE_MAX` in Fly secrets. |
| Vercel deploy succeeded but app talks to localhost:5000 | `VITE_API_URL` was missing during the build. Set it in Vercel → Settings → Env Vars and **redeploy**. |
| Socket.IO won't upgrade to WebSocket | This is fine — it'll fall back to polling. To force WS: `flyctl logs` should show `transport=websocket`. |

---

## 12. What's next (Phases B–F)

Phase A established the deployable foundation. Subsequent phases (specced separately):

- **B** — 3-scenario picker UI before game start.
- **C** — Game-loop completeness (role reveal, win conditions, archive decryption ceremony).
- **D** — Stitch design integration into the React pages.
- **E** — Auth & profile hardening (password reset, profile editing, stats).
- **F** — AI Host conversational mode (the three Custom GPT modes).
