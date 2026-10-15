'use strict';
/**
 * Integration tests for the compiled BlueBubbles Trigger against an in-process
 * mock of the BlueBubbles Server webhook API (no extra dependencies).
 *
 * The mock reproduces the real server behaviour verified from
 * BlueBubblesApp/bluebubbles-server (master / v1.9.9):
 *  - auth via `guid` / `password` / `token` query param (authMiddleware.ts)
 *  - GET /api/v1/webhook?url=<unknown> -> HTTP 500 (getWebhooks returns [null])
 *  - POST validates `url` (must start with "http") and an event whitelist
 *  - one webhook per URL: POST for a known URL returns the existing row unchanged
 *  - DELETE of an unknown id -> 404 "Webhook does not exist!"
 *
 * The fake `httpRequestWithAuthentication` behaves like n8n-core: it appends the
 * password to the query string and throws `NodeApiError(node, axiosError)`, whose
 * axios config / request URL contain the password.
 *
 * Run `npm run build` first (the `test` script does this).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { BlueBubblesTrigger } = require(
	path.join(ROOT, 'dist/nodes/BlueBubbles/BlueBubblesTrigger.node.js'),
);
const { BlueBubblesApi } = require(
	path.join(ROOT, 'dist/credentials/BlueBubblesApi.credentials.js'),
);

const PASSWORD = 'sup3r-s3cret-pw';
const WEBHOOK_URL = 'https://n8n.example.com/webhook/abc/webhook';
const ALLOWED_EVENTS = new Set([
	'*',
	'new-message',
	'updated-message',
	'message-send-error',
	'group-name-change',
	'group-icon-changed',
	'group-icon-removed',
	'participant-removed',
	'participant-added',
	'participant-left',
	'chat-read-status-changed',
	'typing-indicator',
	'scheduled-message-error',
	'server-update',
	'new-server',
	'new-findmy-location',
	'hello-world',
	'incoming-facetime',
	'ft-call-status-changed',
	'imessage-alias-removed',
	'theme-backup-created',
	'theme-backup-updated',
	'theme-backup-deleted',
	'settings-backup-created',
	'settings-backup-updated',
	'settings-backup-deleted',
]);

// --------------------------------------------------------------------------
// Mock BlueBubbles server
// --------------------------------------------------------------------------
const bb = {
	/** @type {Map<number, {id: number, url: string, events: string}>} events stored as JSON string, like the DB */
	hooks: new Map(),
	nextId: 1,
	requests: [],
	failDeletes: false,
	failList: false,
	reset() {
		this.hooks.clear();
		this.nextId = 1;
		this.requests = [];
		this.failDeletes = false;
		this.failList = false;
	},
	add(url, events) {
		const hook = { id: this.nextId++, url, events: JSON.stringify(events) };
		this.hooks.set(hook.id, hook);
		return hook;
	},
};

const out = (hook) => ({
	...hook,
	events: JSON.parse(hook.events),
	created: '2026-01-01T00:00:00.000Z',
});
const ok = (message, data) => ({ status: 200, message, ...(data === undefined ? {} : { data }) });
const err = (status, message, type, errorMessage) => ({
	status,
	message,
	error: { type, message: errorMessage },
});

