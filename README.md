# RealTranslate

A real-time speech translation desktop app. Captures your microphone and the other party's system audio simultaneously, streams both to a speech-to-text service, batches complete sentences, and displays translated subtitles in an always-on-top overlay.

Ideal for live calls, meetings, watching foreign-language content, or any situation where you need bidirectional, low-latency translation without a third-party bot joining your meeting.

## Features

- **Two-way live translation** — your mic → their language, system audio → your language, both running simultaneously
- **Always-on-top overlay** — glassmorphic subtitle view that floats above any app
- **Sentence buffering** — accumulates fragments into full sentences before translating for better quality
- **Explicit source languages** — avoid auto-detect drift by telling the translator what language you and they speak
- **Microphone picker** — choose which audio input device to use
- **Cross-platform system audio**
  - Linux: PulseAudio/PipeWire via `parec`
  - macOS / Windows: Electron's `getDisplayMedia` with audio loopback
- **Session limits & usage tracking** — per-user rate limiting enforced by a Cloudflare Worker

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  Desktop (Electron)                                          │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Renderer                                              │  │
│  │   • Mic capture (AudioWorklet → 16 kHz PCM)           │  │
│  │   • System audio (getDisplayMedia + loopback)         │  │
│  │   • Overlay UI (subtitle / feed)                      │  │
│  └───────────────────────────────────────────────────────┘  │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ Main                                                  │  │
│  │   • GeminiSessionManager — WS to proxy                │  │
│  │   • SystemAudioCapture (Linux parec)                  │  │
│  │   • Supabase auth                                     │  │
│  └───────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                           │ WebSocket (auth + audio)
                           ▼
┌──────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (Hono + Durable Objects)                  │
│   • TranslationSession DO                                    │
│       ├─ Deepgram WS (STT, interim + final)                  │
│       ├─ Sentence buffer (punctuation / word cap / timeout)  │
│       └─ Google Translate v2 (explicit source + target)      │
│   • UsageTracker DO (per-user rate limits)                   │
└──────────────────────────────────────────────────────────────┘
```

Audio never hits the worker's disk — it's forwarded to Deepgram over an open WebSocket. Only STT text and translations traverse the Hono layer.

## Monorepo layout

| Path | Description |
|------|-------------|
| `apps/desktop` | Electron app (Electron Forge + Vite) |
| `apps/proxy` | Cloudflare Worker (Hono, Durable Objects) |
| `packages/shared` | Shared TypeScript types, constants, protocol, conversation queue |

Managed with **Turborepo** + **npm workspaces**.

## Prerequisites

- **Node.js** ≥ 18
- **npm** ≥ 10
- **Platform-specific dependencies** (see [Platform Notes](#platform-notes))
- API keys and accounts:
  - [Supabase](https://supabase.com/) project (auth)
  - [Deepgram](https://deepgram.com/) API key (STT)
  - [Google Cloud Translation](https://cloud.google.com/translate) API key
  - [Cloudflare](https://www.cloudflare.com/) account (for worker deploy)

## Environment variables

Create a `.env` at the repo root for local development:

```bash
# Proxy (Cloudflare Worker)
GEMINI_API_KEY=              # optional, currently unused — reserved
DEEPGRAM_API_KEY=            # Deepgram STT key
GOOGLE_TRANSLATE_API_KEY=    # Google Cloud Translation v2 key
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_JWT_AUDIENCE=authenticated
SUPABASE_JWT_ISSUER=         # leave blank to use <SUPABASE_URL>/auth/v1

# Desktop (Electron)
TOKEN_SERVICE_URL=http://127.0.0.1:8787    # CF worker URL (or production)
SUPABASE_URL=https://<project-ref>.supabase.co
SUPABASE_PUBLISHABLE_KEY=<anon/publishable key>
```

For production, set worker secrets via `wrangler secret put GEMINI_API_KEY`, `wrangler secret put DEEPGRAM_API_KEY`, and `wrangler secret put GOOGLE_TRANSLATE_API_KEY`.

## Install

```bash
git clone https://github.com/<your-fork>/realtime-translate.git
cd realtime-translate
npm install
```

This installs all workspace dependencies.

## Development

Run the proxy and desktop app in separate terminals:

```bash
# Terminal 1 — Cloudflare worker (Wrangler local dev at :8787)
npm run dev:proxy

