'use strict';
/**
 * Request-shape tests for the Message, Scheduled Message and Attachment
 * resource executors of the BlueBubbles action node, against an in-process
 * mock BlueBubbles server.
 *
 * The fake n8n context mirrors test/generic.test.cjs: its
 * `httpRequestWithAuthentication` adds the password from the credential's
 * `authenticate.qs`, honours `json` / `encoding` / `returnFullResponse`, sends a
 * FormData body as multipart, and throws `NodeApiError(node, axiosError)` whose
 * axios config contains the password.
 *
 * Run `npm run build` first (the `test` script does this).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const ACTIONS = path.join(ROOT, 'dist/nodes/BlueBubbles/actions');
const message = require(path.join(ACTIONS, 'message.js'));
const scheduledMessage = require(path.join(ACTIONS, 'scheduledMessage.js'));
const attachment = require(path.join(ACTIONS, 'attachment.js'));
const H = require(path.join(ACTIONS, 'messageHelpers.js'));
const G = require(path.join(ROOT, 'dist/nodes/BlueBubbles/GenericFunctions.js'));
const { BlueBubblesApi } = require(
	path.join(ROOT, 'dist/credentials/BlueBubblesApi.credentials.js'),
);

const PASSWORD = 'sup3r-s3cret-pw';
const TEMP_GUID = /^temp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const LIKE_STATEMENT = "message.text LIKE :query ESCAPE '\\'";

// --------------------------------------------------------------------------
// Mock BlueBubbles server
// --------------------------------------------------------------------------
const bb = {
	reset() {
		this.requests = [];
		this.serverInfo = { private_api: true, helper_connected: true };
		this.chatMessageCount = 30;
		this.searchCount = 30;
		this.lookupFails = false;
		// Status the mock answers for a Spotlight-shaped search (0 = success).
		this.spotlightStatus = 0;
		// When set, the fake HTTP helper times out Spotlight-shaped searches.
		this.spotlightTimesOut = false;
		this.envelopeError = false;
		this.schedules = [
			{ id: 1, status: 'pending' },
			{ id: 2, status: 'error', error: 'Helper disconnected' },
			{ id: 3, status: 'complete' },
		];
	},
};
bb.reset();

const ok = (data) => ({ status: 200, message: 'Success', data });
const err = (status, msg, errorMessage) => ({
	status,
	message: msg,
	error: { type: 'Server Error', message: errorMessage },
});

function fakeMessage(n, extra = {}) {
	return {
		guid: `m-${n}`,
		text: `text ${n}`,
		handle: { address: n % 2 ? '+15550001111' : 'a@b.com', service: 'iMessage', country: 'us' },
		isFromMe: n % 3 === 0,
		dateCreated: 1700000000000 + n,
		attachments: [],
		originalROWID: n,
		...extra,
	};
}

/**
 * Mirrors BlueBubbles Server's reroute rule (messageRouter.query): with the
 * Private API on macOS 13+, a search is sent to Spotlight only when exactly one
 * `where` statement contains `message.text`.
 */
function isSpotlightShaped(body) {
	const where = Array.isArray(body?.where) ? body.where : [];
	return where.filter((w) => w.statement.includes('message.text')).length === 1;
}

function range(offset, limit, total) {
	const out = [];
	for (let n = offset; n < Math.min(offset + limit, total); n++) out.push(fakeMessage(n));
	return out;
}

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks);
		const url = new URL(req.url, 'http://mock');
		const query = Object.fromEntries(url.searchParams);
		let body;
		if (/json/.test(req.headers['content-type'] ?? '')) body = JSON.parse(raw.toString('utf8'));
		// Path as sent on the wire (still percent-encoded) and decoded.
		const rawPath = req.url.split('?')[0].replace(/^\/api\/v1/, '');
		const p = decodeURIComponent(rawPath);
		bb.requests.push({
			method: req.method,
			path: p,
			rawPath,
			query,
			body,
			headers: req.headers,
			raw,
		});

		const send = (code, payload) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		if (query.password !== PASSWORD) return send(401, err(401, 'Unauthorized', 'Unauthorized'));

		const m = req.method;
		if (m === 'GET' && p === '/server/info') return send(200, ok(bb.serverInfo));
		if (m === 'POST' && p === '/message/text') {
			if (bb.envelopeError)
				return send(200, err(400, 'Bad request', `password=${PASSWORD} rejected ${PASSWORD}`));
			return send(200, ok({ guid: 'sent-1', text: body.message }));
		}
		if (m === 'POST' && p === '/chat/new')
			return send(200, ok({ guid: `any;-;${body.addresses[0]}`, text: null }));
		if (m === 'GET' && p === '/message/missing')
			return send(404, err(404, 'Not found', `Message does not exist (${PASSWORD})`));
		if (m === 'GET' && /^\/message\/[^/]+$/.test(p) && p !== '/message/schedule')
			return send(
				200,
				ok(
					fakeMessage(7, {
						guid: p.slice(9),
						chats: [{ guid: 'c1', displayName: 'D', participants: [] }],
					}),
				),
			);
		if (m === 'GET' && /^\/chat\/[^/]+\/message$/.test(p)) {
			const rows = range(Number(query.offset), Number(query.limit), bb.chatMessageCount);
			return send(200, ok(rows));
		}
		if (m === 'POST' && p === '/message/query') {
			if (body.with.includes('chat')) {
				if (bb.lookupFails) return send(500, err(500, 'Server error', 'lookup exploded'));
				const guids = body.where[0].args.guids;
				// Every 5th message has no chat row (the INNER join drops it).
				const rows = guids
					.filter((g) => Number(g.slice(2)) % 5 !== 0)
					.map((g) =>
						Number(g.slice(2)) % 2
							? { guid: g, chats: [{ guid: `chat-${g}`, displayName: 'Group' }] }
							: { guid: g, chat: { guid: `chat-${g}`, displayName: 'Single' } },
					);
				return send(200, ok(rows));
			}
			if (bb.spotlightStatus && isSpotlightShaped(body))
				return send(
					bb.spotlightStatus,
					err(bb.spotlightStatus, 'An unhandled error has occurred!', 'Transaction timeout'),
				);
			return send(200, ok(range(body.offset, body.limit, bb.searchCount)));
		}
		if (m === 'POST' && p === '/message/react') return send(200, ok({ guid: 'reaction-1' }));
		if (m === 'POST' && /^\/message\/[^/]+\/(edit|unsend)$/.test(p))
			return send(200, ok({ guid: p.split('/')[2] }));
		if (p === '/message/schedule') {
			if (m === 'GET') return send(200, ok(bb.schedules));
			if (m === 'POST') return send(200, ok({ id: 9, ...body, status: 'pending' }));
		}
		if (m === 'DELETE' && p === '/message/schedule/42') return send(200, ok(null));
		if (m === 'DELETE' && p === '/message/schedule/404')
			return send(404, err(404, 'Not found', 'Scheduled message does not exist'));
		if (m === 'GET' && p === '/attachment/att-1/download') {
			res.writeHead(200, { 'content-type': 'image/heic' });
			return res.end(Buffer.from([1, 2, 3, 4, 5]));
		}
		if (m === 'GET' && p === '/attachment/att-1')
			return send(
				200,
				ok({ guid: 'att-1', transferName: 'IMG_1.HEIC', mimeType: 'image/heic', totalBytes: 5 }),
			);
		if (m === 'POST' && p === '/message/attachment') {
			return send(200, ok({ guid: 'att-msg', contentType: req.headers['content-type'] }));
		}
		return send(404, err(404, 'Not found', 'Not Found'));
	});
});