const server = http.createServer((req, res) => {
	let raw = '';
	req.on('data', (chunk) => (raw += chunk));
	req.on('end', () => {
		const url = new URL(req.url, 'http://mock');
		const query = Object.fromEntries(url.searchParams);
		const body = raw ? JSON.parse(raw) : undefined;
		bb.requests.push({ method: req.method, path: url.pathname, query, body });
		const send = (code, payload) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};

		const token = query.guid ?? query.password ?? query.token;
		if (!token)
			return send(
				401,
				err(
					401,
					'You are not authorized to access this resource',
					'Authentication Error',
					'Missing server password!',
				),
			);
		if (token.trim() !== PASSWORD)
			return send(
				401,
				err(
					401,
					'You are not authorized to access this resource',
					'Authentication Error',
					'Unauthorized',
				),
			);

		const match = url.pathname.match(/^\/bb\/api\/v1\/webhook(?:\/([^/]+))?$/);
		if (!match)
			return send(
				404,
				err(404, 'The requested resource was not found', 'Database Error', 'Not Found'),
			);
		const id = match[1];

		if (req.method === 'GET' && !id) {
			if (bb.failList)
				return send(503, err(503, 'Service unavailable', 'Server Error', 'Service unavailable'));
			if (query.url) {
				const found = [...bb.hooks.values()].find((h) => h.url === query.url);
				// Real server: [null] -> JSON.parse(null.events) -> TypeError -> 500
				if (!found)
					return send(
						500,
						err(
							500,
							'An unhandled error has occurred!',
							'Server Error',
							"Cannot read properties of null (reading 'events')",
						),
					);
				return send(200, ok('Successfully fetched webhooks!', [out(found)]));
			}
			return send(200, ok('Successfully fetched webhooks!', [...bb.hooks.values()].map(out)));
		}
		if (req.method === 'POST' && !id) {
			if (typeof body?.url !== 'string' || !Array.isArray(body?.events)) {
				return send(
					400,
					err(
						400,
						"You've made a bad request! Please check your request params & body",
						'Validation Error',
						'The url field is required.',
					),
				);
			}
			if (!body.url.startsWith('http'))
				return send(
					400,
					err(400, 'Bad Request', 'Validation Error', 'Webhook URL must include an HTTP scheme!'),
				);
			for (const event of body.events) {
				if (!ALLOWED_EVENTS.has(event))
					return send(
						400,
						err(400, 'Bad Request', 'Validation Error', `Invalid webhook event: ${event}!`),
					);
			}
			const existing = [...bb.hooks.values()].find((h) => h.url === body.url);
			const hook = existing ?? bb.add(body.url, body.events); // unique url: existing row returned unchanged
			return send(200, ok('Successfully created webhook!', out(hook)));
		}
		if (req.method === 'DELETE' && id) {
			if (bb.failDeletes)
				return send(
					500,
					err(
						500,
						'An unhandled error has occurred!',
						'Server Error',
						'SQLITE_BUSY: database is locked',
					),
				);
			if (!bb.hooks.delete(Number(id)))
				return send(
					404,
					err(
						404,
						'The requested resource was not found',
						'Database Error',
						'Webhook does not exist!',
					),
				);
			return send(200, ok('Successfully deleted webhook!'));
		}
		return send(404, err(404, 'Not Found', 'Database Error', 'Not Found'));
	});
});

// --------------------------------------------------------------------------
// Fake n8n hook context
// --------------------------------------------------------------------------
/** Mimics axios' AxiosError (NodeApiError detects it by constructor name). */
class AxiosError extends Error {
	constructor(message, code, config, response) {
		super(message);
		this.name = 'AxiosError';
		this.isAxiosError = true;
		this.code = code;
		this.config = config;
		this.request = {
			path: config.url.replace(/^https?:\/\/[^/]+/, ''),
			_header: `GET ${config.url}`,
		};
		if (response) this.response = response;
	}
}

