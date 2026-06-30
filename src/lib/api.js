// Real HTTP access to the three.ws API. No mocks, no fixtures — every call is
// a live request to THREE_WS_BASE. Errors are normalized into a single shape so
// tool handlers can surface a clean message + status to the MCP client.

import { THREE_WS_BASE, HTTP_TIMEOUT_MS, USER_AGENT, THREE_WS_API_KEY } from '../config.js';

// Shared request headers. The optional bearer credential authenticates the
// caller so the router will serve the paid first-party flagships (the free
// open-weight tiers are served without it). One auth source, no second client.
function authHeaders(extra = {}) {
	return {
		'user-agent': USER_AGENT,
		...(THREE_WS_API_KEY ? { authorization: `Bearer ${THREE_WS_API_KEY}` } : {}),
		...extra,
	};
}

/**
 * Call a three.ws HTTP endpoint and return its parsed JSON body.
 *
 * @param {string} path  Endpoint path beginning with `/` (e.g. `/api/brain/chat`).
 * @param {{ method?: string, query?: Record<string, unknown>, body?: unknown }} [opts]
 * @returns {Promise<any>} Parsed JSON response.
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error'),
 *   and on upstream errors `.status` + `.body`.
 */
export async function apiRequest(path, { method = 'GET', query, body } = {}) {
	const url = new URL(`${THREE_WS_BASE}${path}`);
	if (query) {
		for (const [key, value] of Object.entries(query)) {
			if (value === undefined || value === null || value === '') continue;
			url.searchParams.set(key, String(value));
		}
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(url, {
			method,
			headers: authHeaders({
				accept: 'application/json',
				...(body !== undefined ? { 'content-type': 'application/json' } : {}),
			}),
			body: body !== undefined ? JSON.stringify(body) : undefined,
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`three.ws ${path} timed out after ${HTTP_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`three.ws ${path} request failed: ${err?.message || err}`), {
			code: 'network_error',
		});
	}
	clearTimeout(timer);

	const text = await res.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}

	if (!res.ok) {
		const message =
			data?.error_description || data?.message || data?.error || `three.ws ${path} returned HTTP ${res.status}`;
		throw Object.assign(new Error(message), { code: 'upstream_error', status: res.status, body: data });
	}
	return data;
}

/**
 * POST to the streaming /api/brain/chat router and collapse its Server-Sent
 * Events into a single completion. MCP tool results are one payload, so we
 * consume the whole stream server-side — accumulating the text deltas, the
 * `meta` (provider/label/network/tier), any `fallback` route the router took,
 * timing, and the final `usage` — and return the finished message.
 *
 * SSE protocol emitted by api/brain/chat:
 *   event: meta     → { provider, label, network, tier }
 *   event: first    → { firstTokenMs }
 *   (data-only)     → a JSON-encoded text chunk
 *   event: fallback → { route }   (router rerouted around an upstream outage)
 *   event: done     → { elapsedMs, firstTokenMs, usage }
 *   event: error    → { message, elapsedMs }
 *   data: [DONE]
 *
 * @param {{ provider: string, messages: Array<{role:string,content:string}>, system?: string, maxTokens?: number }} body
 * @returns {Promise<{ text: string, meta: object|null, usage: object|null, timing: object, fallbackRoute: string|null }>}
 * @throws {Error} with `.code` ('timeout' | 'network_error' | 'upstream_error').
 */
export async function streamBrainChat(body) {
	const url = `${THREE_WS_BASE}/api/brain/chat`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);

	let res;
	try {
		res = await fetch(url, {
			method: 'POST',
			headers: authHeaders({ accept: 'text/event-stream', 'content-type': 'application/json' }),
			body: JSON.stringify(body),
			signal: controller.signal,
		});
	} catch (err) {
		clearTimeout(timer);
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`three.ws /api/brain/chat timed out after ${HTTP_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`three.ws /api/brain/chat request failed: ${err?.message || err}`), {
			code: 'network_error',
		});
	}

	// A request the router rejects before streaming (unknown provider, sign-in
	// required, no key configured, rate limited) comes back as a non-200 JSON
	// body — not SSE. Normalize it the same way apiRequest does.
	if (!res.ok || !res.body) {
		clearTimeout(timer);
		const raw = await res.text().catch(() => '');
		let data;
		try {
			data = raw ? JSON.parse(raw) : {};
		} catch {
			data = { raw };
		}
		const message =
			data?.error_description || data?.message || data?.error || `three.ws /api/brain/chat returned HTTP ${res.status}`;
		throw Object.assign(new Error(message), { code: 'upstream_error', status: res.status, body: data });
	}

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	let chunks = '';
	let meta = null;
	let usage = null;
	let fallbackRoute = null;
	let firstTokenMs = null;
	let elapsedMs = null;
	let streamError = null;

	// Dispatch one parsed SSE event (event name + joined data payload).
	const dispatch = (eventName, data) => {
		if (data === '' || data === '[DONE]') return;
		// Data-only events (no `event:` line) are the visible text chunks: each is
		// a JSON-encoded string fragment of the model's reply.
		if (!eventName || eventName === 'message') {
			try {
				const piece = JSON.parse(data);
				if (typeof piece === 'string') chunks += piece;
			} catch {
				// Non-JSON data line — ignore rather than corrupt the transcript.
			}
			return;
		}
		let payload;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		if (eventName === 'meta') meta = payload;
		else if (eventName === 'first') firstTokenMs = payload?.firstTokenMs ?? firstTokenMs;
		else if (eventName === 'fallback') fallbackRoute = payload?.route ?? fallbackRoute;
		else if (eventName === 'done') {
			usage = payload?.usage ?? null;
			elapsedMs = payload?.elapsedMs ?? elapsedMs;
			firstTokenMs = payload?.firstTokenMs ?? firstTokenMs;
		} else if (eventName === 'error') {
			streamError = payload?.message || 'upstream stream error';
		}
	};

	// Parse a complete SSE block (the lines between blank-line separators).
	const flushBlock = (block) => {
		if (!block.trim()) return;
		let eventName = null;
		const dataLines = [];
		for (const line of block.split('\n')) {
			if (line.startsWith('event:')) eventName = line.slice(6).trim();
			else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
		}
		if (dataLines.length || eventName) dispatch(eventName, dataLines.join('\n'));
	};

	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			// SSE events are separated by a blank line. Process every complete block;
			// keep the trailing partial in the buffer for the next read.
			let sep;
			while ((sep = buf.indexOf('\n\n')) !== -1) {
				flushBlock(buf.slice(0, sep));
				buf = buf.slice(sep + 2);
			}
		}
		flushBlock(buf);
	} catch (err) {
		if (err?.name === 'AbortError') {
			throw Object.assign(new Error(`three.ws /api/brain/chat timed out after ${HTTP_TIMEOUT_MS}ms`), {
				code: 'timeout',
			});
		}
		throw Object.assign(new Error(`three.ws /api/brain/chat stream failed: ${err?.message || err}`), {
			code: 'network_error',
		});
	} finally {
		clearTimeout(timer);
	}

	// The router emits an `error` event only when no token streamed — surface it
	// as an upstream error so the caller doesn't mistake an empty reply for success.
	if (streamError && !chunks) {
		throw Object.assign(new Error(streamError), { code: 'upstream_error', status: 502 });
	}

	return {
		text: chunks,
		meta,
		usage,
		fallbackRoute,
		timing: { firstTokenMs, elapsedMs },
	};
}