// --------------------------------------------------------------------------
// Fake n8n execute context
// --------------------------------------------------------------------------
class AxiosError extends Error {
	constructor(msg, code, config, response) {
		super(msg);
		this.name = 'AxiosError';
		this.isAxiosError = true;
		this.code = code;
		this.config = config;
		if (response) this.response = response;
	}
}

const credentialType = new BlueBubblesApi();
const NODE = {
	id: '1',
	name: 'BlueBubbles',
	type: 'n8n-nodes-bluebubbles.blueBubbles',
	typeVersion: 1,
	position: [0, 0],
	parameters: {},
};

async function sendRequest(opts, credentials) {
	const authQs = {};
	for (const [key, expr] of Object.entries(credentialType.authenticate.properties.qs)) {
		authQs[key] = credentials[/\$credentials\.(\w+)/.exec(expr)[1]];
	}
	const url = new URL(opts.url);
	for (const [key, value] of Object.entries({ ...opts.qs, ...authQs }))
		url.searchParams.set(key, String(value));
	const config = { url: url.toString(), method: opts.method, params: { ...opts.qs, ...authQs } };

	if (bb.spotlightTimesOut && opts.url.endsWith('/message/query') && isSpotlightShaped(opts.body)) {
		bb.requests.push({
			method: opts.method,
			path: '/message/query',
			body: opts.body,
			timedOut: true,
		});
		throw new AxiosError(`timeout of ${opts.timeout}ms exceeded`, 'ECONNABORTED', config);
	}

	const init = { method: opts.method, headers: { ...(opts.headers ?? {}) } };
	if (opts.body instanceof FormData) {
		init.body = opts.body;
	} else if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		init.headers['content-type'] = 'application/json';
	}
	const res = await fetch(url, init);
	const buffer = Buffer.from(await res.arrayBuffer());
	let data;
	if (opts.encoding === 'arraybuffer') {
		data = buffer;
	} else {
		data = buffer.toString('utf8');
		try {
			data = JSON.parse(data);
		} catch {
			// keep text
		}
	}
	const headers = Object.fromEntries(res.headers);
	if (res.status >= 400) {
		const response = { status: res.status, data, headers, config };
		throw new AxiosError(
			`Request failed with status code ${res.status}`,
			'ERR_BAD_REQUEST',
			config,
			response,
		);
	}
	return opts.returnFullResponse ? { body: data, headers, statusCode: res.status } : data;
}

/**
 * @param {Record<string, unknown>} params node parameters for item 0
 * @param {{ binary?: Record<string, object> }} [item] the input item
 */
function makeContext(params, item = {}) {
	const credentials = { serverUrl: base, password: PASSWORD };
	const calls = [];
	const logger = {};
	for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};
	return {
		calls,
		logger,
		getNode: () => NODE,
		getTimezone: () => 'America/New_York',
		getCredentials: async () => credentials,
		getNodeParameter(name, itemIndex, fallback) {
			if (name in params) return params[name];
			if (fallback !== undefined) return fallback;
			throw new Error(`Missing parameter ${name}`);
		},
		helpers: {
			async httpRequestWithAuthentication(type, opts) {
				assert.equal(type, 'blueBubblesApi');
				calls.push(opts);
				try {
					return await sendRequest(opts, credentials);
				} catch (error) {
					throw new NodeApiError(NODE, error);
				}
			},
			async prepareBinaryData(buffer, fileName, mimeType) {
				return {
					data: buffer.toString('base64'),
					fileName,
					mimeType,
					fileSize: String(buffer.length),
				};
			},
			assertBinaryData(itemIndex, name) {
				const data = item.binary?.[name];
				if (!data) throw new NodeOperationError(NODE, `No binary data in "${name}"`);
				return data;
			},
			async getBinaryDataBuffer(itemIndex, name) {
				return Buffer.from(item.binary[name].data, 'base64');
			},
		},
	};
}

