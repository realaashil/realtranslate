**TECHNICAL DESIGN DOCUMENT**

**Real-Time Speech Translator**

Electron desktop app for live meeting translation with auto-detection, noise cancellation, device-bound security, and floating subtitle overlay

| Platform           | **Electron 31+ (macOS, Windows, Linux)**                   |
| ------------------ | ---------------------------------------------------------- |
| STT Engine         | **Web Speech API (free, browser-native, 80+ languages)**   |
| Translation LLM    | **Gemini 2.5 Flash (streaming, via WebSocket proxy)**      |
| Noise Cancellation | **RNNoise WASM in AudioWorklet (~13ms, dual-purpose VAD)** |
| Backend Proxy      | **Cloudflare Workers + Durable Objects (WebSocket)**       |
| Security           | **JWT + device fingerprint binding + 2-hour daily cap**    |
| End-to-End Latency | **~280-550ms (3-7x faster than Zoom translation)**         |
| Backend Server     | **None - edge functions only (~60 lines of code)**         |

April 2026 • Version 1.0

# **1\. Project Overview**

A desktop application that automatically detects when a user joins an online meeting (Zoom, Google Meet, Microsoft Teams), captures both the user's microphone audio and the remote participants' audio as two independent streams, performs real-time noise cancellation, transcribes speech to text, translates it via a large language model, and displays translated subtitles in a floating always-on-top overlay window. The entire system is text-only output - no audio/TTS generation - which eliminates TTS latency and keeps the end-to-end pipeline under 550ms.

**Core Design Principles**

1. Text-only output (no TTS) for minimum latency. 2) Two fully independent audio pipelines that never mix. 3) Timestamp-ordered event queue to solve race conditions between pipelines. 4) Thin edge-function proxy (not a server) to protect LLM API keys. 5) Device-bound authentication with 2-hour daily session cap to prevent abuse. 6) Progressive UI states so the user never stares at a blank screen.

# **2\. System Architecture**

## **2.1 Dual Audio Pipeline**

The system captures two audio sources simultaneously and processes them through completely independent, parallel pipelines. The streams are never combined. Each has its own STT instance and its own Gemini translation call routed through the proxy.

### **Pipeline A: User's Microphone ("You")**

Captures the user's voice via navigator.mediaDevices.getUserMedia() with echo cancellation enabled. Three processing layers clean the signal before STT:

- **Layer 1 - Chrome AEC:** Built-in Acoustic Echo Cancellation. Automatically learns the room's acoustic profile in 2-5 seconds and subtracts the meeting audio playing from speakers out of the mic signal. Enabled via getUserMedia({ audio: { echoCancellation: true } }).
- **Layer 2 - RNNoise WASM:** A recurrent neural network compiled to WebAssembly, running inside an AudioWorklet off the main thread. Removes residual noise (fan, keyboard, reverb) and returns a VAD probability score (0.0-1.0) alongside the cleaned audio. Adds only ~13ms latency per 480-sample frame. Uses @jitsi/rnnoise-wasm (~200KB).
- **Layer 3 - VAD Gating:** If the RNNoise VAD score is below 0.5, nothing is sent to STT. This prevents ghost transcriptions from any residual echo that leaks past AEC. Only when the user is actually speaking does the pipeline activate.

