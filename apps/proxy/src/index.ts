import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import {
  SESSION_LIMITS,
  type TokenResponse,
  type TokenError,
} from "@realtime/shared";

// ── Environment ──

interface Env {
  USAGE_TRACKER: DurableObjectNamespace;
  TRANSLATION_SESSION: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_JWT_AUDIENCE?: string;
  SUPABASE_JWT_ISSUER?: string;
  GEMINI_API_KEY: string;
  DEEPGRAM_API_KEY: string;
  GOOGLE_TRANSLATE_API_KEY: string;
}

// ── Durable Object: Usage Tracking ──

interface UsageState {
  tokensIssuedToday: number;
  tokensIssuedThisHour: number;
  currentDayKey: string;
  currentHourKey: string;
  estimatedActiveMs: number;
}

const dayKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
const hourKey = (d: Date) => `${dayKey(d)}-${String(d.getUTCHours()).padStart(2, "0")}`;

const defaultUsage = (): UsageState => {
  const now = new Date();
  return { tokensIssuedToday: 0, tokensIssuedThisHour: 0, currentDayKey: dayKey(now), currentHourKey: hourKey(now), estimatedActiveMs: 0 };
};

export class UsageTracker {
  private readonly state: DurableObjectState;
  private usage: UsageState = defaultUsage();
  private initialized = false;

  constructor(state: DurableObjectState) { this.state = state; }

  private async init() {
    if (this.initialized) return;
    const s = await this.state.storage.get<UsageState>("usage");
    if (s) this.usage = s;
    this.initialized = true;
  }

  private rotate(now: Date) {
    const dk = dayKey(now);
    if (this.usage.currentDayKey !== dk) { this.usage.currentDayKey = dk; this.usage.tokensIssuedToday = 0; this.usage.estimatedActiveMs = 0; }
    const hk = hourKey(now);
    if (this.usage.currentHourKey !== hk) { this.usage.currentHourKey = hk; this.usage.tokensIssuedThisHour = 0; }
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();
    const url = new URL(request.url);

    if (url.pathname === "/check-and-increment") {
      const now = new Date();
      this.rotate(now);
      if (this.usage.tokensIssuedThisHour >= SESSION_LIMITS.maxTokensPerUserPerHour)
        return Response.json({ allowed: false, reason: "rate_limited", retryAfterMs: 60_000 }, { status: 429 });
      if (this.usage.estimatedActiveMs >= SESSION_LIMITS.dailySessionMs)
        return Response.json({ allowed: false, reason: "usage_exhausted" }, { status: 429 });
      this.usage.tokensIssuedToday += 1;
      this.usage.tokensIssuedThisHour += 1;
      await this.state.storage.put("usage", this.usage);
      return Response.json({ allowed: true, dailyRemainingMs: Math.max(0, SESSION_LIMITS.dailySessionMs - this.usage.estimatedActiveMs), tokensGeneratedToday: this.usage.tokensIssuedToday });
    }

    if (url.pathname === "/report-usage") {
      const body = (await request.json().catch(() => ({}))) as { durationMs?: number };
      if (typeof body.durationMs === "number" && body.durationMs > 0) {
        this.rotate(new Date());
        this.usage.estimatedActiveMs += body.durationMs;
        await this.state.storage.put("usage", this.usage);
      }
      return Response.json({ ok: true, estimatedActiveMs: this.usage.estimatedActiveMs });
    }

    if (url.pathname === "/reset") {
      this.usage = defaultUsage();
      await this.state.storage.put("usage", this.usage);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }
}

// ── Durable Object: Translation Session ──
// Accepts WebSocket from desktop, connects to Deepgram Flux for STT,
// translates via Gemini Flash, sends results back.

export class TranslationSession {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private client: WebSocket | null = null;
  private youDg: WebSocket | null = null;
  private themDg: WebSocket | null = null;
  private youTarget = "hi-IN";
  private themTarget = "en-US";
  private authenticated = false;
  private sessionStartedAt: number | null = null;
  private lastAudioSentAt: { you: number; them: number } = { you: 0, them: 0 };
  private audioChunkCount: { you: number; them: number } = { you: 0, them: 0 };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Alarm fires when session time limit is reached
  async alarm(): Promise<void> {
    if (!this.sessionStartedAt) return;

    const elapsed = Date.now() - this.sessionStartedAt;
    const max = SESSION_LIMITS.maxSessionDurationMs;
    const warning = max - SESSION_LIMITS.sessionWarningBeforeEndMs;

    if (elapsed < warning) {
      // Too early — reschedule (shouldn't happen, but be safe)
      await this.state.storage.setAlarm(this.sessionStartedAt + warning);
      return;
    }

    if (elapsed < max) {
      // Warning phase — notify client, schedule final alarm
      const remainingMs = max - elapsed;
      this.sendToClient({ type: "session_ending", remainingMs });
      await this.state.storage.setAlarm(this.sessionStartedAt + max);
      return;
    }

    // Time's up
    this.sendToClient({ type: "error", message: "Session time limit reached (30 minutes)" });
    this.cleanup();
    if (this.client) {
      try { this.client.close(4008, "Session time limit reached"); } catch { /* */ }
      this.client = null;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const upgrade = request.headers.get("Upgrade");
    if (!upgrade || upgrade.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }

    const pair = new WebSocketPair();
    const clientWs = pair[0];
    const serverWs = pair[1];

    serverWs.accept();
    this.client = serverWs;

    serverWs.addEventListener("message", (event: MessageEvent) => {
      void this.handleClientMessage(event);
    });

    serverWs.addEventListener("close", () => {
      this.cleanup();
    });

    return new Response(null, { status: 101, webSocket: clientWs });
  }

  private async handleClientMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data !== "string") return;