function errorText(error) {
	const parts = [error.message, error.description, String(error.stack)];
	for (const key of ['messages', 'cause', 'context', 'errorResponse', 'httpCode']) {
		try {
			parts.push(JSON.stringify(error[key] ?? null));
		} catch {
			parts.push(String(error[key]));
		}
	}
	parts.push(JSON.stringify(error));
	return parts.join('\n');
}

async function rejects(promise) {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	assert.fail('expected the call to throw');
}

const run = (mod, operation, params, item) => {
	const ctx = makeContext(params, item);
	return mod.execute.call(ctx, 0, operation, G.createExecutionCache());
};
/** Like `run`, but also returns the HTTP helper calls (with their timeouts). */
const runWithCalls = async (mod, operation, params) => {
	const ctx = makeContext(params);
	const out = await mod.execute.call(ctx, 0, operation, G.createExecutionCache());
	return { out, calls: ctx.calls };
};
const nonInfo = () => bb.requests.filter((r) => r.path !== '/server/info');
const chat = (value, mode = 'guid') => ({ __rl: true, mode, value });

let base;
before(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => bb.reset());

// --------------------------------------------------------------------------
// Message: Send
// --------------------------------------------------------------------------
test('message.send: normalizes iMessage;-;, adds tempGuid, resolves method once', async () => {
	const out = await run(message, 'send', {
		chat: chat('iMessage;-;+15551234567'),
		text: 'hello',
		options: { subject: 'Subj', effectId: 'com.apple.MobileSMS.expressivesend.impact' },
	});
	const [info, req] = bb.requests;
	assert.equal(info.path, '/server/info');
	assert.equal(req.method, 'POST');
	assert.equal(req.path, '/message/text');
	assert.match(req.body.tempGuid, TEMP_GUID);
	const { tempGuid, ...rest } = req.body;
	assert.ok(tempGuid);
	assert.deepEqual(rest, {
		chatGuid: 'any;-;+15551234567',
		message: 'hello',
		method: 'private-api',
		subject: 'Subj',
		effectId: 'com.apple.MobileSMS.expressivesend.impact',
	});
	assert.deepEqual(out, [{ json: { guid: 'sent-1', text: 'hello' }, pairedItem: { item: 0 } }]);
});

test('message.send: a fresh tempGuid per send; by-address mode uses any;-;addr', async () => {
	await run(message, 'send', { chat: chat(' +15550001111 ', 'address'), text: 'a' });
	await run(message, 'send', { chat: chat('+15550001111', 'address'), text: 'b' });
	const sends = nonInfo();
	assert.equal(sends[0].body.chatGuid, 'any;-;+15550001111');
	assert.notEqual(sends[0].body.tempGuid, sends[1].body.tempGuid);
	assert.equal('subject' in sends[0].body, false);
	assert.equal('selectedMessageGuid' in sends[0].body, false);
});

test('message.send: reply-to becomes selectedMessageGuid under private-api', async () => {
	await run(message, 'send', {
		chat: chat('any;-;+1555'),
		text: 'reply',
		options: { replyToMessageGuid: 'orig-guid' },
	});
	assert.equal(nonInfo()[0].body.selectedMessageGuid, 'orig-guid');
});

test('message.send: reply-to without private-api throws NodeOperationError before sending', async () => {
	bb.serverInfo = { private_api: true, helper_connected: false };
	const error = await rejects(
		run(message, 'send', {
			chat: chat('any;-;+1555'),
			text: 'reply',
			options: { replyToMessageGuid: 'orig-guid' },
		}),
	);
	assert.ok(error instanceof NodeOperationError);
	assert.match(error.message, /Private API/);
	assert.equal(nonInfo().length, 0);

	// An explicit AppleScript override is refused too, without asking the server.
	bb.reset();
	await rejects(
		run(message, 'send', {
			chat: chat('any;-;+1555'),
			text: 'reply',
			options: { replyToMessageGuid: 'x', method: 'apple-script' },
		}),
	);
	assert.equal(bb.requests.length, 0);
});

test('message.send: apple-script when private API is off', async () => {
	bb.serverInfo = { private_api: false };
	await run(message, 'send', { chat: chat('any;-;+1555'), text: 'x' });
	assert.equal(nonInfo()[0].body.method, 'apple-script');
});

test('message.send: envelope status >= 400 on HTTP 200 throws without the password', async () => {
	bb.envelopeError = true;
	const error = await rejects(run(message, 'send', { chat: chat('any;-;+1555'), text: 'x' }));
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '400');
	assert.match(error.message, /Could not send the BlueBubbles message/);
	assert.ok(!errorText(error).includes(PASSWORD), 'password leaked');
});

// --------------------------------------------------------------------------
// Message: Send to Address
// --------------------------------------------------------------------------
test('message.sendToAddress iMessage: /message/text to any;-;addr, no service field', async () => {
	await run(message, 'sendToAddress', { address: ' a@b.com ', service: 'iMessage', text: 'hi' });
	const [req] = nonInfo();
	assert.equal(req.path, '/message/text');
	assert.equal(req.body.chatGuid, 'any;-;a@b.com');
	assert.match(req.body.tempGuid, TEMP_GUID);
	assert.equal('service' in req.body, false);
});

