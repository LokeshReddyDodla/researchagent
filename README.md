# Research Agent — Frontend

Minimal Vite + React + TypeScript SPA that talks to the cohort research agent in `aihealth-server`.

Two screens:

- **Login** — care-provider **phone + OTP** flow:
  1. Enter phone number → `POST /v1/auth/send-otp`. The aihealth-server's dev mode also echoes the OTP back in the success message, so a tester sees it without checking SMS / logs.
  2. Enter the OTP → `POST /v1/auth/verify-otp?role=care_provider`. Receives a JWT, which is stored in `localStorage` and reused across reloads.
- **Chat** — paste patient UUIDs into the cohort field, ask a question, get a live SSE-streamed answer with funnel narration, intent, tool calls, and final cost / latency metadata.

The chat surface speaks the same SSE event types the foundation emits (`status`, `intent`, `tool_call`, `tool_result`, `funnel_step`, `token`, `done`, `error`).

## Run it

```bash
cd ~/Desktop/researchagent

# 1. Install
npm install

# 2. Point at your aihealth-server (default is http://localhost:8000)
cp .env.example .env.local
# edit .env.local if your server runs elsewhere

# 3. Start the dev server
npm run dev
# → http://localhost:5173
```

Make sure the aihealth-server is running and reachable at `VITE_API_BASE_URL`. Sign in with a care-provider account, paste a few patient UUIDs into the cohort field, and ask:

> *How many of these patients had a hypo event this week?*

> *Who has hypo events AND less than 6 hours of sleep this week?*

> *Find my piles patients.*

## How CORS is handled

The browser only ever talks to `http://localhost:5173` (Vite). Vite proxies `/v1/*`, `/docs`, and `/openapi.json` to the backend server-to-server, so the browser never makes a cross-origin request and no preflight ever happens. This is the project-sanctioned approach — `aihealth-server`'s `CLAUDE.md` forbids adding new CORS origins to `middleware_setup.py`.

Configuration:

- `VITE_API_PROXY_TARGET` — where Vite forwards (default `http://localhost:8000`).
- `VITE_API_BASE_URL` — leave empty for proxied dev. Set to e.g. `https://api.example.com` only when bypassing the proxy (production builds or staging).

## File layout

```
researchagent/
├── index.html
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tsconfig.node.json
├── .env.example
├── README.md
└── src/
    ├── main.tsx        — bootstrap
    ├── App.tsx         — top-level auth gate
    ├── LoginPage.tsx   — care-provider email/password
    ├── ChatPage.tsx    — cohort input + streamed transcript
    ├── api.ts          — login + SSE streaming helper
    └── styles.css
```

## How the SSE streaming works

The server uses **POST + Server-Sent Events**, which the browser's `EventSource` API can't handle (it only supports GET). So `streamResearchQuery` in `src/api.ts` uses the fetch API + a manual SSE parser over the `ReadableStream` body. It yields parsed `{event, data}` records as they arrive; the chat page renders each event type with its own visual treatment.

## Phase 1 limits inherited from the agent

These are honest, intended limits — the agent surfaces them in its responses too:

- `cohort.kind` is **ids only**. `saved` cohorts and `panel` ("my whole panel") return 501 until Phase 2.
- **Ranking** (`rank` intent) returns a "not implemented yet" message until the daily scorecard scan ships.
- **Deep dive** (`research` intent) returns a "not implemented yet" message until the Anthropic Batches wrapper lands in the gateway.

You can read the full plan and architecture at:
- `aihealth-server/docs/internal/research_agent_plan.md`
- `aihealth-server/docs/internal/research_agent_architecture.md`