    let msg: ClientMsg;
    try { msg = JSON.parse(event.data) as ClientMsg; } catch { return; }

    if (msg.type === "auth") {
      const claims = await verifySupabaseToken(msg.token, this.env);
      if (!claims) {
        this.sendToClient({ type: "error", message: "Authentication failed" });
        return;
      }
      this.authenticated = true;
      this.sessionStartedAt = Date.now();

      // Schedule warning alarm at 25 min
      const warningAt = this.sessionStartedAt + SESSION_LIMITS.maxSessionDurationMs - SESSION_LIMITS.sessionWarningBeforeEndMs;
      await this.state.storage.setAlarm(warningAt);

      this.sendToClient({ type: "auth_ok" });
      return;
    }

    if (!this.authenticated) {
      this.sendToClient({ type: "error", message: "Not authenticated" });
      return;
    }

    if (msg.type === "config") {
      if (msg.youTarget) this.youTarget = msg.youTarget;
      if (msg.themTarget) this.themTarget = msg.themTarget;
      this.sendToClient({ type: "config_ok" });
      return;
    }

    if (msg.type === "start") {
      this.startDeepgram("you");
      this.startDeepgram("them");
      return;
    }

    if (msg.type === "audio") {
      const buf = base64ToArrayBuffer(msg.data);
      if (msg.speaker === "you" && this.youDg?.readyState === WebSocket.OPEN) {
        this.youDg.send(buf);
        this.lastAudioSentAt.you = Date.now();
        this.audioChunkCount.you++;
      } else if (msg.speaker === "them" && this.themDg?.readyState === WebSocket.OPEN) {
        this.themDg.send(buf);
        this.lastAudioSentAt.them = Date.now();
        this.audioChunkCount.them++;
      }
      return;
    }

    if (msg.type === "mute") {
      const speaker = msg.speaker;
      const dg = speaker === "you" ? this.youDg : this.themDg;
      if (dg && dg.readyState === WebSocket.OPEN) {
        dg.close();
      }
      if (speaker === "you") this.youDg = null;
      else this.themDg = null;
      return;
    }

    if (msg.type === "unmute") {
      const speaker = msg.speaker;
      this.startDeepgram(speaker);
      return;
    }

    if (msg.type === "stop") {
      this.cleanup();
      return;
    }
  }

  private startDeepgram(speaker: "you" | "them"): void {
    const key = this.env.DEEPGRAM_API_KEY;
    const url = `wss://api.deepgram.com/v1/listen?model=nova-3&language=multi&encoding=linear16&sample_rate=16000&punctuate=true&interim_results=true&utterance_end_ms=3000&smart_format=true`;

    const dgConnectStart = Date.now();
    const ws = new WebSocket(url, ["token", key]);

    ws.addEventListener("open", () => {
      console.log(`[Latency] Deepgram ${speaker} connected in ${Date.now() - dgConnectStart}ms`);
      this.sendToClient({ type: "stt_connected", speaker });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      void this.handleDeepgramMessage(speaker, event);
    });

    ws.addEventListener("close", () => {
      console.log(`[TranslationSession] Deepgram ${speaker} closed`);
    });

    ws.addEventListener("error", () => {
      console.error(`[TranslationSession] Deepgram ${speaker} error`);
    });

    if (speaker === "you") this.youDg = ws;
    else this.themDg = ws;
  }