test('message.sendToAddress SMS: /chat/new with exact body, returns the chat', async () => {
	const out = await run(message, 'sendToAddress', {
		address: '+15551234567',
		service: 'SMS',
		text: 'sms!',
	});
	const [req] = nonInfo();
	assert.equal(req.method, 'POST');
	assert.equal(req.path, '/chat/new');
	const { tempGuid, ...rest } = req.body;
	assert.match(tempGuid, TEMP_GUID);
	assert.deepEqual(rest, {
		addresses: ['+15551234567'],
		message: 'sms!',
		method: 'private-api',
		service: 'SMS',
	});
	assert.deepEqual(out[0].json, { guid: 'any;-;+15551234567', text: null });
});

test('message.sendToAddress SMS without private-api throws NodeOperationError', async () => {
	bb.serverInfo = { private_api: false };
	const error = await rejects(
		run(message, 'sendToAddress', { address: '+1555', service: 'SMS', text: 'x' }),
	);
	assert.ok(error instanceof NodeOperationError);
	assert.match(error.message, /SMS requires the Private API/);
	assert.equal(nonInfo().length, 0);
});

// --------------------------------------------------------------------------
// Message: Get / Get Many
// --------------------------------------------------------------------------
test('message.get: with=chats,attachments; simplify projects the slim fields', async () => {
	const out = await run(message, 'get', { messageGuid: 'abc-1', simplify: true });
	const [req] = bb.requests;
	assert.equal(req.method, 'GET');
	assert.equal(req.path, '/message/abc-1');
	assert.equal(req.query.with, 'chats,attachments');
	assert.deepEqual(out[0].json.handle, { address: '+15550001111', service: 'iMessage' });
	assert.deepEqual(out[0].json.chats, [{ guid: 'c1', displayName: 'D' }]);
	assert.equal('originalROWID' in out[0].json, false);

	const raw = await run(message, 'get', { messageGuid: 'abc-1', simplify: false });
	assert.equal(raw[0].json.originalROWID, 7);
});

test('message.get: 404 has the message hint and no password', async () => {
	const error = await rejects(run(message, 'get', { messageGuid: 'missing' }));
	assert.equal(error.httpCode, '404');
	assert.match(error.description, /Hint: Message does not exist; check the message GUID/);
	assert.ok(!errorText(error).includes(PASSWORD));
});

test('message.getMany: GET /chat/:guid/message with exact query, encoded GUID', async () => {
	const out = await run(message, 'getMany', {
		chat: chat('iMessage;-;+15551234567'),
		returnAll: false,
		limit: 10,
		simplify: true,
		filters: { after: 1700000000000, before: '2026-01-15T10:00:00Z' },
	});
	const [req] = bb.requests;
	assert.equal(req.method, 'GET');
	assert.equal(req.path, '/chat/any;-;+15551234567/message');
	assert.equal(req.rawPath, '/chat/any%3B-%3B%2B15551234567/message');
	assert.deepEqual(req.query, {
		with: 'attachment',
		sort: 'DESC',
		limit: '10',
		offset: '0',
		after: '1700000000000',
		before: String(Date.UTC(2026, 0, 15, 10)),
		password: PASSWORD,
	});
	assert.equal(out.length, 10);
	assert.ok(out.every((o, idx) => o.pairedItem.item === 0 && o.json.guid === `m-${idx}`));
});

test('message.getMany: Return All pages by 1000 until a short page', async () => {
	bb.chatMessageCount = 2300;
	const out = await run(message, 'getMany', {
		chat: chat('any;-;+1'),
		returnAll: true,
		simplify: false,
		filters: { sort: 'ASC' },
	});
	assert.equal(out.length, 2300);
	assert.deepEqual(
		bb.requests.map((r) => [r.query.limit, r.query.offset, r.query.sort]),
		[
			['1000', '0', 'ASC'],
			['1000', '1000', 'ASC'],
			['1000', '2000', 'ASC'],
		],
	);
});

test('message.getMany: limit above 1000 pages 1000 + remainder, never limit=0', async () => {
	bb.chatMessageCount = 5000;
	const out = await run(message, 'getMany', {
		chat: chat('any;-;+1'),
		returnAll: false,
		limit: 1500,
		filters: {},
	});
	assert.equal(out.length, 1500);
	assert.deepEqual(
		bb.requests.map((r) => [r.query.limit, r.query.offset]),
		[
			['1000', '0'],
			['500', '1000'],
		],
	);

	// End reached exactly on a page boundary: one extra request, never limit=0.
	bb.reset();
	bb.chatMessageCount = 1000;
	await run(message, 'getMany', { chat: chat('any;-;+1'), returnAll: true, filters: {} });
	assert.deepEqual(
		bb.requests.map((r) => r.query.limit),
		['1000', '1000'],
	);
});

test('message.getMany: From Address filters client-side (address and "me")', async () => {
	const byAddress = await run(message, 'getMany', {
		chat: chat('any;-;+1'),
		returnAll: false,
		limit: 10,
		simplify: false,
		filters: { fromAddress: '+15550001111' },
	});
	assert.deepEqual(
		byAddress.map((o) => o.json.guid),
		['m-1', 'm-3', 'm-5', 'm-7', 'm-9'],
	);
	const mine = await run(message, 'getMany', {
		chat: chat('any;-;+1'),
		returnAll: false,
		limit: 10,
		filters: { fromAddress: 'ME' },
	});
	assert.deepEqual(
		mine.map((o) => o.json.guid),
		['m-0', 'm-3', 'm-6', 'm-9'],
	);
	assert.ok(bb.requests.every((r) => !('fromAddress' in r.query) && !('address' in r.query)));
});

