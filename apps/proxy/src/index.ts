import { Hono } from "hono";
import { cors } from "hono/cors";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import { GoogleGenAI, Modality } from "@google/genai";
import { z } from "zod";
import {
  SESSION_LIMITS,
  GEMINI_MODELS,
  type TokenResponse,
  type TokenError,
} from "@realtime/shared";

// ── Environment ──

interface Env {
  USAGE_TRACKER: DurableObjectNamespace;
  SUPABASE_URL: string;
  SUPABASE_JWT_AUDIENCE?: string;
  SUPABASE_JWT_ISSUER?: string;
  GEMINI_API_KEY: string;
}

// ── Durable Object: Per-User Usage Tracking ──

interface UsageState {
  tokensIssuedToday: number;
  tokensIssuedThisHour: number;
  currentDayKey: string;
  currentHourKey: string;
  estimatedActiveMs: number;
}

const dayKey = (date: Date): string => {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
};

const hourKey = (date: Date): string => {
  return `${dayKey(date)}-${String(date.getUTCHours()).padStart(2, "0")}`;
};

const defaultUsageState = (): UsageState => {
  const now = new Date();
  return {
    tokensIssuedToday: 0,
    tokensIssuedThisHour: 0,
    currentDayKey: dayKey(now),
    currentHourKey: hourKey(now),
    estimatedActiveMs: 0,
  };
};