Clean audio then flows to Web Speech API (STT instance #1), and final transcriptions are sent through the WebSocket proxy to Gemini (translation call #1).

### **Pipeline B: System Audio Loopback ("Them")**

Captures the meeting's audio output via the electron-audio-loopback package. This is a digital copy of what Zoom/GMeet outputs, captured at the OS level before it reaches the speakers. It is inherently clean - no room noise, no echo, no mic bleed. No AEC is needed. RNNoise can optionally clean noise from the remote speaker's side. Audio flows to Web Speech API (STT instance #2) and Gemini (translation call #2).

**Why Two Separate Pipelines?**

Mixing the streams would produce overlapping voices that confuse the STT engine. Separate pipelines mean: (1) each STT only hears one person, (2) cross-talk works fine since both run in parallel, (3) the overlay can label "You said" vs "They said", and (4) different source languages can be set per stream for true bidirectional translation (e.g., your mic in Hindi, their audio in English).

# **3\. Stream Overlap & Echo Handling**

The mic picks up meeting audio from the speakers (echo/bleed). Three layers solve this without ever mixing the streams:

- **Chrome's built-in AEC:** Acoustic Echo Cancellation analyzes the sound playing from speakers and subtracts it from the mic signal in real time. Takes 2-5 seconds to adapt to room acoustics, then runs continuously. This is the same technology that makes Google Meet work without echo.
- **RNNoise cleanup:** After AEC removes the echo, RNNoise cleans whatever residual noise remains - fan, keyboard clicks, room reverb. The combination of AEC + RNNoise produces a very clean mic signal.
- **VAD gating:** When the mic's VAD score is below 0.5 (user is not speaking), nothing is sent to STT #1. Even if residual echo leaks through AEC, it will not create ghost transcriptions.

**System Audio Is Already Clean**

Stream B (system audio loopback) is a digital copy captured at the OS level before it reaches the speakers. It has never passed through a microphone or a room. It has zero noise, zero echo, zero bleed. No cleanup is needed.

# **4\. Timing Synchronization**

The two pipelines process audio at different speeds. Pipeline B (system audio) is typically faster because it skips AEC and has a cleaner signal. This creates race conditions where a reply's translation could appear on the overlay before the question's translation.

## **4.1 Timestamp-Ordered Event Queue**

Every utterance gets a timestamp at the exact moment VAD detects speech start - not when STT or translation finishes. A central ConversationQueue sorts all utterances by this timestamp before rendering to the overlay. The utterance's position in the conversation is locked the instant someone starts speaking.

## **4.2 Utterance Data Structure**

| **Field**      | **Type**        | **Description**                                                      |
| -------------- | --------------- | -------------------------------------------------------------------- |
| id             | string          | Unique ID: 'you-{timestamp}' or 'them-{timestamp}'                   |
| speaker        | 'you' \| 'them' | Which pipeline produced this utterance                               |
| timestamp      | number          | Date.now() at VAD speech start - the ordering key                    |
| status         | enum            | 'listening' \| 'transcribing' \| 'translating' \| 'done' \| 'failed' |
| originalText   | string          | Progressively updated: interim → final from STT                      |
| translatedText | string          | Progressively updated: streaming chunks from Gemini                  |
| sourceLang     | string          | e.g. 'en-US' - set independently per pipeline                        |
| targetLang     | string          | e.g. 'hi-IN' - set independently per pipeline                        |
| confidence     | number          | STT confidence score (0.0-1.0)                                       |

## **4.3 Queue Processing Steps**

- **Step 1:** VAD detects speech on either stream → create Utterance with timestamp = Date.now(), status = 'listening'.
- **Step 2:** Web Speech API fires interim results → update originalText live, status = 'transcribing'. Overlay shows partial text immediately at the correct chronological position.
- **Step 3:** STT fires isFinal → send to proxy → Gemini. As Gemini streams chunks back over WebSocket, update translatedText progressively, status = 'translating' then 'done'.
- **Step 4:** Overlay always renders utterances sorted by timestamp ascending. Even if Pipeline A finishes later than Pipeline B, its entries appear at the correct position.

## **4.4 Edge Cases**

- **Cross-talk:** Both utterances appear at roughly the same overlay position since timestamps are close. Both progress independently.
- **Slow Gemini response:** Utterance shows 'translating...' at the correct position. Newer utterances appear below. Translation fills in place when it arrives.
- **STT error/timeout:** If an utterance stays in 'listening' for >5 seconds with no STT result, mark as 'failed' with a subtle '(missed)' indicator. Don't block the queue.
- **Rapid back-and-forth:** Batch multiple short utterances from the same speaker (within 2 seconds) into one Gemini call to reduce API overhead.
- **Timestamp tie:** If two utterances have timestamps within 50ms, show 'Them' before 'You' (conversational convention - you respond to what you hear).

# **5\. Noise Cancellation & VAD**

## **5.1 RNNoise WASM**

RNNoise is a recurrent neural network-based noise suppression model compiled to WebAssembly. It runs inside an AudioWorklet thread, processing audio completely off the main thread. Battle-tested by Jitsi Meet in production with millions of users.

| **Property**  | **Value**                                                    |
| ------------- | ------------------------------------------------------------ |
| Model size    | ~200KB (WASM binary)                                         |
| Frame size    | 480 samples at 48kHz                                         |
| Latency added | ~13ms per frame                                              |
| Thread        | AudioWorklet (off main thread, zero UI blocking)             |
| VAD output    | Returns voice probability (0.0-1.0) alongside denoised audio |
| License       | BSD-3                                                        |
| npm package   | @jitsi/rnnoise-wasm or @timephy/rnnoise-wasm                 |

## **5.2 Dual Purpose: Denoise + VAD in One Pass**

RNNoise's processFrame() returns both the cleaned audio AND a voice activity probability score. One model handles both noise cancellation and silence detection for punctuation. No separate Silero VAD model needed.

- **Score > 0.5:** Speech detected → send to STT, overlay shows typing indicator.
- **Score < 0.5 for 300-800ms:** Short pause → insert comma in transcript.
- **Score &lt; 0.5 for &gt;800ms:** Sentence break → insert period, trigger Gemini translation call.
- **Score &lt; 0.5 for &gt;2 seconds:** New paragraph or possible speaker change.

# **6\. Automatic Meeting Detection**

The app sits in the system tray and polls for meeting signals every 2 seconds. A weighted scoring system determines when to auto-start translation.

## **6.1 Four Detection Signals**

| **Signal**          | **Weight**     | **Method**                                                                                                                              | **Platform Notes**                                                      |
| ------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Browser URL match   | 3 (strongest)  | AppleScript reads active browser tab URLs. Matches meet.google.com/\*, zoom.us/j/\*, teams.microsoft.com/\*/meeting, \*.webex.com/meet/ | macOS: AppleScript. Windows: Chrome extension or window title detection |
| Meeting app process | 2              | Checks running processes (Zoom.exe, Teams, Slack) with active network connections to confirm an actual call, not just app open          | All platforms via child_process                                         |
| Microphone active   | 1 (supporting) | Detects if another app has claimed the mic via OS audio APIs                                                                            | macOS: meeting-detection npm package. Windows: Audio Session API        |
| System audio speech | 1 (supporting) | Runs RNNoise VAD on system audio loopback. If sustained speech >5 seconds detected, someone is talking through speakers                 | All platforms via electron-audio-loopback + RNNoise VAD                 |

## **6.2 Decision Logic**

- **Score ≥ 3 (auto-start):** Meeting URL detected (3 alone), or process + mic + speech (2+1+1). Translation starts immediately, floating overlay appears.
- **Score = 2 (prompt user):** Zoom process running + mic active but no URL confirmation. Tray notification: "Meeting detected. Start translating?"
- **Score < 2 (idle):** No meeting detected. Keep polling every 2 seconds. Negligible CPU usage.

## **6.3 Auto-Stop**

Translation stops gracefully (10-second grace period) when: meeting URL tab is closed, meeting process exits, mic is released by the meeting app, or no speech is detected on system audio for 30+ seconds. Transcript is saved automatically on stop.

# **7\. WebSocket Proxy Backend**

A thin proxy layer sits between the Electron app and the Gemini API. It protects the API key, enforces rate limits, validates requests, and streams translation chunks back over a persistent WebSocket connection.

## **7.1 Why WebSocket Instead of HTTP**

During a meeting, the app sends ~30 translation requests per minute (every sentence from both speakers). With plain HTTP, each request requires a new TCP + TLS handshake (~80ms overhead). With a WebSocket, one persistent connection opens at meeting start and handles all messages with ~1ms overhead per message. This saves approximately 2.7 seconds per minute of wasted connection setup time.

## **7.2 Connection Lifecycle**

- **Meeting detected:** Electron app opens WebSocket to wss://api.yourtranslator.com/ws?token=JWT
- **Auth handshake:** Proxy validates JWT, checks device fingerprint, confirms session limit. Returns session_id and remaining limits.
- **Active translation:** Client sends { type: "translate", utteranceId, text, sourceLang, targetLang }. Proxy validates, rate-checks, injects Gemini API key, calls Gemini streaming API, forwards each chunk back with the same utteranceId.
- **Proactive warnings:** Proxy pushes rate limit warnings and session time warnings to the client without being asked.
- **Heartbeat:** Client sends ping every 30 seconds. Proxy responds with pong. If no pong in 5 seconds, client assumes disconnect and starts reconnecting.
- **Meeting ended:** Client sends disconnect message. Proxy logs session stats and closes the WebSocket cleanly.

## **7.3 Message Protocol**

All messages are JSON objects with a 'type' field. Client-to-proxy: auth, translate, ping, disconnect. Proxy-to-client: auth_ok, translation_chunk (with utteranceId to map to correct ConversationQueue entry), rate_warning, rate_limited, session_warning, error, pong. The utteranceId in every message is the critical link that ties each WebSocket response to the correct entry in the timestamp-ordered ConversationQueue.

## **7.4 Deployment: Cloudflare Workers + Durable Objects**

A regular Cloudflare Worker is stateless and cannot hold a WebSocket open. A Durable Object is a stateful worker instance that persists in memory, can hold WebSocket connections, and maintains per-user state (rate counters, session timer) for the duration of the meeting. Each user gets their own Durable Object identified by user ID.

- **Cloudflare Workers:** Entry point that validates the JWT, routes to the correct Durable Object per user.
- **Durable Object:** Holds the WebSocket connection, manages rate limit counters, tracks session duration, validates device fingerprint, streams Gemini responses chunk-by-chunk back to the client.
- **Hibernation:** When the meeting has idle periods (no speech), the Durable Object can hibernate without disconnecting the WebSocket, avoiding charges for inactive compute.
- **Total proxy code:** ~60-80 lines. Not a server - an edge function that deploys in seconds.

## **7.5 Resilience: Auto-Reconnect**

If the WebSocket drops (network blip, Cloudflare restart), the client auto-reconnects with exponential backoff: 1s → 2s → 4s → 8s → 16s, max 5 attempts. During reconnect, translation requests are buffered locally and sent when connection restores. Pending utterances in 'translating' state are re-sent after reconnect (proxy deduplicates by utteranceId). The overlay shows a subtle "reconnecting..." indicator.

# **8\. Security & Anti-Abuse System**

Four layers of protection prevent API key exposure and usage abuse. All four must pass before any request reaches Gemini.

## **8.1 Layer 1: Device Fingerprint Binding**

On first launch, the Electron app generates a hardware fingerprint by hashing: OS-level machine ID (via node-machine-id), CPU model, total RAM, hostname, OS platform + architecture, and hardware-specific signals from hw-fingerprint. The resulting SHA-256 hash is stable across reboots and unique per machine.

- **Registration:** On first login, the deviceId is stored server-side. The JWT token embeds this deviceId.
- **Validation:** On every WebSocket connection, the proxy checks that the deviceId in the JWT matches the registered device for that user.
- **Device swap cooldown:** Users cannot switch devices within 24 hours. This prevents token sharing - even if someone shares their JWT, it won't work on a different machine.
- **Legitimate device change:** After 24 hours, users can switch to a new device (e.g., new laptop). The old device is deregistered.

**What This Prevents**

User A shares their JWT token with User B on a different machine. The proxy rejects User B's WebSocket connection because B's hardware fingerprint doesn't match A's registered device. The token is useless on any other machine.

## **8.2 Layer 2: 2-Hour Daily Session Cap**

Each user gets 2 hours of active translation time per day. The timer only counts when the WebSocket is connected AND the app is actively translating (sending requests). Idle gaps longer than 30 seconds are not counted. The timer resets at midnight UTC.

- **Active time tracking:** On each translation request, the proxy calculates the gap since the last request. If the gap is under 30 seconds, that duration is added to the daily usage counter. Gaps over 30 seconds are treated as idle time and not counted.
- **Warning at 80%:** When 80% of the daily limit is consumed (24 minutes remaining), the proxy pushes a session_warning message to the client. The overlay shows a progress bar with remaining time.
- **Limit reached:** When the 2-hour cap is hit, the proxy stops forwarding requests to Gemini and sends a session_expired message. The overlay shows "Daily limit reached. Resets at midnight UTC." The transcript is auto-saved.
- **Cost predictability:** 2-hour cap × 30 RPM = max 3,600 requests/user/day. At ~100 tokens per translation ≈ 360K tokens/user/day. Gemini 2.5 Flash pricing: ~\$0.054/user/day maximum. Even 100 daily active users = \$5.40/day.

## **8.3 Layer 3: Per-Minute Rate Limiting**

| **Limit**                  | **Value**                      | **Scope**                               |
| -------------------------- | ------------------------------ | --------------------------------------- |
| Requests per minute        | 30                             | Per user                                |
| Max concurrent requests    | 5                              | Per user                                |
| Global requests per minute | 200                            | All users combined                      |
| Global tokens per minute   | 500,000                        | All users combined (Gemini Tier 1 safe) |
| Backoff strategy           | Exponential: 1s → 2s → 4s → 8s | On 429 from Gemini or proxy             |
| Proactive warning          | At 80% of per-minute limit     | Pushed via WebSocket                    |

## **8.4 Layer 4: Input Validation & Prompt Hardening**

- **Max text length:** 1,000 characters per request. A meeting sentence is typically 50-200 characters. Anything longer is not a real utterance.
- **Language whitelist:** Only supported BCP-47 language codes accepted. Reject unknown codes.
- **System prompt locked server-side:** The client sends ONLY the text to translate. The proxy wraps it in the translation prompt: "Translate from {src} to {tgt}. Output ONLY the translation." The client cannot modify the system prompt.
- **Prompt injection blocking:** Input text is sanitized: strip markdown formatting, reject texts containing common injection patterns (e.g., "ignore previous instructions").

## **8.5 JWT Token Contents**

| **Field**             | **Value**       | **Purpose**                                                        |
| --------------------- | --------------- | ------------------------------------------------------------------ |
| sub                   | user_abc123     | User identifier                                                    |
| deviceId              | a3f8c2d1e9b4... | SHA-256 hardware fingerprint - validated against registered device |
| iat                   | 1713264000      | Token issued at timestamp                                          |
| exp                   | 1713267600      | Token expires in 1 hour                                            |
| plan                  | "free" \| "pro" | For future paid tier expansion                                     |
| limits.dailySessionMs | 7200000         | 2 hours in milliseconds                                            |
| limits.rpm            | 30              | Requests per minute cap                                            |

The Electron app stores only the JWT token (short-lived, refreshable) and the proxy URL. It never stores the Gemini API key, user passwords, or other users' data.

# **9\. Floating Subtitle Overlay**

## **9.1 Window Properties**

| **Property** | **Implementation**                                                             |
| ------------ | ------------------------------------------------------------------------------ |
| Window type  | Electron BrowserWindow with transparent: true, alwaysOnTop: true, frame: false |
| Background   | Semi-transparent dark (#000000 at 82% opacity) for readability over any app    |
| Position     | Draggable. Default: bottom center of screen. Position saved via electron-store |
| Size         | Resizable. Default: 600px wide, 200px tall. Shows 3-4 most recent utterances   |
| Toggle       | Keyboard shortcut: Cmd+Shift+T (Mac) / Ctrl+Shift+T (Windows)                  |
| Auto-scroll  | Latest translation always visible, older lines scroll up and fade              |

## **9.2 Five Utterance Display States**

Each utterance on the overlay shows a distinct visual treatment so the user always knows what's happening:

| **State**    | **Visual Treatment**                                                        | **What's Happening**                                     |
| ------------ | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| listening    | Speaker label (YOU/THEM) + pulsing green/blue dot                           | VAD detected speech, waiting for first STT words         |
| transcribing | Original text appearing word-by-word + purple blinking cursor               | Web Speech API streaming interim results                 |
| translating  | Original text (dim italic) + translated text with amber blinking cursor     | Gemini streaming translated chunks via WebSocket proxy   |
| done         | Original text (dim italic) + translation (bright bold) + green 'done' badge | Fully processed. Both texts are final                    |
| failed       | Dim '(missed)' text in gray                                                 | STT timed out or returned empty. Doesn't block the queue |

## **9.3 Speaker Labels & Session Info**

- **YOU (green accent):** Utterances from the mic pipeline. Green badge, green indicators.
- **THEM (blue accent):** Utterances from the system audio pipeline. Blue badge, blue indicators.
- **Timestamps:** Each utterance shows a small timestamp (e.g., '0:42') next to the speaker label.
- **Session progress bar:** Top-right corner shows remaining daily time (e.g., '24 min left today') with an amber progress bar.
- **Language indicator:** Top-left shows active language pair (e.g., "EN → HI").

# **10\. Latency Analysis**

Adding the WebSocket proxy changed the latency profile from the original direct-to-Gemini estimate. Here is the honest, stage-by-stage breakdown:

## **10.1 Per-Utterance Latency Budget**

| **Stage**                                  | **Latency** | **Notes**                                                                  |
| ------------------------------------------ | ----------- | -------------------------------------------------------------------------- |
| RNNoise denoise + VAD                      | ~13ms       | AudioWorklet, off main thread                                              |
| Web Speech API (interim results)           | ~100-200ms  | Partial words appear on overlay. User sees activity here                   |
| Web Speech API (final result)              | ~500-1500ms | Waits for sentence completion. This is the speaker talking, not processing |
| WebSocket message send                     | ~1ms        | Persistent connection, no handshake                                        |
| Proxy validation (device + session + rate) | ~1-2ms      | All in-memory lookups on Durable Object                                    |
| Proxy → Gemini network hop                 | ~10-30ms    | Cloudflare PoP → Gemini. Short hop if same region (e.g., Mumbai → Mumbai)  |
| Gemini time-to-first-token (TTFT)          | ~150-300ms  | The dominant latency factor. 90% of processing time                        |
| Proxy → client (stream chunk)              | ~1-5ms      | Streamed over the existing WebSocket                                       |
| Overlay React render                       | ~1ms        | State update + DOM paint                                                   |

## **10.2 Total End-to-End**

| **Metric**                                    | **Value**                                                |
| --------------------------------------------- | -------------------------------------------------------- |
| Speech end → first translated word on overlay | ~280-550ms                                               |
| Proxy overhead vs direct approach             | ~12-37ms added (3-9% of total)                           |
| Bottleneck                                    | Gemini TTFT (~225ms average) = 90% of processing latency |
| Compared to Zoom live translation             | 3-7x faster (Zoom: 2-4 seconds)                          |
| Compared to traditional STT→LLM→TTS           | 2-5x faster (no TTS step)                                |

**Progressive Perception**

The user never waits staring at a blank screen. From the moment someone speaks: pulsing dot appears in ~13ms, original words start appearing in ~100-200ms, 'translating...' badge shows when sentence completes, first translated word appears in ~280-550ms after sentence ends, and the full translation streams in smoothly like typing. The progressive states make the experience feel continuous rather than batch-and-wait.

# **11\. Technology Stack**

| **Component**         | **Technology**                       | **Purpose**                                                               |
| --------------------- | ------------------------------------ | ------------------------------------------------------------------------- |
| App shell             | Electron 31+                         | Desktop app: system tray, auto-start, always-on-top overlay, system audio |
| System audio capture  | electron-audio-loopback              | Capture Zoom/GMeet audio. macOS 12.3+, Windows 10+, Linux. No drivers     |
| Meeting detection     | meeting-detection (npm)              | Auto-detect meetings: URL matching, process detection, mic/camera signals |
| Noise cancellation    | @jitsi/rnnoise-wasm                  | RNNoise → WASM. AudioWorklet. Denoise + VAD in one pass (~200KB)          |
| Speech-to-text        | Web Speech API                       | Free, browser-native, streaming STT with interimResults. 80+ languages    |
| Translation LLM       | Gemini 2.5 Flash                     | Streaming text API. Lowest latency among frontier multilingual LLMs       |
| Backend proxy         | Cloudflare Workers + Durable Objects | WebSocket proxy: auth, rate limit, device binding, Gemini key injection   |
| Device fingerprinting | node-machine-id + hw-fingerprint     | Hardware-based device ID for token binding                                |
| Auth tokens           | JWT (HS256)                          | Short-lived (1 hour), contain deviceId, rate limit config                 |
| Frontend              | React + TypeScript                   | Overlay UI, settings panel, transcript viewer                             |
| State management      | Zustand or React Context             | ConversationQueue, pipeline state, settings                               |
| Persistence           | electron-store                       | Language preferences, window position, proxy URL, transcript history      |
| Packaging             | electron-builder                     | Distributable as .dmg (Mac), .exe (Windows), .AppImage (Linux)            |

# **12\. Build Plan**

## **Phase 1: Web Prototype (Day 1-2)**

A standalone React app running in Chrome that proves the core translation pipeline end-to-end.

- **Audio:** Mic only via getUserMedia (no system audio yet).
- **Noise cancellation:** RNNoise WASM in AudioWorklet with VAD scoring.
- **STT:** Web Speech API with interimResults and continuous mode.
- **Translation:** Gemini 2.5 Flash via a simple Cloudflare Worker proxy (HTTP streaming, not WebSocket yet).
- **UI:** Single-page React app with language selectors, live transcript showing original + translated text, waveform visualization, progressive utterance states.
- **Deliverable:** Working demo deployable to any browser with just a proxy URL.

## **Phase 2: Electron Desktop App (Day 3-4)**

Wrap the web prototype in Electron and add all desktop-specific features.

- **System audio:** Add electron-audio-loopback for Zoom/GMeet audio capture.
- **Dual pipeline:** Two separate STT instances feeding the ConversationQueue with timestamp ordering.
- **WebSocket proxy:** Upgrade from HTTP to persistent WebSocket via Cloudflare Durable Objects.
- **Meeting detection:** Add meeting-detection package with 4-signal scoring system.
- **Floating overlay:** Always-on-top transparent BrowserWindow with the subtitle UI and 5 visual states.
- **System tray:** Tray icon with language selector, toggle, settings. Register for auto-start on login.
- **Device binding:** Generate hardware fingerprint, embed in JWT, validate on proxy.
- **Session cap:** 2-hour daily active time tracking in Durable Object.

## **Phase 3: Polish & Distribution (Day 5)**

- **Bidirectional translation:** Different source languages per stream (mic in Hindi, their audio in English).
- **Transcript export:** Save full conversation as TXT/PDF with timestamps, speaker labels, both languages.
- **Punctuation refinement:** Fine-tune VAD gap thresholds for comma/period/paragraph detection.
- **Keyboard shortcuts:** Cmd+Shift+T toggle overlay, Cmd+Shift+L switch languages, Cmd+Shift+S save transcript.
- **Settings persistence:** Window position, languages, proxy URL stored via electron-store across sessions.
- **Auto-reconnect polish:** Exponential backoff, local request buffering, reconnecting indicator.
- **Package for distribution:** electron-builder to produce .dmg, .exe, .AppImage installers with code signing.

# **13\. Future Upgrade Path**

| **Component**  | **Current**               | **Future Upgrade**                                   | **Why**                                               |
| -------------- | ------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| STT            | Web Speech API (free)     | Deepgram Nova-3 or Faster Whisper                    | Better accuracy, speaker diarization, privacy (local) |
| Translation    | Gemini 2.5 Flash          | Gemini prompt caching or local model                 | Lower latency, offline support                        |
| Noise cancel   | RNNoise WASM (~200KB)     | DTLN-rs (Datadog) or Krisp SDK                       | Better noise separation for complex environments      |
| Meeting detect | URL + process + mic + VAD | Calendar API integration (Google/Outlook)            | Pre-start translation before meeting begins           |
| Overlay        | Electron BrowserWindow    | Native overlay (Swift/C++)                           | Lower memory, smoother rendering                      |
| Auth           | JWT + device binding      | OAuth (Google/Microsoft) + team accounts             | Enterprise deployment, team management                |
| Pricing        | Free with 2h cap          | Pro tier: 8h/day, priority Gemini, transcript export | Revenue model                                         |

_End of Technical Design Document_