test('message.getMany: zone-less dateTime uses the workflow timezone', async () => {
	await run(message, 'getMany', {
		chat: chat('any;-;+1'),
		limit: 1,
		filters: { after: '2026-01-15T10:00:00', before: '2026-07-15T10:00:00.000' },
	});
	// America/New_York: EST (UTC-5) in January, EDT (UTC-4) in July.
	assert.equal(bb.requests[0].query.after, String(Date.UTC(2026, 0, 15, 15)));
	assert.equal(bb.requests[0].query.before, String(Date.UTC(2026, 6, 15, 14)));
});

test('message.getMany: an invalid date is a NodeOperationError', async () => {
	const error = await rejects(
		run(message, 'getMany', { chat: chat('any;-;+1'), limit: 1, filters: { after: 'nope' } }),
	);
	assert.ok(error instanceof NodeOperationError);
	assert.match(error.message, /Created After is not a valid date/);
	assert.equal(bb.requests.length, 0);
});

// --------------------------------------------------------------------------
// Message: Search
// --------------------------------------------------------------------------
test('escapeLike escapes backslash first, then % and _', () => {
	assert.equal(H.escapeLike('50%_off\\now'), '50\\%\\_off\\\\now');
	assert.equal(H.escapeLike('\\%'), '\\\\\\%');
});

test('message.search: exact body, where strings, escaping, then chat lookup', async () => {
	const out = await run(message, 'search', {
		query: '100%_ok\\',
		chat: chat('iMessage;-;+15551234567'),
		returnAll: false,
		limit: 25,
		simplify: true,
		filters: { after: 1000, before: 2000, fromAddress: ' +15550001111 ' },
	});
	const [main, lookup] = bb.requests;
	assert.equal(main.method, 'POST');
	assert.equal(main.path, '/message/query');
	assert.deepEqual(main.body, {
		limit: 25,
		offset: 0,
		sort: 'DESC',
		with: ['attachment'],
		chatGuid: 'any;-;+15551234567',
		after: 1000,
		before: 2000,
		where: [
			{ statement: LIKE_STATEMENT, args: { query: '%100\\%\\_ok\\\\%' } },
			{ statement: 'handle.id = :address', args: { address: '+15550001111' } },
		],
	});
	// The bind name is the 3rd space-separated token (Spotlight reroute).
	assert.equal(main.body.where[0].statement.split(' ')[2], ':query');
	assert.equal(main.raw.toString('utf8').includes('"with":["attachment"]'), true);

	assert.equal(lookup.path, '/message/query');
	assert.deepEqual(lookup.body, {
		limit: 400,
		offset: 0,
		sort: 'ASC',
		with: ['chat'],
		where: [
			{
				statement: 'message.guid IN (:...guids)',
				args: { guids: Array.from({ length: 25 }, (_, n) => `m-${n}`) },
			},
		],
	});
	assert.equal(bb.requests.length, 2);

	// chats from `chats`, from a single `chat`, or [] when there is no chat row.
	assert.deepEqual(out[1].json.chats, [{ guid: 'chat-m-1', displayName: 'Group' }]);
	assert.deepEqual(out[2].json.chats, [{ guid: 'chat-m-2', displayName: 'Single' }]);
	assert.deepEqual(out[0].json.chats, []);
	assert.deepEqual(out[5].json.chats, []);
	assert.equal('note' in out[0].json, false);
});

test('message.search: "me" uses is_from_me; no query and no filters sends no where', async () => {
	await run(message, 'search', { query: '', limit: 5, filters: { fromAddress: 'Me' } });
	assert.deepEqual(bb.requests[0].body.where, [
		{ statement: 'message.is_from_me = :fromMe', args: { fromMe: 1 } },
	]);
	assert.equal('chatGuid' in bb.requests[0].body, false);

	bb.reset();
	await run(message, 'search', { limit: 5, filters: {} });
	assert.equal('where' in bb.requests[0].body, false);
	assert.equal('chatGuid' in bb.requests[0].body, false);
	assert.equal('after' in bb.requests[0].body, false);
});

test('message.search: chat lookup runs in chunks of 400 over de-duplicated GUIDs', async () => {
	bb.searchCount = 950;
	const out = await run(message, 'search', { returnAll: true, filters: {}, simplify: false });
	assert.equal(out.length, 950);
	const main = bb.requests.filter((r) => !r.body.with.includes('chat'));
	assert.deepEqual(
		main.map((r) => [r.body.limit, r.body.offset]),
		[[1000, 0]],
	);
	const lookups = bb.requests.filter((r) => r.body.with.includes('chat'));
	assert.deepEqual(
		lookups.map((r) => r.body.where[0].args.guids.length).sort((a, b) => b - a),
		[400, 400, 150],
	);
	assert.ok(lookups.every((r) => r.body.limit === 400 && r.body.sort === 'ASC'));
	const all = lookups.flatMap((r) => r.body.where[0].args.guids);
	assert.equal(new Set(all).size, 950);
});

test('message.search: no rows means no lookup request', async () => {
	bb.searchCount = 0;
	const out = await run(message, 'search', { limit: 5, filters: {} });
	assert.equal(out.length, 0);
	assert.equal(bb.requests.length, 1);
});

test('message.search: a failed chat lookup adds a note instead of failing', async () => {
	bb.lookupFails = true;
	const out = await run(message, 'search', { limit: 3, filters: {}, simplify: true });
	assert.equal(out.length, 3);
	for (const item of out) {
		assert.deepEqual(item.json.chats, []);
		assert.match(item.json.note, /Chat lookup failed/);
		assert.ok(!item.json.note.includes(PASSWORD));
	}
});

