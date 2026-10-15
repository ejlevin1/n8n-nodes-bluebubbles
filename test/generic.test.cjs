'use strict';
/**
 * Unit tests for the compiled GenericFunctions helpers used by the BlueBubbles
 * action node, against an in-process mock BlueBubbles server.
 *
 * The fake `httpRequestWithAuthentication` behaves like n8n-core: it appends the
 * password to the query string, honours `json` / `encoding: 'arraybuffer'` /
 * `returnFullResponse`, sends a WHATWG FormData body as multipart (letting the
 * client set the boundary), and throws `NodeApiError(node, axiosError)` whose
 * axios config / request URL contain the password.
 *
 * Run `npm run build` first (the `test` script does this).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NodeApiError } = require('n8n-workflow');
const G = require(path.join(ROOT, 'dist/nodes/BlueBubbles/GenericFunctions.js'));
const { BlueBubblesApi } = require(
	path.join(ROOT, 'dist/credentials/BlueBubblesApi.credentials.js'),
);

const PASSWORD = 'sup3r-s3cret-pw';

// --------------------------------------------------------------------------
// Mock BlueBubbles server
// --------------------------------------------------------------------------
const bb = {
	requests: [],
	serverInfo: { private_api: true, helper_connected: true },
	reset() {
		this.requests = [];
		this.serverInfo = { private_api: true, helper_connected: true };
	},
};

const err = (status, message, errorMessage) => ({
	status,
	message,
	error: { type: 'Server Error', message: errorMessage },
});

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const raw = Buffer.concat(chunks);
		const url = new URL(req.url, 'http://mock');
		const query = Object.fromEntries(url.searchParams);
		bb.requests.push({
			method: req.method,
			path: url.pathname,
			query,
			headers: req.headers,
			raw,
		});
		const send = (code, payload) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		if (query.password !== PASSWORD)
			return send(401, err(401, 'You are not authorized', 'Unauthorized'));

		const p = url.pathname.replace(/^\/api\/v1/, '');
		if (p === '/server/info') return send(200, { status: 200, message: 'ok', data: bb.serverInfo });
		if (p === '/ok')
			return send(200, { status: 200, message: 'Success', data: { hello: 'world' } });
		if (p === '/envelope-error')
			// HTTP 200, but the envelope reports a failure and echoes the password.
			return send(200, err(400, 'Bad things', `password=${PASSWORD} was rejected`));
		if (p === '/private-api')
			return send(500, err(500, 'Server error', 'iMessage Private API is not enabled!'));
		if (p.startsWith('/chat/')) return send(404, err(404, 'Not found', 'Chat does not exist!'));
		if (p === '/attachment/abc/download') {
			res.writeHead(200, { 'content-type': 'image/png' });
			return res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]));
		}
		if (p === '/attachment/missing/download')
			return send(404, err(404, 'Not found', `Attachment does not exist (${PASSWORD})`));
		if (p === '/message/attachment') {
			return send(200, {
				status: 200,
				message: 'Message sent!',
				data: { guid: 'msg-1', contentType: req.headers['content-type'] },
			});
		}
		return send(404, err(404, 'Not found', 'Not Found'));
	});
});

// --------------------------------------------------------------------------
// Fake n8n context
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

/** One request like n8n-core's helper (password from the credential's qs). */
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
	if (opts.body instanceof FormData) {
		init.body = opts.body; // fetch (like axios) sets the multipart boundary
	} else if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		init.headers['content-type'] = 'application/json';
	}

	let res;
	try {
		res = await fetch(url, init);
	} catch (e) {
		throw new AxiosError(e.message, e.cause?.code ?? 'ECONNREFUSED', config);
	}
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
		const response = { status: res.status, statusText: res.statusText, data, headers, config };
		throw new AxiosError(
			`Request failed with status code ${res.status}`,
			'ERR_BAD_REQUEST',
			config,
			response,
		);
	}
	return opts.returnFullResponse ? { body: data, headers, statusCode: res.status } : data;
}

