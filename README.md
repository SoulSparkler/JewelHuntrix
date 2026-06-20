# JewelHuntrix

Monitors the Vinted catalog for undervalued jewellery (gold / silver / pearls /
diamonds / signed vintage / …), pre-scores listing photos with AI, and sends the
promising ones to the owner via Telegram.

## Architecture (serverless on Netlify)

| Part | Where | What |
| --- | --- | --- |
| Dashboard (React/Vite) | Netlify static (`client/dist`) | Manage searches, view findings |
| Scan + AI pipeline | Netlify Scheduled Function `netlify/functions/scan.mts` | Runs every 2h (cron), serverless |
| Daily heartbeat | Netlify Scheduled Function `netlify/functions/health-ping.mts` | Telegram "still alive" ping |
| Dashboard API | Netlify Function `netlify/functions/api.mts` | Express via `serverless-http`, `/api/*` |
| Data | Postgres (Supabase pooler / Neon) | searches, findings, `scan_state` |

There is **no always-on server and no headless browser**. Vinted's public
catalog is read over plain HTTP (`server/lib/vinted.ts`) using a fresh anonymous
session per scan — so there is no long-lived login that can "drop". **Region is
NL by design** (`VINTED_BASE_URL=https://www.vinted.nl`); Vinted's cross-border
listings already surface NL/FR/DE/BE/IE/… results, and the seller's country is
shown in each Telegram alert.

## AI model routing (OpenRouter)

All AI goes through one OpenRouter client (`server/lib/openrouter.ts`) with two
**independently configurable** models:

| Task | Function | Env var | Example |
| --- | --- | --- | --- |
| Vision scoring of photos | `scoreListingImages` | `VISION_MODEL_ID` | `openai/gpt-4o`, `anthropic/claude-sonnet-4`, `google/gemini-2.0-flash` |
| Telegram message text | `generateAlertMessage` | `MESSAGE_MODEL_ID` | `openai/gpt-4o-mini` |

**To swap a model:** change the env var in Netlify → Environment variables and
redeploy. No code change. The vision model returns a strict pre-filter score
(`{score 1-10, reasoning, flags, confidence}`) and is prompted to **never** claim
an item "is real" — it only flags what's worth a closer human look. Every call
logs the model used and an estimated token cost (`💸 [AI …]` lines).

## Setup

1. `npm install` (root) and `cd client && npm install`.
2. Copy `.env.example` → `.env`, fill in values (see table below).
3. Apply DB schema: `npm run db:push` (or run `migrations/0001_serverless_scanstate.sql`).
4. Local dev: `npm run dev` (set `ENABLE_INPROCESS_SCHEDULER=true` to scan locally).

### Required env vars (set in Netlify, never commit)

`DATABASE_URL` (pooled), `OPENROUTER_API_KEY`, `VISION_MODEL_ID`,
`MESSAGE_MODEL_ID`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`. Optional:
`VINTED_BASE_URL` (default `https://www.vinted.nl`), `VISION_SCORE_THRESHOLD`
(default 7), `SCAN_CRON`, `HEALTH_CRON`.

## Reliability

- Scan failures (Vinted block, network, DB) send a Telegram alert and are
  recorded in `scan_state`; nothing fails silently.
- `GET /.netlify/functions/health-ping` (and `GET /api/health`) return last run,
  last success, listings checked, and consecutive failures.
- Retention: expired findings + analyzed-listing rows older than 30 days are
  cleaned up on every run.

## Manual triggers

- Full scan now: `POST /api/scan` or `GET /.netlify/functions/scan`.
- Single listing: `POST /api/analyze-listing { "url": "https://www.vinted.nl/items/…" }`.
