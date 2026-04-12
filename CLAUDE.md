# Realtime Translate

## Overview

Real-time speech translation desktop app. Captures two audio streams (microphone + system audio), sends each directly to a Gemini Live API WebSocket session for translation, and displays translated subtitles in an always-on-top Electron overlay.

## Architecture

```
Desktop (Electron)
├── Renderer: mic capture (AudioWorklet → 16kHz PCM) + overlay UI
├── Main Process:
│   ├── GeminiSessionManager — orchestrates two Gemini Live sessions
│   │   ├── Session "YOU": mic audio → translate to foreign language
│   │   └── Session "THEM": system audio → translate to your language
│   ├── SystemAudioCapture — cross-platform system audio capture
│   └── TokenServiceClient — HTTPS calls to CF Worker for ephemeral tokens
│
CF Worker (Hono on Cloudflare Workers)
├── POST /api/token — verify Supabase JWT, check usage limits, generate Gemini ephemeral token
├── GET /health
└── Durable Object — per-user usage tracking (tokens issued, active time)
```

Audio goes **desktop → Gemini directly** (one WebSocket hop). The CF Worker never sees audio — it only handles auth and token generation.

## Monorepo Structure

- `apps/desktop` — Electron app (Electron Forge + Vite)
- `apps/proxy` — Cloudflare Worker (Hono + Durable Objects)
- `apps/web` — React web app (browser test harness, mic only)
- `packages/shared` — TypeScript types, protocol, constants, conversation queue

## Tech Stack

- **Language**: TypeScript throughout
- **Desktop**: Electron 41 + Electron Forge + Vite
- **Proxy**: Hono on Cloudflare Workers, jose for JWT, zod for validation
- **Auth**: Supabase (email/password, JWT verification via JWKS)
- **Translation**: Gemini Live API (WebSocket, model: `gemini-2.5-flash-native-audio-preview`)
- **Build**: Turborepo + npm workspaces
- **Design System**: Kinetic Precision (see `new_ui/kinetic_glass/DESIGN.md`)

## Audio Format

All audio sent to Gemini Live API must be:
- 16-bit PCM, little-endian
- 16kHz sample rate
- Mono channel
- MIME type: `audio/pcm;rate=16000`
- Chunk size: ~25ms (~800 bytes raw)

## Key Conventions

- No Deepgram dependency — removed in this redesign
- Gemini Live API is used as a raw WebSocket protocol (no SDK)
- Two separate Gemini sessions run simultaneously (one per audio stream, different language pairs)
- Ephemeral tokens have 30-min lifetime; proactively refresh at 25 min
- Context window compression is enabled for sessions exceeding 15-min audio limit
- `ws` package used for WebSocket in Electron main process
- System audio capture is platform-specific (desktopCapturer on macOS/Windows, PulseAudio on Linux)

## Environment Variables

```
GEMINI_API_KEY=           # Gemini API key (used by CF Worker to generate ephemeral tokens)
SUPABASE_URL=             # Supabase project URL
SUPABASE_PUBLISHABLE_KEY= # Supabase anon/publishable key
SUPABASE_JWT_ISSUER=      # Supabase JWT issuer URL
SUPABASE_JWT_AUDIENCE=    # "authenticated"
TOKEN_SERVICE_URL=        # CF Worker URL (e.g., https://proxy.example.workers.dev)
```

## Dev Commands

```bash
npm run dev:desktop   # Electron Forge dev with hot reload
npm run dev:proxy     # Wrangler local dev server
npm run dev:web       # Vite dev server
npm run build         # Turbo: build all packages
npm run lint          # ESLint across monorepo
npm run check-types   # TypeScript type checking
```

## Design System

The UI follows the **Kinetic Precision** design system defined in `new_ui/kinetic_glass/DESIGN.md`:
- Colors: primary `#4EDEA3` (you), secondary `#ADC6FF` (them), tertiary `#FFB95F` (processing)
- Surface: deep charcoals (`#131313`), no borders ("no-line rule"), glassmorphic overlays
- Typography: Inter font family
- Mockups in `new_ui/` (subtitle overlay, control center, login, sign up, settings/history)