function makeContext(serverUrl) {
	const credentials = { serverUrl, password: PASSWORD };
	const calls = [];
	const logger = {};
	for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};
	return {
		calls,
		logger,
		getNode: () => NODE,
		getCredentials: async (type) => {
			assert.equal(type, 'blueBubblesApi');
			return credentials;
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

/** Every place a secret could hide on an n8n error. */
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

let base;
before(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => bb.reset());

// --------------------------------------------------------------------------
// GUID helpers
// --------------------------------------------------------------------------
test('normalizeChatGuid rewrites only a leading iMessage;-; prefix', () => {
	assert.equal(G.normalizeChatGuid('iMessage;-;+15551234567'), 'any;-;+15551234567');
	assert.equal(G.normalizeChatGuid('iMessage;-;a@b.com'), 'any;-;a@b.com');
	assert.equal(G.normalizeChatGuid('any;-;+15551234567'), 'any;-;+15551234567');
	assert.equal(G.normalizeChatGuid('SMS;-;+15551234567'), 'SMS;-;+15551234567');
	assert.equal(G.normalizeChatGuid('iMessage;+;chat123456'), 'iMessage;+;chat123456');
	assert.equal(G.normalizeChatGuid('x;iMessage;-;y'), 'x;iMessage;-;y');
	// Never strips the SMS address suffixes.
	assert.equal(G.normalizeChatGuid('any;-;12345(smsft)'), 'any;-;12345(smsft)');
	assert.equal(G.normalizeChatGuid('iMessage;-;12345(smsfp)'), 'any;-;12345(smsfp)');
});

test('addressToChatGuid trims and prefixes any;-;', () => {
	assert.equal(G.addressToChatGuid('  +15551234567 '), 'any;-;+15551234567');
	assert.equal(G.addressToChatGuid('a@b.com'), 'any;-;a@b.com');
});

test('tempGuid returns temp-<uuid v4>, unique per call', () => {
	const a = G.tempGuid();
	assert.match(a, /^temp-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.notEqual(a, G.tempGuid());
});

// --------------------------------------------------------------------------
// Envelope and errors
// --------------------------------------------------------------------------
test('blueBubblesApiCall returns envelope data; blueBubblesApiRequest returns the envelope', async () => {
	const ctx = makeContext(base);
	const data = await G.blueBubblesApiCall.call(ctx, {
		method: 'GET',
		endpoint: '/ok',
		operation: 'Could not ok',
	});
	assert.deepEqual(data, { hello: 'world' });
	const raw = await G.blueBubblesApiRequest.call(ctx, {
		method: 'GET',
		endpoint: '/ok',
		operation: 'Could not ok',
	});
	assert.equal(raw.status, 200);
	assert.deepEqual(raw.data, { hello: 'world' });
});

test('HTTP 200 with envelope status >= 400 throws a redacted NodeApiError', async () => {
	const ctx = makeContext(base);
	const error = await rejects(
		G.blueBubblesApiCall.call(ctx, {
			method: 'POST',
			endpoint: '/envelope-error',
			body: { a: 1 },
			operation: 'Could not do the thing',
			hints: { 400: 'Custom 400 hint' },
		}),
	);
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '400');
	assert.match(error.message, /Could not do the thing \(HTTP 400\)/);
	assert.match(error.description, /was rejected/);
	assert.match(error.description, /Hint: Custom 400 hint/);
	assert.ok(!errorText(error).includes(PASSWORD), 'password leaked');
});

test('timeout is passed through to the HTTP helper', async () => {
	const ctx = makeContext(base);
	await G.blueBubblesApiCall.call(ctx, {
		method: 'GET',
		endpoint: '/ok',
		operation: 'x',
		timeout: 8000,
	});
	assert.equal(ctx.calls[0].timeout, 8000);
	await G.blueBubblesApiCall.call(ctx, { method: 'GET', endpoint: '/ok', operation: 'x' });
	assert.equal('timeout' in ctx.calls[1], false);
});

test('hints override the default hint for a status (CHAT_404_HINT)', async () => {
	const ctx = makeContext(base);
	const opts = {
		method: 'GET',
		endpoint: `/chat/${encodeURIComponent('any;-;+1555')}`,
		operation: 'Could not get chat',
	};
	const withHint = await rejects(
		G.blueBubblesApiCall.call(ctx, { ...opts, hints: { 404: G.CHAT_404_HINT } }),
	);
	assert.equal(G.CHAT_404_HINT, 'Chat does not exist; check the chat GUID');
	assert.match(withHint.description, /Hint: Chat does not exist; check the chat GUID/);
	assert.doesNotMatch(withHint.description, /webhook/i);

	const withoutHint = await rejects(G.blueBubblesApiCall.call(ctx, opts));
	assert.match(withoutHint.description, /webhook API requires/);
	assert.ok(!errorText(withHint).includes(PASSWORD));
});

test('500 "Private API is not enabled" gets the Private API hint', async () => {
	const ctx = makeContext(base);
	const error = await rejects(
		G.blueBubblesApiCall.call(ctx, { method: 'POST', endpoint: '/private-api', operation: 'x' }),
	);
	assert.equal(error.httpCode, '500');
	assert.ok(error.description.includes(`Hint: ${G.PRIVATE_API_HINT}`));
	assert.match(G.PRIVATE_API_HINT, /Enable Private API.*SIP off, helper connected/);
});

// --------------------------------------------------------------------------
// Send method
// --------------------------------------------------------------------------
async function resolve(info, override = 'auto', cache = G.createExecutionCache()) {
	bb.serverInfo = info;
	const ctx = makeContext(base);
	return G.resolveSendMethod(ctx, override, cache);
}

test('resolveSendMethod: private_api and helper_connected cases', async () => {
	assert.equal(await resolve({ private_api: true, helper_connected: true }), 'private-api');
	assert.equal(await resolve({ private_api: true }), 'private-api'); // missing = connected
	assert.equal(await resolve({ private_api: true, helper_connected: false }), 'apple-script');
	assert.equal(await resolve({ private_api: true, helper_connected: 0 }), 'apple-script');
	assert.equal(await resolve({ private_api: false, helper_connected: true }), 'apple-script');
	assert.equal(await resolve({}), 'apple-script');
});

test('resolveSendMethod: explicit override skips /server/info', async () => {
	assert.equal(await resolve({ private_api: false }, 'private-api'), 'private-api');
	assert.equal(await resolve({ private_api: true }, 'apple-script'), 'apple-script');
	assert.equal(bb.requests.length, 0);
});

test('resolveSendMethod: /server/info is fetched once per cache object', async () => {
	const ctx = makeContext(base);
	const cache = G.createExecutionCache();
	const results = await Promise.all([
		G.resolveSendMethod(ctx, 'auto', cache),
		G.resolveSendMethod(ctx, 'auto', cache),
	]);
	await G.resolveSendMethod(ctx, 'auto', cache);
	assert.deepEqual(results, ['private-api', 'private-api']);
	assert.equal(bb.requests.filter((r) => r.path === '/api/v1/server/info').length, 1);

	await G.resolveSendMethod(ctx, 'auto', G.createExecutionCache());
	assert.equal(bb.requests.filter((r) => r.path === '/api/v1/server/info').length, 2);
});

// --------------------------------------------------------------------------
// Binary and form requests
// --------------------------------------------------------------------------
test('blueBubblesBinaryRequest returns the bytes and headers', async () => {
	const ctx = makeContext(base);
	const { buffer, headers } = await G.blueBubblesBinaryRequest.call(ctx, {
		method: 'GET',
		endpoint: '/attachment/abc/download',
		operation: 'Could not download attachment',
	});
	assert.ok(Buffer.isBuffer(buffer));
	assert.deepEqual([...buffer], [0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
	assert.equal(headers['content-type'], 'image/png');
	const opts = ctx.calls[0];
	assert.equal(opts.encoding, 'arraybuffer');
	assert.equal(opts.returnFullResponse, true);
	assert.equal(opts.json, undefined);
});

test('blueBubblesBinaryRequest decodes a Buffer error body and redacts it', async () => {
	const ctx = makeContext(base);
	const error = await rejects(
		G.blueBubblesBinaryRequest.call(ctx, {
			method: 'GET',
			endpoint: '/attachment/missing/download',
			operation: 'Could not download attachment',
			hints: { 404: 'Attachment not found' },
		}),
	);
	assert.ok(error instanceof NodeApiError);
	assert.equal(error.httpCode, '404');
	assert.match(error.description, /BlueBubbles error: Attachment does not exist/);
	assert.match(error.description, /Hint: Attachment not found/);
	assert.ok(!errorText(error).includes(PASSWORD), 'password leaked');
});

test('blueBubblesFormRequest sends FormData without a manual Content-Type', async () => {
	const ctx = makeContext(base);
	const file = Buffer.from('hello world');
	const data = await G.blueBubblesFormRequest.call(ctx, {
		method: 'POST',
		endpoint: '/message/attachment',
		operation: 'Could not send attachment',
		fields: {
			chatGuid: 'any;-;+1555',
			tempGuid: 'temp-1',
			method: 'apple-script',
			skip: undefined,
		},
		files: [{ fieldName: 'attachment', buffer: file, fileName: 'hi.txt', mimeType: 'text/plain' }],
	});
	const opts = ctx.calls[0];
	assert.ok(opts.body instanceof FormData);
	assert.equal(opts.json, undefined);
	assert.equal(opts.headers, undefined);
	assert.equal(opts.qs.password, undefined); // the credential adds it

	const req = bb.requests[0];
	assert.equal(req.query.password, PASSWORD);
	assert.match(req.headers['content-type'], /^multipart\/form-data; boundary=/);
	assert.match(data.contentType, /^multipart\/form-data; boundary=/);
	assert.equal(data.guid, 'msg-1');
	const raw = req.raw.toString('utf8');
	assert.match(raw, /name="chatGuid"\r\n\r\nany;-;\+1555/);
	assert.match(
		raw,
		/name="attachment"; filename="hi.txt"\r\nContent-Type: text\/plain\r\n\r\nhello world/,
	);
	assert.doesNotMatch(raw, /name="skip"/);
});

// --------------------------------------------------------------------------
// simplifyMessage
// --------------------------------------------------------------------------
test('simplifyMessage projects exactly the slim fields', () => {
	const msg = {
		guid: 'g',
		text: 't',
		handle: { address: '+1', service: 'iMessage', country: 'us', originalROWID: 3 },
		isFromMe: false,
		dateCreated: 1,
		attachments: [],
		replyToGuid: null,
		associatedMessageGuid: null,
		associatedMessageType: null,
		dateEdited: null,
		dateRetracted: null,
		isAudioMessage: false,
		error: 0,
		chats: [{ guid: 'c', displayName: 'D', isArchived: false, participants: [] }],
		originalROWID: 9,
		subject: 's',
	};
	assert.deepEqual(G.simplifyMessage(msg), {
		guid: 'g',
		text: 't',
		handle: { address: '+1', service: 'iMessage' },
		isFromMe: false,
		dateCreated: 1,
		attachments: [],
		replyToGuid: null,
		associatedMessageGuid: null,
		associatedMessageType: null,
		dateEdited: null,
		dateRetracted: null,
		isAudioMessage: false,
		error: 0,
		chats: [{ guid: 'c', displayName: 'D', isArchived: false }],
	});
	assert.deepEqual(G.simplifyMessage({ guid: 'x', foo: 1 }), { guid: 'x' });
});