const credentialType = new BlueBubblesApi();
const NODE = {
	id: '1',
	name: 'BlueBubbles Trigger',
	type: 'n8n-nodes-bluebubbles.blueBubblesTrigger',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

/** Send one request like n8n's helper does (password appended as a query param). */
function sendRequest(opts, credentials) {
	const authQs = {};
	for (const [key, expr] of Object.entries(credentialType.authenticate.properties.qs)) {
		const field = /\$credentials\.(\w+)/.exec(expr)[1];
		authQs[key] = credentials[field];
	}
	const url = new URL(opts.url);
	for (const [key, value] of Object.entries({ ...opts.qs, ...authQs }))
		url.searchParams.set(key, String(value));
	const config = {
		url: url.toString(),
		method: opts.method,
		params: { ...opts.qs, ...authQs },
		data: opts.body,
	};

	return new Promise((resolve, reject) => {
		const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
		const req = http.request(
			url,
			{
				method: opts.method,
				headers: payload ? { 'content-type': 'application/json' } : {},
				timeout: 2000,
			},
			(res) => {
				let text = '';
				res.on('data', (chunk) => (text += chunk));
				res.on('end', () => {
					let data = text;
					try {
						data = JSON.parse(text);
					} catch {
						// keep text
					}
					if (res.statusCode >= 400) {
						const response = {
							status: res.statusCode,
							statusText: res.statusMessage,
							data,
							headers: res.headers,
							config,
						};
						return reject(
							new AxiosError(
								`Request failed with status code ${res.statusCode}`,
								'ERR_BAD_REQUEST',
								config,
								response,
							),
						);
					}
					resolve(data);
				});
			},
		);
		req.on('timeout', () =>
			req.destroy(Object.assign(new Error('timeout of 2000ms exceeded'), { code: 'ECONNABORTED' })),
		);
		req.on('error', (e) => reject(new AxiosError(e.message, e.code, config)));
		if (payload) req.write(payload);
		req.end();
	});
}

const logs = [];
const thrown = [];

/**
 * @param {object} options
 * @param {string} options.serverUrl
 * @param {string} [options.password]
 * @param {string[]} [options.events]
 * @param {'nodeApiError'|'axios'|'plain'} [options.errorMode] how the helper surfaces errors
 */
function makeContext({
	serverUrl,
	password = PASSWORD,
	events = ['new-message'],
	errorMode = 'nodeApiError',
}) {
	const credentials = { serverUrl, password };
	const state = { events, staticData: {} };
	const logger = {};
	for (const level of ['error', 'warn', 'info', 'debug']) {
		logger[level] = (message, meta) => logs.push({ level, message: String(message), meta });
	}
	const ctx = {
		state,
		logger,
		getNode: () => NODE,
		getNodeWebhookUrl: () => WEBHOOK_URL,
		getNodeParameter: (name) => {
			assert.equal(name, 'events');
			return state.events;
		},
		getWorkflowStaticData: () => state.staticData,
		getCredentials: async (type) => {
			assert.equal(type, 'blueBubblesApi');
			return credentials;
		},
		helpers: {
			async httpRequestWithAuthentication(type, opts) {
				assert.equal(type, 'blueBubblesApi');
				try {
					return await sendRequest(opts, credentials);
				} catch (error) {
					if (errorMode === 'nodeApiError') throw new NodeApiError(NODE, error); // what n8n-core does
					if (errorMode === 'plain') {
						const plain = new Error(`${error.message} for ${error.config.url}`);
						plain.httpCode = error.response?.status; // numeric
						plain.response = error.response;
						plain.options = opts;
						throw plain;
					}
					throw error;
				}
			},
		},
	};
	return ctx;
}

const trigger = new BlueBubblesTrigger();
const hooks = trigger.webhookMethods.default;

async function run(ctx, method) {
	try {
		return await hooks[method].call(ctx);
	} catch (error) {
		thrown.push(error);
		throw error;
	}
}

/** Every place a secret could hide on an n8n error. */
function errorText(error) {
	const parts = [
		error.message,
		error.description,
		String(error.stack),
		JSON.stringify(error.messages ?? []),
	];
	for (const key of ['cause', 'context', 'errorResponse', 'httpCode']) {
		try {
			parts.push(JSON.stringify(error[key] ?? null));
		} catch {
			parts.push(String(error[key]));
		}
	}
	parts.push(JSON.stringify(error));
	return parts.join('\n');
}

let port;
let closedPort;
let base;

before(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	port = server.address().port;
	base = `http://127.0.0.1:${port}/bb/`; // reverse-proxy prefix + trailing slash
	const probe = http.createServer();
	await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
	closedPort = probe.address().port;
	await new Promise((resolve) => probe.close(resolve));
});

after(() => {
	server.close();
});

beforeEach(() => bb.reset());

// --------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------
test('first activation succeeds even though GET ?url= would return 500 (regression)', async () => {
	const ctx = makeContext({ serverUrl: base });
	assert.equal(await run(ctx, 'checkExists'), false);
	assert.equal(await run(ctx, 'create'), true);
	assert.equal(ctx.state.staticData.webhookId, 1);
	assert.deepEqual(JSON.parse(bb.hooks.get(1).events), ['new-message']);

	const list = bb.requests.find((r) => r.method === 'GET');
	assert.equal(list.query.url, undefined, 'must not use the server-side url filter');
	assert.deepEqual(bb.requests.find((r) => r.method === 'POST').body, {
		url: WEBHOOK_URL,
		events: ['new-message'],
	});
});

test('re-activation with the same events re-adopts the webhook', async () => {
	const existing = bb.add(WEBHOOK_URL, ['new-message']);
	bb.add('https://other.example.com/hook', ['*']);
	const ctx = makeContext({ serverUrl: base });
	assert.equal(await run(ctx, 'checkExists'), true);
	assert.equal(ctx.state.staticData.webhookId, existing.id);
	assert.equal(bb.hooks.size, 2);
	assert.equal(bb.requests.filter((r) => r.method !== 'GET').length, 0);
});

