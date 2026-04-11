import { Hono } from 'hono';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import {
	RATE_LIMITS,
	SESSION_LIMITS,
	type ClientMessage,
	type ServerMessage,
} from '@realtime/shared';
import { z } from 'zod';

interface Env {
	MY_DURABLE_OBJECT: DurableObjectNamespace;
	SUPABASE_URL: string;
	SUPABASE_JWT_AUDIENCE?: string;
	SUPABASE_JWT_ISSUER?: string;
	ALLOW_LEGACY_DEV_JWT?: string;
	JWT_SECRET?: string;
	GEMINI_API_KEY?: string;
}

interface SessionState {
	activeSince: number | null;
	activeMsToday: number;
	requestsInCurrentMinute: number;
	concurrentRequests: number;
	currentMinuteKey: string;
}

interface AuthSession {
	userId: string;
	deviceId: string;
	sessionId: string;
}

interface DurableEnvelope {
	messages: ServerMessage[];
}

const SUPPORTED_LANGUAGES = new Set([
	'en-US',
	'hi-IN',
	'es-ES',
	'fr-FR',
	'de-DE',
	'it-IT',
	'pt-BR',
	'ru-RU',
	'ja-JP',
	'ko-KR',
	'zh-CN',
	'ar-SA',
]);

const authSchema = z.object({
	type: z.literal('auth'),
	token: z.string().min(1),
	deviceId: z.string().min(1),
});

const translateSchema = z.object({
	type: z.literal('translate'),
	utteranceId: z.string().min(1),
	text: z.string().min(1).max(SESSION_LIMITS.maxCharsPerRequest),
	sourceLang: z.string().min(2),
	targetLang: z.string().min(2),
	speaker: z.enum(['you', 'them']),
});

const pingSchema = z.object({
	type: z.literal('ping'),
	sentAt: z.number(),
});

const disconnectSchema = z.object({
	type: z.literal('disconnect'),
	reason: z.enum(['meeting_ended', 'user_stopped', 'shutdown']),
});

const clientMessageSchema = z.discriminatedUnion('type', [
	authSchema,
	translateSchema,
	pingSchema,
	disconnectSchema,
]);

const parseClientMessage = (raw: string): ClientMessage | null => {
	try {
		const parsedJson = JSON.parse(raw);
		const parsed = clientMessageSchema.safeParse(parsedJson);
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
};

const minuteKey = (date: Date): string => {
	const yyyy = date.getUTCFullYear();
	const mm = `${date.getUTCMonth() + 1}`.padStart(2, '0');
	const dd = `${date.getUTCDate()}`.padStart(2, '0');
	const hh = `${date.getUTCHours()}`.padStart(2, '0');
	const min = `${date.getUTCMinutes()}`.padStart(2, '0');
	return `${yyyy}${mm}${dd}${hh}${min}`;
};

const defaultState = (): SessionState => ({
	activeSince: null,
	activeMsToday: 0,
	requestsInCurrentMinute: 0,
	concurrentRequests: 0,
	currentMinuteKey: minuteKey(new Date()),
});

const encodeEnvelope = (messages: ServerMessage[]): string =>
	JSON.stringify({ messages } satisfies DurableEnvelope);

const parseEnvelope = (raw: string): DurableEnvelope | null => {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			!('messages' in parsed) ||
			!Array.isArray((parsed as { messages: unknown }).messages)
		) {
			return null;
		}

		return parsed as DurableEnvelope;
	} catch {
		return null;
	}
};

const buildTranslationPrompt = (
	text: string,
	sourceLang: string,
	targetLang: string,
): string => {
	return `Translate from ${sourceLang} to ${targetLang}. Output ONLY the translation. Text: ${text}`;
};

const parseClaims = (payload: JWTPayload): { sub: string } | null => {
	const sub = payload.sub;

	if (typeof sub !== 'string') {
		return null;
	}

	return { sub };
};

const isLanguageSupported = (language: string): boolean =>
	SUPPORTED_LANGUAGES.has(language);

const isSuspiciousPromptInjection = (text: string): boolean => {
	return /ignore\s+previous|system\s+prompt|developer\s+instruction/i.test(text);
};