export class UsageTracker {
  private readonly state: DurableObjectState;
  private usage: UsageState = defaultUsageState();
  private initialized = false;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    const stored = await this.state.storage.get<UsageState>("usage");
    if (stored) {
      this.usage = stored;
    }
    this.initialized = true;
  }

  private rotateWindows(now: Date): void {
    const dk = dayKey(now);
    if (this.usage.currentDayKey !== dk) {
      this.usage.currentDayKey = dk;
      this.usage.tokensIssuedToday = 0;
      this.usage.estimatedActiveMs = 0;
    }

    const hk = hourKey(now);
    if (this.usage.currentHourKey !== hk) {
      this.usage.currentHourKey = hk;
      this.usage.tokensIssuedThisHour = 0;
    }
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();

    const url = new URL(request.url);

    if (url.pathname === "/check-and-increment") {
      const now = new Date();
      this.rotateWindows(now);

      if (
        this.usage.tokensIssuedThisHour >=
        SESSION_LIMITS.maxTokensPerUserPerHour
      ) {
        return Response.json(
          {
            allowed: false,
            reason: "rate_limited",
            retryAfterMs: 60_000,
          },
          { status: 429 },
        );
      }

      if (this.usage.estimatedActiveMs >= SESSION_LIMITS.dailySessionMs) {
        return Response.json(
          {
            allowed: false,
            reason: "usage_exhausted",
          },
          { status: 429 },
        );
      }

      this.usage.tokensIssuedToday += 1;
      this.usage.tokensIssuedThisHour += 1;
      // Don't pre-charge session time — actual usage is reported via /report-usage
      await this.state.storage.put("usage", this.usage);

      const dailyRemainingMs = Math.max(
        0,
        SESSION_LIMITS.dailySessionMs - this.usage.estimatedActiveMs,
      );

      return Response.json({
        allowed: true,
        dailyRemainingMs,
        tokensGeneratedToday: this.usage.tokensIssuedToday,
      });
    }

    if (url.pathname === "/report-usage") {
      const body = (await request.json().catch(() => ({}))) as {
        durationMs?: number;
      };
      const durationMs = body.durationMs;
      if (typeof durationMs === "number" && durationMs > 0) {
        this.rotateWindows(new Date());
        this.usage.estimatedActiveMs += durationMs;
        await this.state.storage.put("usage", this.usage);
      }

      return Response.json({
        ok: true,
        estimatedActiveMs: this.usage.estimatedActiveMs,
        dailyRemainingMs: Math.max(
          0,
          SESSION_LIMITS.dailySessionMs - this.usage.estimatedActiveMs,
        ),
      });
    }

    if (url.pathname === "/reset") {
      this.usage = defaultUsageState();
      await this.state.storage.put("usage", this.usage);
      return Response.json({ ok: true, usage: this.usage });
    }

    if (url.pathname === "/status") {
      const now = new Date();
      this.rotateWindows(now);

      return Response.json({
        tokensIssuedToday: this.usage.tokensIssuedToday,
        tokensIssuedThisHour: this.usage.tokensIssuedThisHour,
        estimatedActiveMs: this.usage.estimatedActiveMs,
        dailyRemainingMs: Math.max(
          0,
          SESSION_LIMITS.dailySessionMs - this.usage.estimatedActiveMs,
        ),
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

// ── JWT Verification ──

let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

const getJWKS = (env: Env): ReturnType<typeof createRemoteJWKSet> => {
  if (!cachedJWKS) {
    cachedJWKS = createRemoteJWKSet(
      new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
    );
  }
  return cachedJWKS;
};

const verifySupabaseToken = async (
  token: string,
  env: Env,
): Promise<{ sub: string } | null> => {
  try {
    const issuer =
      env.SUPABASE_JWT_ISSUER || `${env.SUPABASE_URL}/auth/v1`;
    const audience = env.SUPABASE_JWT_AUDIENCE || "authenticated";

    const { payload } = await jwtVerify(token, getJWKS(env), {
      issuer,
      audience,
    });

    if (typeof payload.sub !== "string") return null;
    return { sub: payload.sub };
  } catch {
    return null;
  }
};

// ── Gemini Ephemeral Token Generation ──

const generateEphemeralToken = async (
  apiKey: string,
  model: string,
): Promise<{ token: string; expiresAt: string } | null> => {
  const expireTime = new Date(
    Date.now() + SESSION_LIMITS.tokenLifetimeMs,
  ).toISOString();

  try {
    const client = new GoogleGenAI({ apiKey });

    const token = await client.authTokens.create({
      config: {
        uses: 10,
        expireTime,
        newSessionExpireTime: new Date(
          Date.now() + 2 * 60 * 1000,
        ).toISOString(),
        httpOptions: {
          apiVersion: "v1alpha",
        },
      },
    });

    const tokenName = token?.name;
    if (!tokenName) {
      console.error(
        "Ephemeral token response missing name:",
        JSON.stringify(token),
      );
      return null;
    }

    return {
      token: tokenName,
      expiresAt: (token as { expireTime?: string }).expireTime ?? expireTime,
    };
  } catch (err) {
    console.error(
      "Ephemeral token generation failed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
};

// ── Request Validation ──

const tokenRequestSchema = z.object({
  model: z.string().optional(),
});

// ── Hono App ──

const app = new Hono<{ Bindings: Env }>();

app.use("*", cors());

app.get("/health", (c) => {
  return c.json({ ok: true, service: "realtime-translate-token-service" });
});

app.post("/api/report-usage", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ code: "unauthorized", message: "Missing Authorization" } satisfies TokenError, 401);
  }

  const claims = await verifySupabaseToken(authHeader.slice(7), c.env);
  if (!claims) {
    return c.json({ code: "unauthorized", message: "Token verification failed" } satisfies TokenError, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const doId = c.env.USAGE_TRACKER.idFromName(claims.sub);
  const stub = c.env.USAGE_TRACKER.get(doId);
  const res = await stub.fetch(
    new Request("https://do/report-usage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  return c.json(await res.json());
});

app.post("/api/reset-usage", async (c) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json({ code: "unauthorized", message: "Missing Authorization" } satisfies TokenError, 401);
  }

  const claims = await verifySupabaseToken(authHeader.slice(7), c.env);
  if (!claims) {
    return c.json({ code: "unauthorized", message: "Token verification failed" } satisfies TokenError, 401);
  }

  const doId = c.env.USAGE_TRACKER.idFromName(claims.sub);
  const stub = c.env.USAGE_TRACKER.get(doId);
  const res = await stub.fetch(new Request("https://do/reset", { method: "POST" }));
  return c.json(await res.json());
});

app.post("/api/token", async (c) => {
  // Extract and verify Supabase JWT
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return c.json(
      {
        code: "unauthorized",
        message: "Missing or invalid Authorization header",
      } satisfies TokenError,
      401,
    );
  }

  const jwt = authHeader.slice(7);
  const claims = await verifySupabaseToken(jwt, c.env);
  if (!claims) {
    return c.json(
      {
        code: "unauthorized",
        message: "Token verification failed",
      } satisfies TokenError,
      401,
    );
  }

  // Parse request body
  const body = await c.req.json().catch(() => ({}));
  const parsed = tokenRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      {
        code: "invalid_request",
        message: "Invalid request body",
      } satisfies TokenError,
      400,
    );
  }

  const model = parsed.data.model ?? GEMINI_MODELS.live;

  // Check usage limits via Durable Object
  const doId = c.env.USAGE_TRACKER.idFromName(claims.sub);
  const stub = c.env.USAGE_TRACKER.get(doId);
  const usageResponse = await stub.fetch(
    new Request("https://do/check-and-increment", { method: "POST" }),
  );

  if (!usageResponse.ok) {
    const usageData = (await usageResponse.json()) as {
      reason: string;
      retryAfterMs?: number;
    };

    if (usageData.reason === "rate_limited") {
      return c.json(
        {
          code: "rate_limited",
          message: "Too many token requests. Please wait before trying again.",
          retryAfterMs: usageData.retryAfterMs,
        } satisfies TokenError,
        429,
      );
    }

    return c.json(
      {
        code: "usage_exhausted",
        message: "Daily usage limit reached. Resets at midnight UTC.",
      } satisfies TokenError,
      429,
    );
  }

  const usageData = (await usageResponse.json()) as {
    dailyRemainingMs: number;
    tokensGeneratedToday: number;
  };

  // Generate Gemini ephemeral token
  const ephemeral = await generateEphemeralToken(c.env.GEMINI_API_KEY, model);
  if (!ephemeral) {
    return c.json(
      {
        code: "token_generation_failed",
        message: "Failed to generate Gemini ephemeral token",
      } satisfies TokenError,
      502,
    );
  }

  return c.json({
    token: ephemeral.token,
    expiresAt: ephemeral.expiresAt,
    dailyRemainingMs: usageData.dailyRemainingMs,
    tokensGeneratedToday: usageData.tokensGeneratedToday,
  } satisfies TokenResponse);
});

export default {
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;
