import { Hono } from 'hono';
import { jwtVerify, type JWTPayload } from 'jose';
import { RATE_LIMITS, SESSION_LIMITS, type ClientMessage, type ServerMessage } from '@realtime/shared';
import { z } from 'zod';

interface Env {
	MY_DURABLE_OBJECT: DurableObjectNamespace;
	JWT_SECRET: string;
	GEMINI_API_KEY?: string;
}

interface SessionState {
	activeSince: number | null;
	activeMsToday: number;
	requestsInCurrentMinute: number;
	currentMinuteKey: string;
}

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

const clientMessageSchema = z.discriminatedUnion('type', [authSchema, translateSchema, pingSchema, disconnectSchema]);

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
	currentMinuteKey: minuteKey(new Date()),
});

const encode = (message: ServerMessage): string => JSON.stringify(message);

const buildTranslationPrompt = (text: string, sourceLang: string, targetLang: string): string => {
	return `Translate from ${sourceLang} to ${targetLang}. Output ONLY the translation. Text: ${text}`;
};

const parseClaims = (payload: JWTPayload): { sub: string; deviceId: string } | null => {
	const sub = payload.sub;
	const deviceId = payload.deviceId;

	if (typeof sub !== 'string' || typeof deviceId !== 'string') {
		return null;
	}

	return { sub, deviceId };
};

export class MyDurableObject {
	private readonly state: DurableObjectState;
	private readonly env: Env;
	private readonly sessions = new Map<string, SessionState>();

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
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

	private async handleAuth(message: Extract<ClientMessage, { type: 'auth' }>): Promise<ServerMessage> {
		try {
			const secret = new TextEncoder().encode(this.env.JWT_SECRET);
			const verified = await jwtVerify(message.token, secret);
			const claims = parseClaims(verified.payload);

			if (!claims) {
				return {
					type: 'error',
					code: 'unauthorized',
					message: 'Token claims are invalid',
				};
			}

			if (claims.deviceId !== message.deviceId) {
				return {
					type: 'error',
					code: 'device_mismatch',
					message: 'Token device mismatch',
				};
			}

			const session = this.getSession(claims.sub);
			const remainingMs = Math.max(0, SESSION_LIMITS.dailySessionMs - session.activeMsToday);

			return {
				type: 'auth_ok',
				sessionId: `session-${claims.sub}`,
				dailyRemainingMs: remainingMs,
				rpmRemaining: Math.max(0, RATE_LIMITS.perUserRequestsPerMinute - session.requestsInCurrentMinute),
			};
		} catch {
			return {
				type: 'error',
				code: 'unauthorized',
				message: 'Token verification failed',
			};
		}
	}

	private async handleTranslate(message: Extract<ClientMessage, { type: 'translate' }>): Promise<ServerMessage> {
		const userId = 'anonymous';
		const session = this.getSession(userId);
		const now = new Date();

		this.rotateMinuteWindow(session, now);
		this.trackActiveUsage(session, now.getTime());

		if (session.activeMsToday >= SESSION_LIMITS.dailySessionMs) {
			return {
				type: 'session_expired',
				resetAtUtc: '00:00:00Z',
			};
		}

		if (session.requestsInCurrentMinute >= RATE_LIMITS.perUserRequestsPerMinute) {
			return {
				type: 'rate_limited',
				retryAfterMs: 1000,
			};
		}

		session.requestsInCurrentMinute += 1;

		if (!this.env.GEMINI_API_KEY) {
			return {
				type: 'translation_chunk',
				utteranceId: message.utteranceId,
				chunk: `[${message.targetLang}] ${message.text}`,
				done: true,
			};
		}

		try {
			const response = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent', {
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
									text: buildTranslationPrompt(message.text, message.sourceLang, message.targetLang),
								},
							],
						},
					],
					generationConfig: {
						temperature: 0,
					},
				}),
			});

			if (!response.ok) {
				return {
					type: 'error',
					code: 'translation_failed',
					message: `Gemini request failed with status ${response.status}`,
					utteranceId: message.utteranceId,
				};
			}

			const payload: unknown = await response.json();
			const candidates =
				typeof payload === 'object' &&
				payload !== null &&
				'candidates' in payload &&
				Array.isArray((payload as { candidates: unknown }).candidates)
					? (payload as { candidates: Array<{ content?: { parts?: Array<{ text?: string }> } }> }).candidates
					: [];

			const translation = candidates[0]?.content?.parts?.[0]?.text ?? '';

			if (!translation) {
				return {
					type: 'error',
					code: 'translation_failed',
					message: 'Gemini returned an empty translation',
					utteranceId: message.utteranceId,
				};
			}

			return {
				type: 'translation_chunk',
				utteranceId: message.utteranceId,
				chunk: translation.trim(),
				done: true,
			};
		} catch (error) {
			const messageText = error instanceof Error ? error.message : 'Translation request failed';
			return {
				type: 'error',
				code: 'translation_failed',
				message: messageText,
				utteranceId: message.utteranceId,
			};
		}
	}

	private async processRawMessage(raw: string): Promise<ServerMessage> {
		const message = parseClientMessage(raw);

		if (!message) {
			return {
				type: 'error',
				code: 'invalid_payload',
				message: 'Client message validation failed',
			};
		}

		switch (message.type) {
			case 'ping':
				return {
					type: 'pong',
					sentAt: message.sentAt,
				};
			case 'disconnect':
				return {
					type: 'error',
					code: 'invalid_payload',
					message: `Disconnected: ${message.reason}`,
				};
			case 'auth':
				return this.handleAuth(message);
			case 'translate':
				return this.handleTranslate(message);
			default:
				return {
					type: 'error',
					code: 'invalid_payload',
					message: 'Unsupported message type',
				};
		}
	}

	async fetch(request: Request): Promise<Response> {
		const raw = await request.text();
		const response = await this.processRawMessage(raw);
		return new Response(encode(response), {
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
		body,
	});

	const text = await response.text();
	return new Response(text, {
		status: response.status,
		headers: {
			'content-type': 'application/json',
		},
	});
});

app.get('/ws', async (context) => {
	const upgrade = context.req.header('Upgrade');

	if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
		return new Response('Expected websocket upgrade', { status: 426 });
	}

	const pair = new WebSocketPair();
	const client = pair[0];
	const server = pair[1];

	const stub = getDurableStub(context.env);
	server.accept();

	server.addEventListener('message', async (event: MessageEvent) => {
		if (typeof event.data !== 'string') {
			server.send(
				encode({
					type: 'error',
					code: 'invalid_payload',
					message: 'Only string payloads are supported',
				}),
			);
			return;
		}

		const response = await stub.fetch('https://do/message', {
			method: 'POST',
			body: event.data,
		});

		server.send(await response.text());
	});

	server.addEventListener('close', () => {
		server.close();
	});

	return new Response(null, {
		status: 101,
		webSocket: client,
	});
});

export default {
	fetch: app.fetch,
} satisfies ExportedHandler<Env>;