test('changed events: stale webhook removed, new one created (order-insensitive match)', async () => {
	bb.add(WEBHOOK_URL, ['typing-indicator']);
	const ctx = makeContext({ serverUrl: base, events: ['updated-message', 'new-message'] });
	assert.equal(await run(ctx, 'checkExists'), false);
	assert.equal(bb.hooks.size, 0);
	assert.equal(await run(ctx, 'create'), true);
	const [hook] = bb.hooks.values();
	assert.deepEqual(JSON.parse(hook.events), ['updated-message', 'new-message']);

	ctx.state.events = ['new-message', 'updated-message'];
	assert.equal(await run(ctx, 'checkExists'), true);
});

test('create replaces an existing same-URL webhook the server returned unchanged', async () => {
	bb.add(WEBHOOK_URL, ['typing-indicator']);
	bb.failDeletes = true; // stale cleanup in checkExists fails -> only a warning
	const ctx = makeContext({ serverUrl: base, events: ['*'] });
	assert.equal(await run(ctx, 'checkExists'), false);
	assert.ok(logs.some((l) => l.level === 'warn' && /outdated BlueBubbles webhook/.test(l.message)));

	bb.failDeletes = false;
	assert.equal(await run(ctx, 'create'), true);
	const [hook] = bb.hooks.values();
	assert.deepEqual(JSON.parse(hook.events), ['*']);
	assert.equal(ctx.state.staticData.webhookId, hook.id);
});

test('checkExists does not fail activation when listing fails', async () => {
	bb.failList = true;
	const ctx = makeContext({ serverUrl: base });
	assert.equal(await run(ctx, 'checkExists'), false);
	const warn = logs.findLast((l) => l.level === 'warn');
	assert.match(warn.message, /could not list webhooks/);
	assert.match(warn.meta.description, /HTTP status: 503/);
});

test('delete removes the webhook and clears static data; 404 is tolerated', async () => {
	for (const errorMode of ['nodeApiError', 'axios', 'plain']) {
		bb.reset();
		const ctx = makeContext({ serverUrl: base, errorMode });
		await run(ctx, 'create');
		assert.equal(await run(ctx, 'delete'), true);
		assert.equal(bb.hooks.size, 0);
		assert.equal('webhookId' in ctx.state.staticData, false);

		ctx.state.staticData.webhookId = 9999;
		assert.equal(await run(ctx, 'delete'), true, `404 tolerated (${errorMode})`);
		assert.equal('webhookId' in ctx.state.staticData, false);
		assert.equal(bb.requests.at(-1).path, '/bb/api/v1/webhook/9999');
	}
});

test('delete returns false (and keeps the id) on a non-404 failure', async () => {
	const ctx = makeContext({ serverUrl: base });
	ctx.state.staticData.webhookId = bb.add(WEBHOOK_URL, ['new-message']).id;
	bb.failDeletes = true;
	assert.equal(await run(ctx, 'delete'), false);
	assert.equal(ctx.state.staticData.webhookId, 1);
});

test('reverse-proxy prefix and trailing slash are preserved; password sent on every request', async () => {
	const ctx = makeContext({ serverUrl: base });
	await run(ctx, 'checkExists');
	await run(ctx, 'create');
	await run(ctx, 'delete');
	assert.ok(bb.requests.length >= 3);
	for (const r of bb.requests) {
		assert.ok(r.path.startsWith('/bb/api/v1/webhook') && !r.path.includes('//'), r.path);
		assert.equal(r.query.password, PASSWORD);
	}
});

test('webhook() emits the request body as a single item', async () => {
	const body = { type: 'new-message', data: { guid: 'x' } };
	const result = await trigger.webhook.call({
		getBodyData: () => body,
		helpers: { returnJsonArray: (d) => (Array.isArray(d) ? d : [d]).map((json) => ({ json })) },
	});
	assert.deepEqual(result.workflowData, [[{ json: body }]]);
});