// --------------------------------------------------------------------------
// Message: Search method (Spotlight / Database / Auto fallback)
// --------------------------------------------------------------------------
const NOT_NULL = { statement: 'message.text IS NOT NULL', args: {} };
const SENDER = { statement: 'handle.id = :address', args: { address: '+15550001111' } };
const like = (term) => ({ statement: LIKE_STATEMENT, args: { query: term } });
const searchParams = (extra = {}) => ({
	query: 'the',
	limit: 3,
	simplify: true,
	filters: { fromAddress: '+15550001111' },
	...extra,
});

test('textClauses: spotlight is one rerouted clause; database adds a 2nd message.text clause', () => {
	assert.deepEqual(H.textClauses('', 'database'), []);
	assert.deepEqual(H.textClauses('', 'spotlight'), []);
	assert.deepEqual(H.textClauses('50%_x', 'spotlight'), [like('%50\\%\\_x%')]);
	const db = H.textClauses("50%_x' OR 1=1 --", 'database');
	assert.deepEqual(db, [like("%50\\%\\_x' OR 1=1 --%"), NOT_NULL]);
	// The term never reaches a statement, only `args`.
	for (const clause of db) assert.ok(!clause.statement.includes('OR 1=1'));
	// Bind name stays the 3rd token; the server would not reroute this shape.
	assert.equal(db[0].statement.split(' ')[2], ':query');
	assert.equal(isSpotlightShaped({ where: db }), false);
	assert.equal(isSpotlightShaped({ where: H.textClauses('x', 'spotlight') }), true);
	// The shared constant is not handed out (and mutated) by reference.
	db[1].args.leak = 1;
	assert.deepEqual(H.TEXT_NOT_NULL_CLAUSE.args, {});
});

test('message.search auto: tries Spotlight with the 10 s timeout; success means one query', async () => {
	const { out, calls } = await runWithCalls(message, 'search', searchParams());
	const queries = calls.filter((c) => !c.body.with.includes('chat'));
	assert.equal(queries.length, 1);
	assert.equal(queries[0].timeout, message.SPOTLIGHT_AUTO_TIMEOUT_MS);
	assert.equal(message.SPOTLIGHT_AUTO_TIMEOUT_MS, 10_000);
	assert.deepEqual(queries[0].body.where, [like('%the%'), SENDER]);
	assert.equal(out.length, 3);
	assert.equal('note' in out[0].json, false);
});

test('message.search auto: a Spotlight 500 falls back to the database query with a note', async () => {
	bb.spotlightStatus = 500;
	const { out, calls } = await runWithCalls(message, 'search', searchParams());
	const queries = bb.requests.filter((r) => !r.body.with.includes('chat'));
	assert.equal(queries.length, 2);
	assert.deepEqual(queries[0].body.where, [like('%the%'), SENDER]);
	assert.deepEqual(queries[1].body, {
		limit: 3,
		offset: 0,
		sort: 'DESC',
		with: ['attachment'],
		where: [like('%the%'), NOT_NULL, SENDER],
	});
	const queryCalls = calls.filter((c) => !c.body.with.includes('chat'));
	assert.deepEqual(
		queryCalls.map((c) => c.timeout),
		[message.SPOTLIGHT_AUTO_TIMEOUT_MS, G.DEFAULT_REQUEST_TIMEOUT_MS],
	);
	assert.equal(out.length, 3);
	for (const item of out) {
		assert.match(
			item.json.note,
			/^Spotlight search failed \(Could not search BlueBubbles messages \(HTTP 500\)\)/,
		);
		assert.match(item.json.note, /database search/);
		assert.ok(!item.json.note.includes(PASSWORD));
		assert.ok(Array.isArray(item.json.chats));
	}
});

test('message.search auto: a Spotlight timeout falls back to the database query', async () => {
	bb.spotlightTimesOut = true;
	const out = await run(message, 'search', searchParams({ filters: {} }));
	const queries = bb.requests.filter((r) => !r.body.with.includes('chat'));
	assert.equal(queries.length, 2);
	assert.equal(queries[0].timedOut, true);
	assert.deepEqual(queries[1].body.where, [like('%the%'), NOT_NULL]);
	assert.equal(out.length, 3);
	assert.match(
		out[0].json.note,
		/^Spotlight search failed \(Could not search BlueBubbles messages \(request timed out\)\)/,
	);
});

test('message.search auto: after one Spotlight failure, later items skip straight to the database', async () => {
	bb.spotlightTimesOut = true;
	const cache = G.createExecutionCache();
	const first = await message.execute.call(makeContext(searchParams()), 0, 'search', cache);
	assert.match(first[0].json.note, /set Search Method to Database/);
	assert.equal(cache.spotlightFailed, true);

	bb.requests = [];
	const ctx = makeContext(searchParams());
	const second = await message.execute.call(ctx, 1, 'search', cache);
	const queries = bb.requests.filter((r) => !r.body.with.includes('chat'));
	assert.equal(queries.length, 1);
	assert.deepEqual(queries[0].body.where, [like('%the%'), NOT_NULL, SENDER]);
	assert.equal(ctx.calls[0].timeout, G.DEFAULT_REQUEST_TIMEOUT_MS);
	assert.match(second[0].json.note, /skipped after an earlier item/);

	// Explicit Spotlight is still honoured with the same cache.
	bb.requests = [];
	await rejects(
		message.execute.call(
			makeContext(searchParams({ searchMethod: 'spotlight' })),
			2,
			'search',
			cache,
		),
	);
	assert.equal(bb.requests[0].timedOut, true);
});

test('message.search auto: a chat-lookup failure note is appended to the fallback note', async () => {
	bb.spotlightStatus = 500;
	bb.lookupFails = true;
	const out = await run(message, 'search', searchParams());
	assert.match(out[0].json.note, /^Spotlight search failed .* Chat lookup failed/);
});

