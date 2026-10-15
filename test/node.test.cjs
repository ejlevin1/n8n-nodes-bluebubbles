'use strict';
/**
 * Tests for the BlueBubbles action node shell (dist/nodes/BlueBubbles/BlueBubbles.node.js):
 * the description (resources, operations, property name collisions), the
 * execute() router (dispatch, shared per-execution cache, pairedItem) and
 * continueOnFail handling, against an in-process mock BlueBubbles server.
 *
 * The fake n8n context mirrors test/generic.test.cjs. Run `npm run build` first
 * (the `test` script does this).
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { NodeApiError, NodeOperationError } = require('n8n-workflow');
const { BlueBubbles } = require(path.join(ROOT, 'dist/nodes/BlueBubbles/BlueBubbles.node.js'));
const { BlueBubblesApi } = require(
	path.join(ROOT, 'dist/credentials/BlueBubblesApi.credentials.js'),
);
const pkg = require(path.join(ROOT, 'package.json'));

const PASSWORD = 'sup3r-s3cret-pw';

/** Every resource and the operations it must expose. */
const EXPECTED = {
	message: ['send', 'sendToAddress', 'get', 'getMany', 'search', 'react', 'edit', 'unsend'],
	chat: [
		'get',
		'getMany',
		'markRead',
		'markUnread',
		'startTyping',
		'stopTyping',
		'rename',
		'addParticipant',
		'removeParticipant',
		'leave',
		'delete',
		'create',
	],
	attachment: ['get', 'download', 'send'],
	contact: ['getMany', 'lookupByAddress'],
	handle: ['checkIMessage', 'checkFaceTime'],
	scheduledMessage: ['create', 'getMany', 'delete'],
	server: ['ping', 'getInfo', 'getMyAddresses'],
};

// --------------------------------------------------------------------------
// Mock BlueBubbles server
// --------------------------------------------------------------------------
const bb = {
	reset() {
		this.requests = [];
	},
};
bb.reset();

const ok = (data) => ({ status: 200, message: 'Success', data });
const err = (status, message, errorMessage) => ({
	status,
	message,
	error: { type: 'Server Error', message: errorMessage },
});

const server = http.createServer((req, res) => {
	const chunks = [];
	req.on('data', (chunk) => chunks.push(chunk));
	req.on('end', () => {
		const url = new URL(req.url, 'http://mock');
		const query = Object.fromEntries(url.searchParams);
		const raw = Buffer.concat(chunks).toString('utf8');
		const p = url.pathname.replace(/^\/api\/v1/, '');
		bb.requests.push({
			method: req.method,
			path: p,
			query,
			body: raw ? JSON.parse(raw) : undefined,
		});
		const send = (code, payload) => {
			res.writeHead(code, { 'content-type': 'application/json' });
			res.end(JSON.stringify(payload));
		};
		if (query.password !== PASSWORD)
			return send(401, err(401, 'You are not authorized', 'Unauthorized'));

		if (p === '/ping') return send(200, ok('pong'));
		if (p === '/server/info')
			return send(200, ok({ private_api: true, helper_connected: true, os_version: '14.5' }));
		if (req.method === 'POST' && p === '/message/text') {
			const body = JSON.parse(raw);
			return send(200, ok({ guid: `sent-${body.message}`, text: body.message }));
		}
		if (p === '/message/m-1')
			return send(
				200,
				ok({
					guid: 'm-1',
					text: 'hello',
					handle: { address: '+15550001111', service: 'iMessage', country: 'us' },
					isFromMe: false,
					dateCreated: 1700000000000,
					attachments: [],
					originalROWID: 1,
				}),
			);
		return send(404, err(404, 'Not found', 'Not Found'));
	});
});

// --------------------------------------------------------------------------
// Fake n8n execute context
// --------------------------------------------------------------------------
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
	const url = new URL(opts.url);
	for (const [key, expr] of Object.entries(credentialType.authenticate.properties.qs)) {
		url.searchParams.set(key, credentials[/\$credentials\.(\w+)/.exec(expr)[1]]);
	}
	for (const [key, value] of Object.entries(opts.qs ?? {}))
		url.searchParams.set(key, String(value));
	const init = { method: opts.method, headers: { ...(opts.headers ?? {}) } };
	if (opts.body !== undefined) {
		init.body = JSON.stringify(opts.body);
		init.headers['content-type'] = 'application/json';
	}
	const res = await fetch(url, init);
	const text = await res.text();
	let data = text;
	try {
		data = JSON.parse(text);
	} catch {
		// keep text
	}
	if (res.status >= 400) {
		const error = new Error(`Request failed with status code ${res.status}`);
		error.name = 'AxiosError';
		error.isAxiosError = true;
		error.config = { url: url.toString(), method: opts.method };
		error.response = { status: res.status, statusText: res.statusText, data, headers: {} };
		throw error;
	}
	return opts.returnFullResponse ? { body: data, headers: {}, statusCode: res.status } : data;
}

