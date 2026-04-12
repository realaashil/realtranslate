import {
  RETRY_BACKOFF_MS,
  GEMINI_MODELS,
  type TokenResponse,
  type TokenError,
} from "@realtime/shared";

export interface TokenServiceConfig {
  serviceUrl: string;
}

export class TokenServiceClient {
  private config: TokenServiceConfig;

  constructor(config: TokenServiceConfig) {
    this.config = config;
  }

  updateConfig(config: Partial<TokenServiceConfig>): void {
    this.config = { ...this.config, ...config };
  }

  async requestToken(
    supabaseAccessToken: string,
    model?: string,
  ): Promise<TokenResponse> {
    const url = `${this.config.serviceUrl}/api/token`;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= 2; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_BACKOFF_MS[attempt - 1] ?? 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }

      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${supabaseAccessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: model ?? GEMINI_MODELS.live,
          }),
        });

        if (response.ok) {
          return (await response.json()) as TokenResponse;
        }

        const errorBody = (await response.json().catch(() => ({
          code: "token_generation_failed",
          message: `HTTP ${response.status}`,
        }))) as TokenError;

        // Don't retry on auth or usage errors
        if (
          response.status === 401 ||
          response.status === 429
        ) {
          throw new TokenServiceError(
            errorBody.code,
            errorBody.message,
            errorBody.retryAfterMs,
          );
        }

        lastError = new TokenServiceError(
          errorBody.code,
          errorBody.message,
          errorBody.retryAfterMs,
        );
      } catch (err) {
        if (err instanceof TokenServiceError) {
          throw err;
        }
        lastError =
          err instanceof Error ? err : new Error("Token request failed");
      }
    }

    throw lastError ?? new Error("Token request failed after retries");
  }

  async reportUsage(
    supabaseAccessToken: string,
    durationMs: number,
  ): Promise<void> {
    const url = `${this.config.serviceUrl}/api/report-usage`;
    try {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${supabaseAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ durationMs }),
      });
    } catch {
      // Best-effort — don't fail the session stop if reporting fails
    }
  }

  async resetUsage(supabaseAccessToken: string): Promise<void> {
    const url = `${this.config.serviceUrl}/api/reset-usage`;
    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${supabaseAccessToken}`,
        "Content-Type": "application/json",
      },
    });
  }
}

export class TokenServiceError extends Error {
  readonly code: TokenError["code"];
  readonly retryAfterMs?: number;

  constructor(
    code: TokenError["code"],
    message: string,
    retryAfterMs?: number,
  ) {
    super(message);
    this.name = "TokenServiceError";
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}