test('message.search auto: a 4xx from the search is not retried', async () => {
	bb.spotlightStatus = 400;
	const error = await rejects(run(message, 'search', searchParams()));
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '400');
	assert.equal(bb.requests.length, 1);
});

test('message.search auto: no query means no Spotlight, no fallback, default timeout', async () => {
	bb.spotlightStatus = 500;
	const { calls } = await runWithCalls(message, 'search', searchParams({ query: '' }));
	const queries = calls.filter((c) => !c.body.with.includes('chat'));
	assert.equal(queries.length, 1);
	assert.equal(queries[0].timeout, G.DEFAULT_REQUEST_TIMEOUT_MS);
	assert.deepEqual(queries[0].body.where, [SENDER]);
});

test('message.search database: one non-rerouted query, never Spotlight', async () => {
	bb.spotlightStatus = 500;
	const { out, calls } = await runWithCalls(
		message,
		'search',
		searchParams({ searchMethod: 'database' }),
	);
	const queries = calls.filter((c) => !c.body.with.includes('chat'));
	assert.equal(queries.length, 1);
	assert.equal(queries[0].timeout, G.DEFAULT_REQUEST_TIMEOUT_MS);
	assert.deepEqual(queries[0].body.where, [like('%the%'), NOT_NULL, SENDER]);
	assert.equal(out.length, 3);
	assert.equal('note' in out[0].json, false);
});

test('message.search spotlight: no fallback; the server error is surfaced', async () => {
	bb.spotlightStatus = 500;
	const { out } = await runWithCalls(
		message,
		'search',
		searchParams({ searchMethod: 'spotlight', query: '' }),
	);
	assert.equal(out.length, 3);

	bb.reset();
	bb.spotlightStatus = 500;
	const error = await rejects(run(message, 'search', searchParams({ searchMethod: 'spotlight' })));
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '500');
	assert.match(error.description, /Transaction timeout/);
	assert.ok(!errorText(error).includes(PASSWORD));
	assert.equal(bb.requests.length, 1);
	assert.deepEqual(bb.requests[0].body.where, [like('%the%'), SENDER]);
});

test('message.search: an unknown search method is a NodeOperationError', async () => {
	const error = await rejects(run(message, 'search', searchParams({ searchMethod: 'grep' })));
	assert.ok(error instanceof NodeOperationError);
	assert.match(error.message, /Unknown search method "grep"/);
	assert.equal(bb.requests.length, 0);
});

// --------------------------------------------------------------------------
// Message: React / Edit / Unsend
// --------------------------------------------------------------------------
test('message.react: exact body, remove adds "-", partIndex option', async () => {
	await run(message, 'react', {
		chat: chat('iMessage;-;+1555'),
		messageGuid: 'target',
		reaction: 'love',
		remove: false,
	});
	await run(message, 'react', {
		chat: chat('any;-;+1555'),
		messageGuid: 'target',
		reaction: 'laugh',
		remove: true,
		options: { partIndex: 2 },
	});
	assert.equal(bb.requests[0].path, '/message/react');
	assert.deepEqual(bb.requests[0].body, {
		chatGuid: 'any;-;+1555',
		selectedMessageGuid: 'target',
		reaction: 'love',
		partIndex: 0,
	});
	assert.deepEqual(bb.requests[1].body, {
		chatGuid: 'any;-;+1555',
		selectedMessageGuid: 'target',
		reaction: '-laugh',
		partIndex: 2,
	});
	assert.ok(bb.requests.every((r) => r.path !== '/server/info'));
});

test('message.edit: default fallback text and partIndex 0', async () => {
	await run(message, 'edit', { messageGuid: 'g-1', newText: 'fixed' });
	await run(message, 'edit', {
		messageGuid: 'g-1',
		newText: 'fixed',
		options: { backwardsCompatibilityMessage: 'custom', partIndex: 1 },
	});
	assert.equal(bb.requests[0].method, 'POST');
	assert.equal(bb.requests[0].path, '/message/g-1/edit');
	assert.deepEqual(bb.requests[0].body, {
		editedMessage: 'fixed',
		backwardsCompatibilityMessage: 'Edited to: fixed',
		partIndex: 0,
	});
	assert.deepEqual(bb.requests[1].body, {
		editedMessage: 'fixed',
		backwardsCompatibilityMessage: 'custom',
		partIndex: 1,
	});
});

test('message.unsend: POST /message/:guid/unsend with partIndex', async () => {
	const out = await run(message, 'unsend', { messageGuid: 'g-2' });
	assert.equal(bb.requests[0].method, 'POST');
	assert.equal(bb.requests[0].path, '/message/g-2/unsend');
	assert.deepEqual(bb.requests[0].body, { partIndex: 0 });
	assert.deepEqual(out, [{ json: { guid: 'g-2' }, pairedItem: { item: 0 } }]);
});

test('message: unknown operation is a NodeOperationError', async () => {
	const error = await rejects(run(message, 'nope', {}));
	assert.ok(error instanceof NodeOperationError);
});

// --------------------------------------------------------------------------
// Scheduled Message
// --------------------------------------------------------------------------
test('scheduledMessage.create: nested envelope, ms timestamp, frozen method', async () => {
	const out = await run(scheduledMessage, 'create', {
		chat: chat('iMessage;-;+1555'),
		text: 'later',
		scheduledFor: '2026-12-01T09:30:00-05:00',
	});
	const [req] = nonInfo();
	assert.equal(req.method, 'POST');
	assert.equal(req.path, '/message/schedule');
	assert.deepEqual(req.body, {
		type: 'send-message',
		payload: { chatGuid: 'any;-;+1555', message: 'later', method: 'private-api' },
		scheduledFor: Date.UTC(2026, 11, 1, 14, 30),
		schedule: { type: 'once' },
	});
	assert.equal(out[0].json.id, 9);

	bb.reset();
	await run(scheduledMessage, 'create', {
		chat: chat('any;-;+1555'),
		text: 'later',
		scheduledFor: 1800000000000,
		options: { method: 'apple-script' },
	});
	assert.equal(bb.requests.length, 1);
	assert.equal(bb.requests[0].body.payload.method, 'apple-script');
	assert.equal(bb.requests[0].body.scheduledFor, 1800000000000);
});