const sanitizeText = (text: string): string => {
	return text
		.replace(/[`*_#[\]{}<>]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
};

const toPrimaryHttpMessage = (messages: ServerMessage[]): ServerMessage => {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (!message) {
			continue;
		}

		if (
			message.type !== 'rate_warning' &&
			message.type !== 'session_warning' &&
			message.type !== 'pong'
		) {
			return message;
		}
	}

	return {
		type: 'error',
		code: 'invalid_payload',
		message: 'No proxy message returned',
	};
};

const parseBooleanFlag = (value: string | undefined): boolean => {
	if (!value) {
		return false;
	}

	return value.toLowerCase() === 'true' || value === '1';
};

export class MyDurableObject {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly sessions = new Map<string, SessionState>();
	private readonly authByConnection = new Map<string, AuthSession>();
	private readonly supabaseJWKS: ReturnType<typeof createRemoteJWKSet>;
	private readonly supabaseIssuer: string;
	private readonly supabaseAudience: string;
	private readonly allowLegacyDevJWT: boolean;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;

		this.supabaseIssuer =
			env.SUPABASE_JWT_ISSUER || `${env.SUPABASE_URL}/auth/v1`;
		this.supabaseAudience = env.SUPABASE_JWT_AUDIENCE || 'authenticated';
		this.supabaseJWKS = createRemoteJWKSet(
			new URL(`${env.SUPABASE_URL}/auth/v1/.well-known/jwks.json`),
		);
		this.allowLegacyDevJWT = parseBooleanFlag(env.ALLOW_LEGACY_DEV_JWT);
	}

	private getSession(userId: string): SessionState {
		const existing = this.sessions.get(userId);
		if (existing) {
			return existing;
		}

		const created = defaultState();
		this.sessions.set(userId, created);
		return created;
	}

	private rotateMinuteWindow(session: SessionState, now: Date): void {
		const key = minuteKey(now);
		if (session.currentMinuteKey !== key) {
			session.currentMinuteKey = key;
			session.requestsInCurrentMinute = 0;
		}
	}

	private trackActiveUsage(session: SessionState, nowMs: number): void {
		if (session.activeSince === null) {
			session.activeSince = nowMs;
			return;
		}

		const gap = nowMs - session.activeSince;
		if (gap <= SESSION_LIMITS.idleGapMs) {
			session.activeMsToday += gap;
		}

		session.activeSince = nowMs;
	}

	private getAuth(connectionId: string): AuthSession | null {
		const auth = this.authByConnection.get(connectionId);
		return auth ?? null;
	}

	private async verifyTokenClaims(
		token: string,
	): Promise<{ sub: string } | null> {
		try {
			const verified = await jwtVerify(token, this.supabaseJWKS, {
				issuer: this.supabaseIssuer,
				audience: this.supabaseAudience,
			});
			return parseClaims(verified.payload);
		} catch {
			if (!this.allowLegacyDevJWT || !this.env.JWT_SECRET) {
				return null;
			}

			try {
				const secret = new TextEncoder().encode(this.env.JWT_SECRET);
				const verified = await jwtVerify(token, secret);
				return parseClaims(verified.payload);
			} catch {
				return null;
			}
		}
	}

	private async handleAuth(
		connectionId: string,
		message: Extract<ClientMessage, { type: 'auth' }>,
	): Promise<ServerMessage[]> {
		const claims = await this.verifyTokenClaims(message.token);

		if (!claims) {
			return [
				{
					type: 'error',
					code: 'unauthorized',
					message: 'Token verification failed',
				},
			];
		}

		const sessionId = `${claims.sub}-${Date.now()}`;
		this.authByConnection.set(connectionId, {
			userId: claims.sub,
			deviceId: message.deviceId,
			sessionId,
		});

		const session = this.getSession(claims.sub);
		const remainingMs = Math.max(
			0,
			SESSION_LIMITS.dailySessionMs - session.activeMsToday,
		);

		return [
			{
				type: 'auth_ok',
				sessionId,
				dailyRemainingMs: remainingMs,
				rpmRemaining: Math.max(
					0,
					RATE_LIMITS.perUserRequestsPerMinute -
						session.requestsInCurrentMinute,
				),
			},
		];
	}

	private async handleTranslate(
		connectionId: string,
		message: Extract<ClientMessage, { type: 'translate' }>,
	): Promise<ServerMessage[]> {
		const auth = this.getAuth(connectionId);
		if (!auth) {
			return [
				{
					type: 'error',
					code: 'session_required',
					message: 'Authenticate before translate requests',
					utteranceId: message.utteranceId,
				},
			];
		}

		if (
			!isLanguageSupported(message.sourceLang) ||
			!isLanguageSupported(message.targetLang)
		) {
			return [
				{
					type: 'error',
					code: 'invalid_language',
					message: 'Unsupported language pair',
					utteranceId: message.utteranceId,
				},
			];
		}

		if (message.text.length > SESSION_LIMITS.maxCharsPerRequest) {
			return [
				{
					type: 'error',
					code: 'text_too_long',
					message: `Text exceeds max length ${SESSION_LIMITS.maxCharsPerRequest}`,
					utteranceId: message.utteranceId,
				},
			];
		}

		if (isSuspiciousPromptInjection(message.text)) {
			return [
				{
					type: 'error',
					code: 'invalid_payload',
					message: 'Input contains blocked instruction-like patterns',
					utteranceId: message.utteranceId,
				},
			];
		}

		const session = this.getSession(auth.userId);
		const now = new Date();

		this.rotateMinuteWindow(session, now);
		this.trackActiveUsage(session, now.getTime());

		if (session.activeMsToday >= SESSION_LIMITS.dailySessionMs) {
			return [
				{
					type: 'session_expired',
					resetAtUtc: '00:00:00Z',
				},
			];
		}

		if (session.concurrentRequests >= RATE_LIMITS.perUserConcurrentRequests) {
			return [
				{
					type: 'rate_limited',
					retryAfterMs: 1000,
					utteranceId: message.utteranceId,
				},
			];
		}

		if (
			session.requestsInCurrentMinute >= RATE_LIMITS.perUserRequestsPerMinute
		) {
			return [
				{
					type: 'rate_limited',
					retryAfterMs: 1000,
					utteranceId: message.utteranceId,
				},
			];
		}

		session.requestsInCurrentMinute += 1;
		session.concurrentRequests += 1;

		const messages: ServerMessage[] = [];

		const remainingRpm =
			RATE_LIMITS.perUserRequestsPerMinute - session.requestsInCurrentMinute;
		if (
			remainingRpm <=
			Math.floor(
				RATE_LIMITS.perUserRequestsPerMinute *
					(1 - SESSION_LIMITS.warningThresholdRatio),
			)
		) {
			messages.push({
				type: 'rate_warning',
				remaining: Math.max(0, remainingRpm),
				limit: RATE_LIMITS.perUserRequestsPerMinute,
			});
		}

		const remainingDailyMs = Math.max(
			0,
			SESSION_LIMITS.dailySessionMs - session.activeMsToday,
		);
		if (
			remainingDailyMs <=
			SESSION_LIMITS.dailySessionMs * (1 - SESSION_LIMITS.warningThresholdRatio)
		) {
			messages.push({
				type: 'session_warning',
				dailyRemainingMs: remainingDailyMs,
			});
		}

		const sanitizedText = sanitizeText(message.text);

		try {
			if (!this.env.GEMINI_API_KEY) {
				messages.push({
					type: 'translation_chunk',
					utteranceId: message.utteranceId,
					chunk: `[${message.targetLang}] ${sanitizedText}`,
					done: true,
				});
				return messages;
			}

			const response = await fetch(
				'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						'x-goog-api-key': this.env.GEMINI_API_KEY,
					},
					body: JSON.stringify({
						contents: [
							{
								role: 'user',
								parts: [
									{
										text: buildTranslationPrompt(
											sanitizedText,
											message.sourceLang,
											message.targetLang,
										),
									},
								],
							},
						],
						generationConfig: {
							temperature: 0,
						},
					}),
				},
			);

			if (!response.ok) {
				messages.push({
					type: 'error',
					code: 'translation_failed',
					message: `Gemini request failed with status ${response.status}`,
					utteranceId: message.utteranceId,
				});
				return messages;
			}

			const payload: unknown = await response.json();
			const candidates =
				typeof payload === 'object' &&
				payload !== null &&
				'candidates' in payload &&
				Array.isArray((payload as { candidates: unknown }).candidates)
					? (payload as {
							candidates: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
					  }).candidates
					: [];

			const translation = candidates[0]?.content?.parts?.[0]?.text ?? '';
			if (!translation) {
				messages.push({
					type: 'error',
					code: 'translation_failed',
					message: 'Gemini returned an empty translation',
					utteranceId: message.utteranceId,
				});
				return messages;
			}

			messages.push({
				type: 'translation_chunk',
				utteranceId: message.utteranceId,
				chunk: translation.trim(),
				done: true,
			});
			return messages;
		} catch (error) {
			messages.push({
				type: 'error',
				code: 'translation_failed',
				message:
					error instanceof Error ? error.message : 'Translation request failed',
				utteranceId: message.utteranceId,
			});
			return messages;
		} finally {
			session.concurrentRequests = Math.max(0, session.concurrentRequests - 1);
		}
	}

	private async processRawMessage(
		connectionId: string,
		raw: string,
	): Promise<ServerMessage[]> {
		const message = parseClientMessage(raw);

		if (!message) {
			return [
				{
					type: 'error',
					code: 'invalid_payload',
					message: 'Client message validation failed',
				},
			];
		}

		switch (message.type) {
			case 'ping':
				return [
					{
						type: 'pong',
						sentAt: message.sentAt,
					},
				];
			case 'disconnect':
				this.authByConnection.delete(connectionId);
				return [
					{
						type: 'pong',
						sentAt: Date.now(),
					},
				];
			case 'auth':
				return this.handleAuth(connectionId, message);
			case 'translate':
				return this.handleTranslate(connectionId, message);
			default:
				return [
					{
						type: 'error',
						code: 'invalid_payload',
						message: 'Unsupported message type',
					},
				];
		}
	}

	async fetch(request: Request): Promise<Response> {
		const raw = await request.text();
		const connectionId = request.headers.get('x-connection-id') ?? 'unknown';
		const messages = await this.processRawMessage(connectionId, raw);

		return new Response(encodeEnvelope(messages), {
			headers: {
				'content-type': 'application/json',
			},
		});
	}
}

const app = new Hono<{ Bindings: Env }>();

const getDurableStub = (env: Env): DurableObjectStub => {
	const id = env.MY_DURABLE_OBJECT.idFromName('session');
	return env.MY_DURABLE_OBJECT.get(id);
};

app.get('/health', (context) => {
	return context.json({ ok: true });
});

app.post('/message', async (context) => {
	const stub = getDurableStub(context.env);
	const body = await context.req.text();

	const response = await stub.fetch('https://do/message', {
		method: 'POST',
		headers: {
			'x-connection-id': 'http-legacy',
		},
		body,
	});

	const text = await response.text();
	const envelope = parseEnvelope(text);
	if (!envelope || envelope.messages.length === 0) {
		return context.json(
			{
				type: 'error',
				code: 'invalid_payload',
				message: 'Proxy returned empty response',
			} satisfies ServerMessage,
			500,
		);
	}

	return context.json(toPrimaryHttpMessage(envelope.messages));
});

app.get('/ws', async (context) => {
	const upgrade = context.req.header('Upgrade');

	if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
		return new Response('Expected websocket upgrade', { status: 426 });
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];
	const connectionId = crypto.randomUUID();

	const stub = getDurableStub(context.env);
	server.accept();

	server.addEventListener('message', async (event: MessageEvent) => {
		if (typeof event.data !== 'string') {
			server.send(
				JSON.stringify({
					type: 'error',
					code: 'invalid_payload',
					message: 'Only string payloads are supported',
				} satisfies ServerMessage),
			);
			return;
		}

		const response = await stub.fetch('https://do/message', {
			method: 'POST',
			headers: {
				'x-connection-id': connectionId,
			},
			body: event.data,
		});

		const text = await response.text();
		const envelope = parseEnvelope(text);

		if (!envelope || envelope.messages.length === 0) {
			server.send(
				JSON.stringify({
					type: 'error',
					code: 'invalid_payload',
					message: 'Proxy returned empty response',
				} satisfies ServerMessage),
			);
			return;
		}

		envelope.messages.forEach((message) => {
			server.send(JSON.stringify(message));
		});
	});

	server.addEventListener('close', async () => {
		await stub.fetch('https://do/message', {
			method: 'POST',
			headers: {
				'x-connection-id': connectionId,
			},
			body: JSON.stringify({
				type: 'disconnect',
				reason: 'shutdown',
			} satisfies ClientMessage),
		});
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