/**
 * @param {Array<Record<string, unknown>>} itemParams node parameters per input item
 * @param {{ continueOnFail?: boolean }} [flags]
 */
function makeContext(itemParams, { continueOnFail = false } = {}) {
	const credentials = { serverUrl: base, password: PASSWORD };
	const logger = {};
	for (const level of ['error', 'warn', 'info', 'debug']) logger[level] = () => {};
	return {
		logger,
		getNode: () => NODE,
		getInputData: () => itemParams.map((_, i) => ({ json: { i } })),
		continueOnFail: () => continueOnFail,
		getTimezone: () => 'UTC',
		getCredentials: async (type) => {
			assert.equal(type, 'blueBubblesApi');
			return credentials;
		},
		getNodeParameter(name, itemIndex, fallback) {
			const params = itemParams[itemIndex];
			if (params && name in params) return params[name];
			if (arguments.length >= 3) return fallback;
			throw new Error(`Missing parameter ${name}`);
		},
		helpers: {
			async httpRequestWithAuthentication(type, opts) {
				assert.equal(type, 'blueBubblesApi');
				try {
					return await sendRequest(opts, credentials);
				} catch (error) {
					throw new NodeApiError(NODE, error);
				}
			},
		},
	};
}

let base;
before(async () => {
	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => bb.reset());

const node = new BlueBubbles();
const { description } = node;

// --------------------------------------------------------------------------
// Description
// --------------------------------------------------------------------------
test('package.json registers the action node', () => {
	assert.ok(pkg.n8n.nodes.includes('dist/nodes/BlueBubbles/BlueBubbles.node.js'));
	assert.ok(pkg.n8n.nodes.includes('dist/nodes/BlueBubbles/BlueBubblesTrigger.node.js'));
});

test('description basics', () => {
	assert.equal(description.name, 'blueBubbles');
	assert.equal(description.displayName, 'BlueBubbles');
	assert.equal(description.version, 1);
	assert.equal(description.usableAsTool, true);
	assert.deepEqual(description.credentials, [{ name: 'blueBubblesApi', required: true }]);
	assert.equal(credentialType.name, 'blueBubblesApi');
});

test('description exposes every resource and operation', () => {
	const resource = description.properties.find((p) => p.name === 'resource');
	assert.ok(resource, 'resource property');
	assert.equal(resource.noDataExpression, true);
	assert.equal(resource.default, 'message');
	assert.deepEqual(resource.options.map((o) => o.value).sort(), Object.keys(EXPECTED).sort());

	for (const [res, ops] of Object.entries(EXPECTED)) {
		const opProps = description.properties.filter(
			(p) => p.name === 'operation' && p.displayOptions?.show?.resource?.includes(res),
		);
		assert.equal(opProps.length, 1, `exactly one operation dropdown for ${res}`);
		const [opProp] = opProps;
		assert.equal(opProp.noDataExpression, true, `${res} operation noDataExpression`);
		assert.deepEqual(opProp.options.map((o) => o.value).sort(), [...ops].sort(), res);
		assert.ok(ops.includes(opProp.default), `${res} default operation is valid`);
		for (const option of opProp.options) assert.ok(option.action, `${res}.${option.value} action`);
	}
});

test('repeated property names are always scoped and never visible together', () => {
	const byName = new Map();
	for (const p of description.properties) {
		if (!byName.has(p.name)) byName.set(p.name, []);
		byName.get(p.name).push(p);
	}
	for (const [name, props] of byName) {
		if (props.length < 2) continue;
		for (const p of props) {
			assert.ok(p.displayOptions?.show?.resource, `"${name}" repeats without show.resource`);
		}
	}

	// For each resource/operation pair, no two properties with the same name
	// may be shown under the same extra display conditions.
	for (const [res, ops] of Object.entries(EXPECTED)) {
		for (const op of ops) {
			const seen = new Map();
			for (const p of description.properties) {
				const show = p.displayOptions?.show;
				if (!show) continue;
				if (show.resource && !show.resource.includes(res)) continue;
				if (show.operation && !show.operation.includes(op)) continue;
				const { resource: _r, operation: _o, ...rest } = show;
				const key = `${p.name}|${JSON.stringify(rest)}`;
				assert.ok(!seen.has(key), `"${p.name}" shown twice for ${res}.${op}`);
				seen.set(key, p);
			}
		}
	}
});

test('methods.listSearch.searchChats exists', () => {
	assert.equal(typeof node.methods?.listSearch?.searchChats, 'function');
	const locators = description.properties.filter((p) => p.type === 'resourceLocator');
	assert.ok(locators.length > 0);
	for (const locator of locators) {
		for (const mode of locator.modes.filter((m) => m.type === 'list')) {
			assert.ok(
				node.methods.listSearch[mode.typeOptions.searchListMethod],
				`list search ${mode.typeOptions.searchListMethod}`,
			);
		}
	}
});

// --------------------------------------------------------------------------
// execute()
// --------------------------------------------------------------------------
test('dispatches Server > Ping with a paired item', async () => {
	const ctx = makeContext([{ resource: 'server', operation: 'ping' }]);
	const [out] = await node.execute.call(ctx);
	assert.equal(out.length, 1);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.deepEqual(
		bb.requests.map((r) => `${r.method} ${r.path}`),
		['GET /ping'],
	);
});

test('dispatches Message > Get with simplify', async () => {
	const ctx = makeContext([
		{ resource: 'message', operation: 'get', messageGuid: 'm-1', simplify: true },
	]);
	const [out] = await node.execute.call(ctx);
	assert.equal(out.length, 1);
	assert.equal(out[0].json.guid, 'm-1');
	assert.equal(out[0].json.originalROWID, undefined, 'simplified');
	assert.deepEqual(out[0].pairedItem, { item: 0 });
});

test('one send-method cache is shared by every item of an execution', async () => {
	const item = (text) => ({
		resource: 'message',
		operation: 'send',
		chat: { mode: 'guid', value: 'iMessage;-;+15550001111' },
		text,
		options: {},
	});
	const ctx = makeContext([item('a'), item('b'), item('c')]);
	const [out] = await node.execute.call(ctx);
	assert.equal(out.length, 3);
	assert.deepEqual(
		out.map((o) => o.pairedItem),
		[{ item: 0 }, { item: 1 }, { item: 2 }],
	);
	assert.equal(bb.requests.filter((r) => r.path === '/server/info').length, 1);
	const sends = bb.requests.filter((r) => r.path === '/message/text');
	assert.equal(sends.length, 3);
	for (const s of sends) {
		assert.equal(s.body.chatGuid, 'any;-;+15550001111');
		assert.equal(s.body.method, 'private-api');
	}

	// A new execution gets a fresh cache.
	await node.execute.call(makeContext([item('d')]));
	assert.equal(bb.requests.filter((r) => r.path === '/server/info').length, 2);
});

test('continueOnFail turns a failing item into an error item and keeps going', async () => {
	const ctx = makeContext(
		[
			{ resource: 'message', operation: 'get', messageGuid: 'missing', simplify: true },
			{ resource: 'server', operation: 'ping' },
			{ resource: 'nope', operation: 'x' },
		],
		{ continueOnFail: true },
	);
	const [out] = await node.execute.call(ctx);
	assert.equal(out.length, 3);
	assert.equal(typeof out[0].json.error, 'string');
	assert.ok(out[0].json.error.length > 0);
	assert.deepEqual(out[0].pairedItem, { item: 0 });
	assert.equal(out[1].json.error, undefined);
	assert.deepEqual(out[1].pairedItem, { item: 1 });
	assert.match(out[2].json.error, /Unsupported resource/);
	assert.deepEqual(out[2].pairedItem, { item: 2 });
	assert.ok(!JSON.stringify(out).includes(PASSWORD));
});

test('without continueOnFail, API errors propagate as NodeApiError with the item index', async () => {
	const ctx = makeContext([
		{ resource: 'server', operation: 'ping' },
		{ resource: 'message', operation: 'get', messageGuid: 'missing', simplify: true },
	]);
	await assert.rejects(node.execute.call(ctx), (error) => {
		assert.ok(error instanceof NodeApiError);
		assert.equal(error.context.itemIndex, 1);
		assert.ok(!JSON.stringify(error).includes(PASSWORD));
		return true;
	});
});

test('without continueOnFail, an unknown resource is a NodeOperationError', async () => {
	const ctx = makeContext([{ resource: 'nope', operation: 'x' }]);
	await assert.rejects(node.execute.call(ctx), (error) => {
		assert.ok(error instanceof NodeOperationError);
		assert.equal(error.context.itemIndex, 0);
		return true;
	});
});