test('scheduledMessage.create: missing Send At is a NodeOperationError', async () => {
	const error = await rejects(
		run(scheduledMessage, 'create', { chat: chat('any;-;+1'), text: 'x', scheduledFor: '' }),
	);
	assert.ok(error instanceof NodeOperationError);
	assert.equal(bb.requests.length, 0);
});

test('scheduledMessage.getMany: GET /message/schedule; Return All or Limit', async () => {
	const all = await run(scheduledMessage, 'getMany', { returnAll: true });
	assert.equal(bb.requests[0].method, 'GET');
	assert.equal(bb.requests[0].path, '/message/schedule');
	assert.equal(all.length, 3);
	assert.equal(all[1].json.status, 'error');
	const some = await run(scheduledMessage, 'getMany', { returnAll: false, limit: 2 });
	assert.equal(some.length, 2);
});

test('scheduledMessage.delete: DELETE /message/schedule/:id; 404 hint', async () => {
	const out = await run(scheduledMessage, 'delete', { scheduledMessageId: 42 });
	assert.equal(bb.requests[0].method, 'DELETE');
	assert.equal(bb.requests[0].path, '/message/schedule/42');
	assert.deepEqual(out[0].json, { success: true, id: 42 });

	const error = await rejects(run(scheduledMessage, 'delete', { scheduledMessageId: 404 }));
	assert.equal(error.httpCode, '404');
	assert.match(error.description, /Scheduled message does not exist/);
	assert.ok(!errorText(error).includes(PASSWORD));

	const bad = await rejects(run(scheduledMessage, 'delete', { scheduledMessageId: 1.5 }));
	assert.ok(bad instanceof NodeOperationError);
});

// --------------------------------------------------------------------------
// Attachment
// --------------------------------------------------------------------------
test('attachment.get: GET /attachment/:guid', async () => {
	const out = await run(attachment, 'get', { attachmentGuid: 'att-1' });
	assert.equal(bb.requests[0].method, 'GET');
	assert.equal(bb.requests[0].path, '/attachment/att-1');
	assert.equal(out[0].json.transferName, 'IMG_1.HEIC');
});

test('attachment.download: original=true bytes into the binary field + metadata json', async () => {
	const out = await run(attachment, 'download', {
		attachmentGuid: 'att-1',
		binaryPropertyName: 'photo',
	});
	const [dl, meta] = bb.requests;
	assert.equal(dl.path, '/attachment/att-1/download');
	assert.equal(dl.query.original, 'true');
	assert.equal(meta.path, '/attachment/att-1');
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.equal(out[0].json.guid, 'att-1');
	assert.deepEqual(out[0].binary.photo, {
		data: Buffer.from([1, 2, 3, 4, 5]).toString('base64'),
		fileName: 'IMG_1.HEIC',
		mimeType: 'image/heic',
		fileSize: '5',
	});
});

test('attachment.download: 404 keeps the attachment hint and hides the password', async () => {
	const error = await rejects(
		run(attachment, 'download', { attachmentGuid: 'nope', binaryPropertyName: 'data' }),
	);
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '404');
	assert.match(error.description, /Attachment does not exist/);
	assert.ok(!errorText(error).includes(PASSWORD));
});

test('attachment.send: multipart fields chatGuid/tempGuid/method/name + attachment file', async () => {
	const item = {
		binary: {
			data: {
				data: Buffer.from('file-bytes').toString('base64'),
				fileName: 'note.txt',
				mimeType: 'text/plain',
			},
		},
	};
	const out = await run(
		attachment,
		'send',
		{ chat: chat('iMessage;-;+1555'), binaryPropertyName: 'data', options: {} },
		item,
	);
	const [req] = nonInfo();
	assert.equal(req.method, 'POST');
	assert.equal(req.path, '/message/attachment');
	assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
	const raw = req.raw.toString('utf8');
	const field = (name) => new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`).exec(raw)?.[1];
	assert.equal(field('chatGuid'), 'any;-;+1555');
	assert.match(field('tempGuid'), TEMP_GUID);
	assert.equal(field('method'), 'private-api');
	assert.equal(field('name'), 'note.txt');
	assert.match(
		raw,
		/name="attachment"; filename="note.txt"\r\nContent-Type: text\/plain\r\n\r\nfile-bytes\r\n/,
	);
	assert.equal(out[0].json.guid, 'att-msg');

	// File Name option overrides; a missing binary field fails before any request.
	bb.reset();
	await run(
		attachment,
		'send',
		{
			chat: chat('any;-;+1555'),
			binaryPropertyName: 'data',
			options: { fileName: 'renamed.txt', method: 'apple-script' },
		},
		item,
	);
	const raw2 = bb.requests[0].raw.toString('utf8');
	assert.match(raw2, /name="name"\r\n\r\nrenamed.txt/);
	assert.match(raw2, /name="method"\r\n\r\napple-script/);
	assert.match(raw2, /filename="renamed.txt"/);

	bb.reset();
	await rejects(
		run(attachment, 'send', { chat: chat('any;-;+1'), binaryPropertyName: 'missing' }, item),
	);
	assert.equal(bb.requests.length, 0);
});