  private async handleDeepgramMessage(speaker: "you" | "them", event: MessageEvent): Promise<void> {
    const dgRecvAt = Date.now();
    let msg: DeepgramMsg;
    try {
      const text = typeof event.data === "string" ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
      msg = JSON.parse(text) as DeepgramMsg;
    } catch { return; }

    // v2 Flux: EndOfTurn / EagerEndOfTurn
    if (msg.type === "EndOfTurn" || msg.type === "EagerEndOfTurn") {
      console.log(`[Latency] ${speaker} end_of_turn received`);
      this.sendToClient({ type: "end_of_turn", speaker });
      return;
    }

    // v1: UtteranceEnd (similar to EndOfTurn)
    if (msg.type === "UtteranceEnd") {
      console.log(`[Latency] ${speaker} utterance_end received`);
      this.sendToClient({ type: "end_of_turn", speaker });
      return;
    }

    // Transcript (both v1 and v2)
    const alt = msg.channel?.alternatives?.[0];
    if (!alt?.transcript?.trim()) return;

    const transcript = alt.transcript.trim();

    // Deepgram STT latency: time from last audio chunk to transcript received
    const dgDuration = msg.duration ?? 0;
    const dgStart = msg.start ?? 0;
    const lastAudio = this.lastAudioSentAt[speaker];
    const sttLatency = lastAudio > 0 ? dgRecvAt - lastAudio : -1;
    console.log(`[Latency] ${speaker} STT ${msg.is_final ? "final" : "partial"}: stt_latency=${sttLatency}ms audio_offset=${dgStart.toFixed(1)}s duration=${dgDuration.toFixed(1)}s chunks_sent=${this.audioChunkCount[speaker]} text="${transcript.slice(0, 60)}"`);

    if (!msg.is_final) {
      this.sendToClient({ type: "partial", speaker, text: transcript });
      return;
    }

    // Final sentence — send immediately, then translate
    this.sendToClient({ type: "sentence", speaker, text: transcript, translation: null });

    const targetLang = speaker === "you" ? this.youTarget : this.themTarget;
    const translateStart = Date.now();
    const translation = await this.translate(transcript, targetLang);
    const translateMs = Date.now() - translateStart;

    console.log(`[Latency] ${speaker} translation: ${translateMs}ms input=${transcript.length}chars output=${translation.length}chars text="${translation.slice(0, 60)}"`);

    this.sendToClient({ type: "sentence", speaker, text: transcript, translation });
  }

  private async translate(text: string, targetLang: string): Promise<string> {
    try {
      const target = targetLang.split("-")[0] ?? targetLang;
      const res = await fetch(
        `https://translation.googleapis.com/language/translate/v2?key=${this.env.GOOGLE_TRANSLATE_API_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q: text, target, format: "text" }),
        },
      );
      if (!res.ok) {
        console.error(`[TranslationSession] Google Translate error: ${res.status} ${await res.text()}`);
        return "";
      }
      const json = (await res.json()) as { data?: { translations?: Array<{ translatedText?: string }> } };
      return json.data?.translations?.[0]?.translatedText ?? "";
    } catch (err) {
      console.error("[TranslationSession] Translation error:", err);
      return "";
    }
  }

  private sendToClient(msg: ServerMsg): void {
    if (this.client?.readyState === WebSocket.OPEN) {
      this.client.send(JSON.stringify(msg));
    }
  }

  private cleanup(): void {
    if (this.youDg) { try { this.youDg.close(); } catch { /* */ } this.youDg = null; }
    if (this.themDg) { try { this.themDg.close(); } catch { /* */ } this.themDg = null; }
    this.authenticated = false;
  }
}

type ClientMsg =
  | { type: "auth"; token: string; deviceId?: string }
  | { type: "config"; youTarget?: string; themTarget?: string }
  | { type: "start" }
  | { type: "audio"; speaker: "you" | "them"; data: string }
  | { type: "mute"; speaker: "you" | "them" }
  | { type: "unmute"; speaker: "you" | "them" }
  | { type: "stop" };

type ServerMsg =
  | { type: "auth_ok" }
  | { type: "config_ok" }
  | { type: "stt_connected"; speaker: "you" | "them" }
  | { type: "partial"; speaker: "you" | "them"; text: string }
  | { type: "sentence"; speaker: "you" | "them"; text: string; translation: string | null }
  | { type: "end_of_turn"; speaker: "you" | "them" }
  | { type: "error"; message: string }
  | { type: "session_ending"; remainingMs: number };

interface DeepgramMsg {
  type?: string;
  is_final?: boolean;
  start?: number;
  duration?: number;
  channel?: { alternatives?: Array<{ transcript?: string; confidence?: number }> };
}

function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const bin = atob(b64);
  const buf = new ArrayBuffer(bin.length);
  const view = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return buf;
}

// ── JWT Verification ──

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
const getJWKS = (env: Env) => {
  if (!cachedJWKS) cachedJWKS = createRemoteJWKSet(new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`));
  return cachedJWKS;
};

const verifySupabaseToken = async (token: string, env: Env): Promise<{ sub: string } | null> => {
  try {
    const issuer = env.SUPABASE_JWT_ISSUER || `${env.SUPABASE_URL}/auth/v1`;
    const audience = env.SUPABASE_JWT_AUDIENCE || "authenticated";
    const { payload } = await jwtVerify(token, getJWKS(env), { issuer, audience });
    return typeof payload.sub === "string" ? { sub: payload.sub } : null;
  } catch { return null; }
};

// ── Hono App ──

const app = new Hono<{ Bindings: Env }>();
app.use("*", cors());

app.get("/health", (c) => c.json({ ok: true, service: "realtime-translate" }));

// WebSocket endpoint — routes to TranslationSession DO
app.get("/ws", async (c) => {
  const upgrade = c.req.header("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket", { status: 426 });
  }

  // Auth + device routing via query params (WS upgrade can't carry body)
  const token = c.req.query("token");
  const deviceId = c.req.query("deviceId") ?? "default";

  if (!token) {
    return new Response("Missing token query param", { status: 401 });
  }

  const claims = await verifySupabaseToken(token, c.env);
  if (!claims) {
    return new Response("Invalid token", { status: 401 });
  }

  // Per-device DO instance
  const id = c.env.TRANSLATION_SESSION.idFromName(deviceId);
  const stub = c.env.TRANSLATION_SESSION.get(id);
  return stub.fetch(c.req.raw);
});