# Terminal 2 — Electron app with hot reload
npm run dev:desktop
```

Other scripts:

```bash
npm run build          # Turbo: build all packages
npm run lint           # ESLint across monorepo
npm run check-types    # TypeScript typecheck
npm run format         # Prettier
```

## Building desktop installers

Electron Forge handles packaging. From the repo root:

```bash
# Package (no installer — creates a folder you can run directly)
npm run package -w realtranslate

# Build a distributable installer for the current platform
npm run make -w realtranslate
```

Output lands in `apps/desktop/out/make/`.

### Per-platform output

| Platform | Maker | Output |
|----------|-------|--------|
| Linux (Debian/Ubuntu) | `@electron-forge/maker-deb` | `.deb` |
| Linux (Fedora/RHEL) | `@electron-forge/maker-rpm` | `.rpm` |
| macOS | `@electron-forge/maker-dmg` | `.dmg` |
| Windows | `@electron-forge/maker-squirrel` | Setup `.exe` |

Cross-compiling is limited — build Windows installers on Windows, macOS installers on macOS. Linux makers work on Linux.

## Platform notes

### Linux

System audio capture uses **PulseAudio / PipeWire** via `parec`:

```bash
# Debian / Ubuntu
sudo apt install pulseaudio-utils

# Fedora
sudo dnf install pulseaudio-utils

# Arch
sudo pacman -S libpulse
```

The app auto-detects the default sink and reads from its `.monitor` source. If nothing is captured, verify with `pactl get-default-sink` and that `<sink>.monitor` exists in `pactl list sources short`.

For `.rpm` / `.deb` builds, you may need:

```bash
sudo apt install rpm fakeroot dpkg   # for building .deb on any Linux
```

### Windows

System audio uses Electron's `getDisplayMedia` with `audio: 'loopback'` — no extra drivers or software required. The first time you run the app, Windows may prompt for microphone permission.

Installers are built with `electron-winstaller` (maker-squirrel). Install with the generated `Setup.exe`.

### macOS

System audio uses `getDisplayMedia` with loopback. macOS 14.2+ may require **Screen & System Audio Recording** permission the first time — grant it in System Settings → Privacy & Security.

For `.dmg` builds, you need:

```bash
# Installed by default with Xcode command line tools
xcode-select --install
```

## Deploying the proxy

```bash
cd apps/proxy

# One-time: login to Cloudflare
npx wrangler login

# Set secrets
npx wrangler secret put DEEPGRAM_API_KEY
npx wrangler secret put GOOGLE_TRANSLATE_API_KEY
npx wrangler secret put GEMINI_API_KEY   # optional

# Edit wrangler.jsonc: update `account_id` and `vars.SUPABASE_URL`

# Deploy
npx wrangler deploy
```

After deploy, update `TOKEN_SERVICE_URL` in your desktop `.env` (or use the in-app Settings → Token service URL) to point at the deployed worker.

## Configuration (in-app)

Open **Settings** (gear icon in the overlay header) to configure:

- **Microphone** — choose an audio input device
- **I speak** — source language of your mic audio (select a specific language for best translation quality; "Auto" works but can misdetect)
- **Translate me into** — target language for your speech
- **They speak** — source language of system audio
- **Translate them into** — target language for the other party

Settings persist in Electron's user data directory.

## Audio format

All audio forwarded to Deepgram is:

- 16-bit PCM, little-endian
- 16 kHz mono
- ~25 ms chunks (~800 bytes each)

Downsampling from the 48 kHz `AudioContext` is handled in `public/pcm-worklet.js`.

## Tech stack

- **Language**: TypeScript end-to-end
- **Desktop**: Electron 41 + Electron Forge + Vite
- **Proxy**: Hono on Cloudflare Workers, Durable Objects for per-user/per-device state
- **Auth**: Supabase (JWT via JWKS)
- **STT**: Deepgram WebSocket (`nova-3` multi-language model)
- **Translation**: Google Cloud Translation v2
- **Build**: Turborepo + npm workspaces

## Troubleshooting

**No system audio on Linux**
Make sure `parec` is installed and `pactl get-default-sink` returns a sink. PipeWire-only systems need the `pipewire-pulse` compatibility layer.

**No system audio on Windows**
Check that the app is allowed to record audio (Windows Settings → Privacy & security → Microphone). The first capture call should trigger a permission prompt; if it didn't, revoke and re-grant the permission.

**Translations keep coming back in the source language**
Set explicit source languages in Settings (avoid the "Auto" option). Google Translate's auto-detection occasionally returns the input unchanged for short fragments.

**`wrangler deploy` fails with "account not found"**
Update `account_id` in `apps/proxy/wrangler.jsonc` to match your Cloudflare account.

## License

MIT
