'use strict';
/**
 * Tests for the Chat, Contact, Handle and Server executors and the searchChats
 * list method of the BlueBubbles action node, against an in-process mock
 * BlueBubbles server. The fake n8n context mirrors test/generic.test.cjs.
 *
 * Run `npm run build` first (the `test` script does this).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist/nodes/BlueBubbles');
const { NodeApiError } = require('n8n-workflow');
const G = require(path.join(DIST, 'GenericFunctions.js'));
const chat = require(path.join(DIST, 'actions/chat.js'));
const contact = require(path.join(DIST, 'actions/contact.js'));
const handle = require(path.join(DIST, 'actions/handle.js'));
const server = require(path.join(DIST, 'actions/server.js'));
const { searchChats } = require(path.join(DIST, 'methods/listSearch.js'));
const { BlueBubblesApi } = require(
	path.join(ROOT, 'dist/credentials/BlueBubblesApi.credentials.js'),
);

const PASSWORD = 'sup3r-s3cret-pw';

// --------------------------------------------------------------------------
// Mock BlueBubbles server
// --------------------------------------------------------------------------
/**
 * `bb.routes` maps "METHOD /path" (path without /api/v1, still URL-encoded) to
 * a function `(req) => data | { __status, __body }`. Unknown routes answer 404.
 */
const bb = {
	requests: [],
	routes: {},
	reset() {
		this.requests = [];
		this.routes = {};
	},
};

const ok = (data) => ({ status: 200, message: 'Success', data });
const err = (status, message, errorMessage) => ({
	status,
	message,
	error: { type: 'Error', message: errorMessage },
});

const httpServer = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks).toString('utf8');
		// Keep the raw (still percent-encoded) path to check GUID encoding.
		const rawPath = req.url.split('?')[0];
		const url = new URL(req.url, 'http://mock');
		const query = Object.fromEntries(url.searchParams);
		delete query.password;
		const p = rawPath.replace(/^\/api\/v1/, '');
		const record = {
			method: req.method,
			path: p,
			query,
			body: raw ? JSON.parse(raw) : undefined,
		};
		bb.requests.push(record);
		const send = (code, payload) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		if (url.searchParams.get('password') !== PASSWORD)
			return send(401, err(401, 'You are not authorized', 'Unauthorized'));

		const route = bb.routes[`${req.method} ${p}`];
		if (!route) return send(404, err(404, 'Not found', `No route ${req.method} ${p}`));
		const out = route(record);
		if (out && out.__status) return send(out.__status, out.__body);
		return send(200, ok(out));
	});
});

// --------------------------------------------------------------------------
// Fake n8n context (as in generic.test.cjs)
// --------------------------------------------------------------------------
class AxiosError extends Error {
	constructor(message, code, config, response) {
		super(message);
		this.name = 'AxiosError';
		this.isAxiosError = true;
		this.code = code;
		this.config = config;
		this.request = { path: config.url.replace(/^https?:\/\/[^/]+/, ''), _header: config.url };
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

	const init = { method: opts.method, headers: { ...(opts.headers ?? {}) } };
	if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		init.headers['content-type'] = 'application/json';
	}

	let res;
	try {
		res = await fetch(url, init);
	} catch (e) {
		throw new AxiosError(e.message, e.cause?.code ?? 'ECONNREFUSED', config);
	}
	let data = await res.text();
	try {
		data = JSON.parse(data);
	} catch {
		// keep text
	}
	if (res.status >= 400) {
		const response = { status: res.status, statusText: res.statusText, data, config };
		throw new AxiosError(
			`Request failed with status code ${res.status}`,
			'ERR_BAD_REQUEST',
			config,
			response,
		);
	}
	return data;
}