// Token endpoint (kept for ephemeral token generation if needed)
const tokenRequestSchema = z.object({ model: z.string().optional() });

app.post("/api/token", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer "))
    return c.json({ code: "unauthorized", message: "Missing Authorization" } satisfies TokenError, 401);

  const claims = await verifySupabaseToken(authHeader.slice(7), c.env);
  if (!claims)
    return c.json({ code: "unauthorized", message: "Token verification failed" } satisfies TokenError, 401);

  const doId = c.env.USAGE_TRACKER.idFromName(claims.sub);
  const stub = c.env.USAGE_TRACKER.get(doId);
  const usageRes = await stub.fetch(new Request("https://do/check-and-increment", { method: "POST" }));

  if (!usageRes.ok) {
    const d = (await usageRes.json()) as { reason: string; retryAfterMs?: number };
    if (d.reason === "rate_limited")
      return c.json({ code: "rate_limited", message: "Too many requests", retryAfterMs: d.retryAfterMs } satisfies TokenError, 429);
    return c.json({ code: "usage_exhausted", message: "Daily limit reached" } satisfies TokenError, 429);
  }

  return c.json((await usageRes.json()) as TokenResponse);
});

// Simple translate endpoint
const translateSchema = z.object({ text: z.string().min(1), targetLang: z.string().min(2) });

app.post("/api/translate", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer "))
    return c.json({ code: "unauthorized", message: "Missing Authorization" } satisfies TokenError, 401);
  const claims = await verifySupabaseToken(authHeader.slice(7), c.env);
  if (!claims)
    return c.json({ code: "unauthorized", message: "Token verification failed" } satisfies TokenError, 401);

  const body = await c.req.json().catch(() => ({}));
  const parsed = translateSchema.safeParse(body);
  if (!parsed.success)
    return c.json({ code: "invalid_request", message: "Invalid request" } satisfies TokenError, 400);

  try {
    const target = parsed.data.targetLang.split("-")[0] ?? parsed.data.targetLang;
    const res = await fetch(
      `https://translation.googleapis.com/language/translate/v2?key=${c.env.GOOGLE_TRANSLATE_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ q: parsed.data.text, target, format: "text" }),
      },
    );
    if (!res.ok) {
      const errText = await res.text();
      return c.json({ code: "token_generation_failed", message: errText } satisfies TokenError, 500);
    }
    const json = (await res.json()) as { data?: { translations?: Array<{ translatedText?: string }> } };
    return c.json({ text: json.data?.translations?.[0]?.translatedText ?? "" });
  } catch (err) {
    return c.json({ code: "token_generation_failed", message: err instanceof Error ? err.message : "Failed" } satisfies TokenError, 500);
  }
});

// Usage endpoints
app.post("/api/report-usage", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return c.json({ code: "unauthorized", message: "Missing Authorization" } satisfies TokenError, 401);
  const claims = await verifySupabaseToken(authHeader.slice(7), c.env);
  if (!claims) return c.json({ code: "unauthorized", message: "Token verification failed" } satisfies TokenError, 401);
  const body = await c.req.json().catch(() => ({}));
  const doId = c.env.USAGE_TRACKER.idFromName(claims.sub);
  const stub = c.env.USAGE_TRACKER.get(doId);
  const res = await stub.fetch(new Request("https://do/report-usage", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
  return c.json(await res.json());
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