// --------------------------------------------------------------------------
// Errors
// --------------------------------------------------------------------------
test('connection refused: clear message naming the URL and a Docker hint', async () => {
	const ctx = makeContext({ serverUrl: `http://127.0.0.1:${closedPort}` });
	assert.equal(await run(ctx, 'checkExists'), false); // list failure is non-fatal
	await assert.rejects(run(ctx, 'create'), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.message, 'Could not register the BlueBubbles webhook (connection refused)');
		assert.match(
			error.description,
			new RegExp(`Server URL: http://127\\.0\\.0\\.1:${closedPort}\\.`),
		);
		assert.match(error.description, /Request: POST \/api\/v1\/webhook\./);
		assert.match(error.description, /Network error: ECONNREFUSED\./);
		assert.match(error.description, /n8n could not reach http:\/\/127\.0\.0\.1:\d+/);
		assert.match(error.description, /host\.docker\.internal/);
		assert.match(error.description, /host-gateway/);
		return true;
	});
});

test('401: password hint and the BlueBubbles error message', async () => {
	const ctx = makeContext({ serverUrl: base, password: 'wrong-password' });
	await assert.rejects(run(ctx, 'create'), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.httpCode, '401');
		assert.equal(error.message, 'Could not register the BlueBubbles webhook (HTTP 401)');
		assert.match(error.description, /HTTP status: 401\./);
		assert.match(
			error.description,
			/BlueBubbles error: Unauthorized \(You are not authorized to access this resource\)\./,
		);
		assert.match(error.description, /check the server password/i);
		return true;
	});
});

test('404: server URL / version hint', async () => {
	const ctx = makeContext({ serverUrl: `http://127.0.0.1:${port}/wrong-prefix` });
	await assert.rejects(run(ctx, 'create'), (error) => {
		assert.equal(error.httpCode, '404');
		assert.match(error.description, /Check the server URL/);
		assert.match(error.description, /1\.9\.9 or newer/);
		return true;
	});
});

test('400 from the server event whitelist is surfaced', async () => {
	const ctx = makeContext({ serverUrl: base, events: ['not-an-event'] });
	await assert.rejects(run(ctx, 'create'), /HTTP 400/);
	assert.match(thrown.at(-1).description, /Invalid webhook event: not-an-event!/);
});

test('invalid server URL scheme gives a clear NodeOperationError', async () => {
	for (const serverUrl of [
		'192.168.1.146:1234',
		'ftp://host:1234',
		'',
		'http://host:1234/?password=abc',
	]) {
		const ctx = makeContext({ serverUrl });
		await assert.rejects(run(ctx, 'create'), (error) => {
			assert.ok(error instanceof NodeOperationError, `${serverUrl}: ${error}`);
			assert.equal(error.message, 'Invalid BlueBubbles server URL');
			assert.match(error.description, /http:\/\/ or https:\/\/|query string/);
			assert.ok(!error.description.includes('password=abc'));
			return true;
		});
	}
	assert.equal(bb.requests.length, 0);
});

test('no password in any thrown error or log line (all error shapes)', async () => {
	for (const errorMode of ['nodeApiError', 'axios', 'plain']) {
		// HTTP errors with a correct password (500 on stale delete) and with a wrong
		// password that contains the real one as a prefix.
		bb.reset();
		bb.add(WEBHOOK_URL, ['typing-indicator']);
		bb.failDeletes = true;
		const ctx = makeContext({ serverUrl: base, errorMode, events: ['new-message'] });
		await run(ctx, 'checkExists');
		ctx.state.staticData.webhookId = 1;
		await run(ctx, 'delete');
		await run(makeContext({ serverUrl: base, errorMode }), 'create').catch(() => {}); // returns stale row -> replace fails
		await run(
			makeContext({ serverUrl: base, errorMode, password: `${PASSWORD}-wrong` }),
			'create',
		).catch(() => {});
		// Network error
		await run(
			makeContext({ serverUrl: `http://127.0.0.1:${closedPort}`, errorMode }),
			'create',
		).catch(() => {});
	}

	assert.ok(thrown.length >= 9, `expected errors to inspect, got ${thrown.length}`);
	for (const error of thrown) {
		const text = errorText(error);
		assert.ok(!text.includes(PASSWORD), `error leaks password: ${text}`);
		assert.ok(!/password=/i.test(text), `error leaks password query: ${text}`);
	}
	for (const line of logs) {
		const text = `${line.message} ${JSON.stringify(line.meta ?? {})}`;
		assert.ok(!text.includes(PASSWORD), `log leaks password: ${text}`);
		assert.ok(!/password=/i.test(text), `log leaks password query: ${text}`);
	}
});