/** A fake IExecuteFunctions / ILoadOptionsFunctions with the given node parameters. */
function makeContext(params = {}) {
	const credentials = { serverUrl: base, password: PASSWORD };
	const calls = [];
	const logger = {};
	for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};
	return {
		calls,
		logger,
		getNode: () => NODE,
		getCredentials: async () => credentials,
		getNodeParameter(name, _itemIndex, fallback) {
			if (name in params) return params[name];
			if (arguments.length >= 3) return fallback;
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

/** Run a resource executor for item 0 with a fresh cache. */
async function run(executor, operation, params, cache = G.createExecutionCache()) {
	const ctx = makeContext(params);
	const items = await executor.call(ctx, 0, operation, cache);
	for (const item of items) assert.deepEqual(item.pairedItem, { item: 0 });
	return { ctx, items, json: items.map((item) => item.json) };
}

const guidLocator = (value) => ({ mode: 'guid', value });
const enc = (guid) => encodeURIComponent(guid);

let base;
before(async () => {
	await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${httpServer.address().port}`;
});
after(() => httpServer.close());
beforeEach(() => bb.reset());

// --------------------------------------------------------------------------
// Chat
// --------------------------------------------------------------------------
test('chat get: encodes and normalizes the GUID, asks for participants and lastmessage', async () => {
	const guid = 'any;-;+15551234567';
	bb.routes[`GET /chat/${enc(guid)}`] = () => ({ guid, participants: [] });

	const { json } = await run(chat.execute, 'get', { chat: guidLocator('iMessage;-;+15551234567') });
	assert.deepEqual(json, [{ guid, participants: [] }]);
	assert.equal(bb.requests.length, 1);
	assert.equal(bb.requests[0].path, '/chat/any%3B-%3B%2B15551234567');
	assert.deepEqual(bb.requests[0].query, { with: 'participants,lastmessage' });
});

test('chat get: a chat without messages (500 on lastmessage) is retried without it', async () => {
	const guid = 'any;-;+15551234567(smsft_fi)';
	bb.routes[`GET /chat/${enc(guid)}`] = (req) =>
		req.query.with.includes('lastmessage')
			? {
					__status: 500,
					__body: err(
						500,
						'An unhandled error has occurred!',
						"Cannot read properties of null (reading 'ROWID')",
					),
				}
			: { guid, participants: [] };

	const { json } = await run(chat.execute, 'get', { chat: guidLocator(guid) });
	assert.deepEqual(json, [{ guid, participants: [] }]);
	assert.deepEqual(
		bb.requests.map((r) => r.query.with),
		['participants,lastmessage', 'participants'],
	);
});

test('chat get: By Address mode targets any;-;<address>; group GUIDs are not rewritten', async () => {
	bb.routes[`GET /chat/${enc('any;-;a@b.com')}`] = () => ({ guid: 'x' });
	bb.routes[`GET /chat/${enc('iMessage;+;chat123')}`] = () => ({ guid: 'y' });

	await run(chat.execute, 'get', { chat: { mode: 'address', value: ' a@b.com ' } });
	await run(chat.execute, 'get', { chat: { mode: 'list', value: 'iMessage;+;chat123' } });
	assert.deepEqual(
		bb.requests.map((r) => r.path),
		['/chat/any%3B-%3Ba%40b.com', '/chat/iMessage%3B%2B%3Bchat123'],
	);
});

test('chat get: 404 gets the chat hint and never leaks the password', async () => {
	const error = await rejects(run(chat.execute, 'get', { chat: guidLocator('any;-;+1999') }));
	assert.match(error.description, /Hint: Chat does not exist; check the chat GUID/);
	assert.ok(!errorText(error).includes(PASSWORD));
});

test('chat get: an envelope error on HTTP 200 throws without the password', async () => {
	const guid = 'any;-;+1555';
	bb.routes[`GET /chat/${enc(guid)}`] = () => ({
		__status: 200,
		__body: err(500, 'Server error', `boom password=${PASSWORD}`),
	});
	const error = await rejects(run(chat.execute, 'get', { chat: guidLocator(guid) }));
	assert.ok(error instanceof NodeApiError);
	assert.ok(!errorText(error).includes(PASSWORD));
});

test('chat simple actions: method, path and body', async () => {
	const guid = 'any;-;+15551234567';
	const g = enc(guid);
	const cases = [
		['markRead', {}, 'POST', `/chat/${g}/read`, undefined],
		['markUnread', {}, 'POST', `/chat/${g}/unread`, undefined],
		['startTyping', {}, 'POST', `/chat/${g}/typing`, undefined],
		['stopTyping', {}, 'DELETE', `/chat/${g}/typing`, undefined],
		['rename', { displayName: 'Weekend' }, 'PUT', `/chat/${g}`, { displayName: 'Weekend' }],
		[
			'addParticipant',
			{ address: ' +1222 ' },
			'POST',
			`/chat/${g}/participant/add`,
			{ address: '+1222' },
		],
		[
			'removeParticipant',
			{ address: '+1222' },
			'POST',
			`/chat/${g}/participant/remove`,
			{ address: '+1222' },
		],
		['leave', {}, 'POST', `/chat/${g}/leave`, undefined],
		['delete', {}, 'DELETE', `/chat/${g}`, undefined],
	];
	for (const [operation, params, method, p, body] of cases) {
		bb.reset();
		bb.routes[`${method} ${p}`] = () => null;
		const { json } = await run(chat.execute, operation, {
			chat: guidLocator('iMessage;-;+15551234567'),
			...params,
		});
		assert.equal(bb.requests.length, 1, operation);
		assert.equal(bb.requests[0].method, method, operation);
		assert.equal(bb.requests[0].path, p, operation);
		assert.deepEqual(bb.requests[0].body, body, operation);
		assert.deepEqual(json, [{ success: true, chatGuid: guid }], operation);
	}
});

test('chat actions return the server data when it is an object', async () => {
	const guid = 'iMessage;+;chat1';
	bb.routes[`PUT /chat/${enc(guid)}`] = () => ({ guid, displayName: 'New' });
	const { json } = await run(chat.execute, 'rename', {
		chat: guidLocator(guid),
		displayName: 'New',
	});
	assert.deepEqual(json, [{ guid, displayName: 'New' }]);
});

function chatList(count, unread = []) {
	return Array.from({ length: count }, (_, i) => ({
		guid: `any;-;+1${String(i).padStart(4, '0')}`,
		displayName: `Chat ${i}`,
		hasUnreadMessages: unread.includes(i),
	}));
}

function serveChats(all) {
	bb.routes['POST /chat/query'] = (req) =>
		all.slice(req.body.offset, req.body.offset + req.body.limit);
}

test('chat getMany: limit is the page size; body has sort and with', async () => {
	serveChats(chatList(10));
	const { json } = await run(chat.execute, 'getMany', { returnAll: false, limit: 3 });
	assert.equal(json.length, 3);
	assert.deepEqual(
		bb.requests.map((r) => r.body),
		[{ limit: 3, offset: 0, sort: 'lastmessage', with: ['lastmessage'] }],
	);
	assert.ok(json.every((c) => !('recentMessages' in c)));
});

test('chat getMany: Return All pages by 1000 until a short page', async () => {
	serveChats(chatList(1500));
	const { json } = await run(chat.execute, 'getMany', { returnAll: true });
	assert.equal(json.length, 1500);
	assert.deepEqual(
		bb.requests.map((r) => [r.body.limit, r.body.offset]),
		[
			[1000, 0],
			[1000, 1000],
		],
	);
});

test('chat getMany: Unread Only applies the limit after filtering, across pages', async () => {
	serveChats(chatList(250, [5, 150, 200]));
	const { json } = await run(chat.execute, 'getMany', {
		returnAll: false,
		limit: 2,
		options: { unreadOnly: true },
	});
	assert.deepEqual(
		json.map((c) => c.displayName),
		['Chat 5', 'Chat 150'],
	);
	// Two pages were needed to find two unread chats; it stopped once it had them.
	assert.deepEqual(
		bb.requests.map((r) => [r.body.limit, r.body.offset]),
		[
			[100, 0],
			[100, 100],
		],
	);
});

test('chat getMany: Unread Only stops at the end of the list with fewer results', async () => {
	serveChats(chatList(130, [7]));
	const { json } = await run(chat.execute, 'getMany', {
		returnAll: false,
		limit: 5,
		options: { unreadOnly: true },
	});
	assert.deepEqual(
		json.map((c) => c.displayName),
		['Chat 7'],
	);
	assert.equal(bb.requests.length, 2);
});

test('chat getMany: Include Recent Messages fetches N newest per chat, simplified', async () => {
	const chats = chatList(2);
	serveChats(chats);
	const message = {
		guid: 'm1',
		text: 'hi',
		handle: { address: '+1', service: 'iMessage', ROWID: 9 },
		isFromMe: false,
		dateCreated: 1,
		attachments: [],
		originalROWID: 42,
	};
	for (const c of chats) bb.routes[`GET /chat/${enc(c.guid)}/message`] = () => [message];

	const { json } = await run(chat.execute, 'getMany', {
		returnAll: false,
		limit: 2,
		simplify: true,
		options: { recentMessages: 3 },
	});
	const messageCalls = bb.requests.filter((r) => r.method === 'GET');
	assert.deepEqual(
		messageCalls.map((r) => r.path),
		chats.map((c) => `/chat/${enc(c.guid)}/message`),
	);
	for (const r of messageCalls)
		assert.deepEqual(r.query, { limit: '3', sort: 'DESC', with: 'attachment' });
	assert.deepEqual(json[0].recentMessages, [
		{
			guid: 'm1',
			text: 'hi',
			handle: { address: '+1', service: 'iMessage' },
			isFromMe: false,
			dateCreated: 1,
			attachments: [],
		},
	]);

	bb.reset();
	serveChats(chats);
	for (const c of chats) bb.routes[`GET /chat/${enc(c.guid)}/message`] = () => [message];
	const raw = await run(chat.execute, 'getMany', {
		returnAll: false,
		limit: 1,
		simplify: false,
		options: { recentMessages: 1 },
	});
	assert.deepEqual(raw.json[0].recentMessages, [message]);
});

test('chat create: addresses, message, resolved method, service and tempGuid', async () => {
	bb.routes['GET /server/info'] = () => ({ private_api: true, helper_connected: true });
	bb.routes['POST /chat/new'] = (req) => ({ guid: 'any;-;+1', echoed: req.body.service });

	const { json } = await run(chat.execute, 'create', {
		addresses: '+1555, a@b.com,\n ',
		message: 'Hello',
		service: 'SMS',
	});
	const create = bb.requests.find((r) => r.path === '/chat/new');
	assert.equal(create.method, 'POST');
	assert.deepEqual(Object.keys(create.body).sort(), [
		'addresses',
		'message',
		'method',
		'service',
		'tempGuid',
	]);
	assert.deepEqual(create.body.addresses, ['+1555', 'a@b.com']);
	assert.equal(create.body.message, 'Hello');
	assert.equal(create.body.method, 'private-api');
	assert.equal(create.body.service, 'SMS');
	assert.match(create.body.tempGuid, /^temp-[0-9a-f-]{36}$/);
	assert.deepEqual(json, [{ guid: 'any;-;+1', echoed: 'SMS' }]);

	// An explicit method skips /server/info.
	bb.reset();
	bb.routes['POST /chat/new'] = () => ({ guid: 'g' });
	await run(chat.execute, 'create', {
		addresses: '+1',
		message: 'x',
		service: 'iMessage',
		options: { method: 'apple-script' },
	});
	assert.deepEqual(
		bb.requests.map((r) => r.path),
		['/chat/new'],
	);
	assert.equal(bb.requests[0].body.method, 'apple-script');
});

test('chat create: rejects empty addresses before any request', async () => {
	const error = await rejects(
		run(chat.execute, 'create', { addresses: ' , ', message: 'x', service: 'iMessage' }),
	);
	assert.match(error.message, /address/i);
	assert.equal(bb.requests.length, 0);
});

// --------------------------------------------------------------------------
// Contact
// --------------------------------------------------------------------------
const CONTACTS = [
	{ displayName: 'Jane Doe', phoneNumbers: [{ address: '+1 (555) 123-0000' }], emails: [] },
	{ displayName: 'Bob', phoneNumbers: [], emails: [{ address: 'BOB@Example.com' }] },
	{ displayName: 'Carol', phoneNumbers: [{ address: '+15559990000' }] },
	{ displayName: null, emails: [{ address: 'nobody@x.org' }] },
];

test('contact getMany: GET /contact, case-insensitive search on name/phone/email', async () => {
	bb.routes['GET /contact'] = () => CONTACTS;
	const byName = await run(contact.execute, 'getMany', {
		returnAll: true,
		options: { search: 'jane' },
	});
	assert.deepEqual(
		byName.json.map((c) => c.displayName),
		['Jane Doe'],
	);
	assert.equal(bb.requests[0].method, 'GET');
	assert.equal(bb.requests[0].path, '/contact');

	const byEmail = await run(contact.execute, 'getMany', {
		returnAll: true,
		options: { search: 'example.COM' },
	});
	assert.deepEqual(
		byEmail.json.map((c) => c.displayName),
		['Bob'],
	);

	const byPhone = await run(contact.execute, 'getMany', {
		returnAll: true,
		options: { search: '999' },
	});
	assert.deepEqual(
		byPhone.json.map((c) => c.displayName),
		['Carol'],
	);

	const limited = await run(contact.execute, 'getMany', { returnAll: false, limit: 2 });
	assert.equal(limited.json.length, 2);
});

test('contact lookupByAddress: POST /contact/query with the address list', async () => {
	bb.routes['POST /contact/query'] = () => [CONTACTS[0]];
	const { json } = await run(contact.execute, 'lookupByAddress', {
		addresses: '+15551230000, jane@x.com',
	});
	assert.deepEqual(bb.requests[0].body, { addresses: ['+15551230000', 'jane@x.com'] });
	assert.deepEqual(json, [CONTACTS[0]]);
});

// --------------------------------------------------------------------------
// Handle
// --------------------------------------------------------------------------
test('handle checks: GET /handle/availability/{imessage|facetime}?address=', async () => {
	bb.routes['GET /handle/availability/imessage'] = () => ({ available: true });
	bb.routes['GET /handle/availability/facetime'] = () => ({ available: false });

	const im = await run(handle.execute, 'checkIMessage', { address: ' +15551234567 ' });
	assert.deepEqual(im.json, [{ address: '+15551234567', available: true }]);
	assert.deepEqual(bb.requests[0].query, { address: '+15551234567' });

	const ft = await run(handle.execute, 'checkFaceTime', { address: 'a@b.com' });
	assert.deepEqual(ft.json, [{ address: 'a@b.com', available: false }]);
	assert.equal(bb.requests[1].path, '/handle/availability/facetime');
});

// --------------------------------------------------------------------------
// Server
// --------------------------------------------------------------------------
test('server ping and getInfo', async () => {
	bb.routes['GET /ping'] = () => 'pong';
	bb.routes['GET /server/info'] = () => ({ os_version: '15.0', private_api: false });
	assert.deepEqual((await run(server.execute, 'ping', {})).json, [{ message: 'pong' }]);
	assert.deepEqual((await run(server.execute, 'getInfo', {})).json, [
		{ os_version: '15.0', private_api: false },
	]);
});

test('server getMyAddresses: iCloud aliases first, hidden skipped, de-duplicated, 8s timeout', async () => {
	bb.routes['GET /server/info'] = () => ({
		private_api: true,
		detected_imessage: ' Me@Example.com ',
		detected_icloud: 'other@icloud.com',
	});
	bb.routes['GET /icloud/account'] = () => ({
		account_name: ' Jane Doe ',
		active_alias: ' +15551234567 ',
		aliases: [
			{ Alias: 'me@example.com', IsUserVisible: true },
			{ Alias: 'hidden@example.com', IsUserVisible: false },
			{ Alias: '+15551234567' },
			{ Alias: '  ' },
			'junk',
		],
	});
	const { ctx, json } = await run(server.execute, 'getMyAddresses', {});
	assert.deepEqual(json, [
		{
			address: '+15551234567',
			addresses: ['+15551234567', 'me@example.com', 'other@icloud.com'],
			name: 'Jane Doe',
			source: 'icloud_account',
		},
	]);
	const icloudCall = ctx.calls.find((c) => c.url.endsWith('/icloud/account'));
	assert.equal(icloudCall.timeout, 8000);
});

test('server getMyAddresses: no iCloud call without private_api', async () => {
	bb.routes['GET /server/info'] = () => ({
		private_api: false,
		detected_imessage: '+15551234567',
		detected_icloud: '',
	});
	bb.routes['GET /icloud/account'] = () => assert.fail('must not be called');
	const { json } = await run(server.execute, 'getMyAddresses', {});
	assert.deepEqual(json, [
		{ address: '+15551234567', addresses: ['+15551234567'], name: null, source: 'server_info' },
	]);
	assert.deepEqual(
		bb.requests.map((r) => r.path),
		['/server/info'],
	);
});

test('server getMyAddresses: a failing iCloud call falls back to server_info', async () => {
	bb.routes['GET /server/info'] = () => ({ private_api: true, detected_imessage: 'me@x.com' });
	bb.routes['GET /icloud/account'] = () => ({
		__status: 500,
		__body: err(500, 'Server error', 'iMessage Private API is not enabled!'),
	});
	const { json } = await run(server.execute, 'getMyAddresses', {});
	assert.deepEqual(json, [
		{ address: 'me@x.com', addresses: ['me@x.com'], name: null, source: 'server_info' },
	]);
});

test('server getMyAddresses: reuses the per-execution /server/info cache', async () => {
	bb.routes['GET /server/info'] = () => ({ private_api: false, detected_imessage: 'me@x.com' });
	const cache = G.createExecutionCache();
	await run(server.execute, 'getMyAddresses', {}, cache);
	await run(server.execute, 'getMyAddresses', {}, cache);
	assert.equal(bb.requests.filter((r) => r.path === '/server/info').length, 1);
});

test('server getMyAddresses: throws when no address is known', async () => {
	bb.routes['GET /server/info'] = () => ({ private_api: false });
	const error = await rejects(run(server.execute, 'getMyAddresses', {}));
	assert.match(error.message, /Could not determine your addresses/);
});

// --------------------------------------------------------------------------
// searchChats (resource locator list)
// --------------------------------------------------------------------------
test('searchChats: chat/query body, names, values and next-offset token', async () => {
	const page = Array.from({ length: 100 }, (_, i) => ({ guid: `any;-;+1${i}`, displayName: '' }));
	page[0] = { guid: 'iMessage;+;chat1', displayName: 'Family' };
	page[1] = {
		guid: 'any;-;+1555',
		displayName: '',
		participants: [{ address: '+1555' }, { address: 'a@b.com' }],
	};
	bb.routes['POST /chat/query'] = (req) => (req.body.offset === 0 ? page : [page[0]]);

	const ctx = makeContext();
	const first = await searchChats.call(ctx);
	assert.deepEqual(bb.requests[0].body, {
		limit: 100,
		offset: 0,
		sort: 'lastmessage',
		with: ['lastmessage'],
	});
	assert.equal(first.results.length, 100);
	assert.deepEqual(first.results[0], { name: 'Family', value: 'iMessage;+;chat1' });
	assert.deepEqual(first.results[1], { name: '+1555, a@b.com', value: 'any;-;+1555' });
	assert.equal(first.results[2].name, 'any;-;+12');
	assert.equal(first.paginationToken, '100');

	const second = await searchChats.call(ctx, undefined, '100');
	assert.equal(bb.requests[1].body.offset, 100);
	assert.equal(second.paginationToken, undefined);

	const filtered = await searchChats.call(ctx, 'FAM');
	assert.deepEqual(filtered.results, [{ name: 'Family', value: 'iMessage;+;chat1' }]);
	const byGuid = await searchChats.call(ctx, 'a@b.com');
	assert.deepEqual(
		byGuid.results.map((r) => r.value),
		['any;-;+1555'],
	);
});
