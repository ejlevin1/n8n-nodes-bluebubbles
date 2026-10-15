import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';
import { randomUUID } from 'crypto';

export type BlueBubblesContext =
	IHookFunctions | IWebhookFunctions | IExecuteFunctions | ILoadOptionsFunctions;

/**
 * Per-request overrides for the "Hint:" sentence of an error, keyed by HTTP status.
 *
 * The built-in hints describe the webhook API (used by the trigger); action
 * operations pass their own, e.g. `{ 404: CHAT_404_HINT }`.
 */
export type BlueBubblesErrorHints = Partial<Record<number, string>>;

/** Hint for chat routes that answer 404. */
export const CHAT_404_HINT = 'Chat does not exist; check the chat GUID';

/** Hint used whenever the server says the Private API is required but off. */
export const PRIVATE_API_HINT =
	'Enable Private API in BlueBubbles Server (SIP off, helper connected)';

/**
 * Default request timeout. BlueBubbles Server gives up on Private API helper
 * transactions after 120 s ("Transaction timeout"), so waiting slightly longer
 * lets the server's own error come through instead of a client-side timeout.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 150_000;

/**
 * Default timeout for attachment downloads and multipart uploads, which move
 * whole files and can legitimately take much longer than a JSON call.
 */
export const ATTACHMENT_REQUEST_TIMEOUT_MS = 600_000;

/** Options for {@link blueBubblesApiRequest}. */
export interface BlueBubblesRequestOptions {
	method: IHttpRequestMethods;
	/** Path relative to `/api/v1`, starting with `/` (e.g. `/webhook`). */
	endpoint: string;
	/** Optional JSON body; omitted when empty. */
	body?: IDataObject;
	/** Optional query-string parameters (the password is added by the credential). */
	qs?: IDataObject;
	/**
	 * Human-readable description of what failed, used as the error message prefix,
	 * e.g. "Could not list BlueBubbles webhooks".
	 */
	operation: string;
	/**
	 * Request timeout in milliseconds (passed to the n8n HTTP helper). Defaults to
	 * {@link DEFAULT_REQUEST_TIMEOUT_MS}, or {@link ATTACHMENT_REQUEST_TIMEOUT_MS}
	 * for binary downloads and multipart uploads.
	 */
	timeout?: number;
	/** Operation-specific hints that replace the default hint for a status code. */
	hints?: BlueBubblesErrorHints;
}

/** A file part of a multipart request. */
export interface BlueBubblesFormFile {
	/** Multipart field name, e.g. `attachment`. */
	fieldName: string;
	/** File contents, e.g. from `this.helpers.getBinaryDataBuffer()`. */
	buffer: Buffer;
	/** File name sent in the part's Content-Disposition. */
	fileName: string;
	/** MIME type of the part; defaults to `application/octet-stream`. */
	mimeType?: string;
}

/** Options for {@link blueBubblesFormRequest}. */
export interface BlueBubblesFormRequestOptions extends Omit<BlueBubblesRequestOptions, 'body'> {
	/** Plain text fields; `undefined` / `null` values are skipped. */
	fields?: Record<string, string | number | boolean | null | undefined>;
	/** File parts. */
	files?: BlueBubblesFormFile[];
}

/** Result of {@link blueBubblesBinaryRequest}. */
export interface BlueBubblesBinaryResponse {
	buffer: Buffer;
	headers: IDataObject;
}

/** How a message is sent: through the injected helper or through AppleScript. */
export type SendMethod = 'private-api' | 'apple-script';

/** The user's choice; `auto` asks the server. */
export type SendMethodOverride = 'auto' | SendMethod;

/**
 * State shared by all items of one node execution. Create one per `execute()`
 * call with {@link createExecutionCache}; never keep it in module scope.
 */
export interface BlueBubblesExecutionCache {
	/** In-flight or settled `GET /server/info` (its `data`). */
	serverInfo?: Promise<IDataObject>;
	/**
	 * Set once a Message > Search in "Auto" mode saw the Spotlight path time out
	 * or fail; later items of the same execution go straight to the database.
	 */
	spotlightFailed?: boolean;
}

/** Details extracted from whatever the n8n HTTP helper threw. */
export interface RequestFailure {
	/** HTTP status code, when the server answered. */
	status?: number;
	/** Node.js / axios network error code (ECONNREFUSED, ENOTFOUND, ...). */
	code?: string;
	/** Error text from the BlueBubbles response envelope (`error.message` / `message`). */
	serverMessage?: string;
	/** Innermost raw error message (e.g. "connect ECONNREFUSED 10.0.0.2:1234"). */
	rawMessage?: string;
}

/** Short reason used in the error message when a request hits its timeout. */
const REQUEST_TIMED_OUT = 'request timed out';

/** Short reason used in the error message when a connection attempt times out. */
const CONNECTION_TIMED_OUT = 'connection timed out';

/** Network error codes that mean "n8n could not reach the server". */
const CONNECTION_ERROR_CODES: Record<string, string> = {
	ECONNREFUSED: 'connection refused',
	ENOTFOUND: 'host not found',
	EAI_AGAIN: 'DNS lookup failed',
	ETIMEDOUT: CONNECTION_TIMED_OUT,
	ECONNABORTED: REQUEST_TIMED_OUT,
	ESOCKETTIMEDOUT: REQUEST_TIMED_OUT,
	EHOSTUNREACH: 'host unreachable',
	ENETUNREACH: 'network unreachable',
	ECONNRESET: 'connection reset',
	EPIPE: 'connection closed',
	UND_ERR_CONNECT_TIMEOUT: CONNECTION_TIMED_OUT,
};

/** Query-string keys the BlueBubbles server accepts as the server password. */
const SECRET_QUERY_KEYS = 'password|guid|token';

/** Shortest credential value that is redacted by literal match (avoids mangling text). */
const MIN_LITERAL_SECRET_LENGTH = 3;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

/**
 * Remove anything secret-looking from free text: query strings of URLs,
 * `password=` / `guid=` / `token=` parameters, URL user-info, and any literal
 * occurrence of the given secrets.
 */
export function redactSecrets(text: string, secrets: string[] = []): string {
	let out = text
		// Drop the query string (and fragment) of every URL in the text.
		.replace(/(https?:\/\/[^\s?#"'<>]+)[?#][^\s"'<>]*/gi, '$1')
		// Drop user-info (user:pass@) from URLs.
		.replace(/(https?:\/\/)[^\s/@"'<>]+@/gi, '$1')
		// Belt and braces: redact password-like parameters that are not part of a URL.
		.replace(new RegExp(`((?:${SECRET_QUERY_KEYS})=)[^&#\\s"'<>]*`, 'gi'), '$1***');

	for (const secret of secrets) {
		if (secret.length >= MIN_LITERAL_SECRET_LENGTH) {
			out = out.split(secret).join('***');
		}
	}
	return out;
}

/** A URL that is safe to show to users and logs: no user-info, query or fragment. */
export function toDisplayUrl(url: string): string {
	return url
		.replace(/[?#].*$/, '')
		.replace(/^(https?:\/\/)[^/@]*@/i, '$1')
		.replace(/\/+$/, '');
}

/**
 * Validate and normalize the credential's server URL.
 *
 * Keeps the scheme and any reverse-proxy path prefix intact; only trims
 * whitespace and trailing slashes.
 *
 * @throws NodeOperationError when the URL has no http(s) scheme or contains a query string
 */
export function normalizeServerUrl(node: INode, rawServerUrl: unknown): string {
	const value = typeof rawServerUrl === 'string' ? rawServerUrl.trim() : '';
	const shown = value ? `"${toDisplayUrl(value)}"` : 'an empty value';

	if (!/^https?:\/\/[^/?#\s]+/i.test(value)) {
		throw new NodeOperationError(node, 'Invalid BlueBubbles server URL', {
			description: `The Server URL in the BlueBubbles credential must start with http:// or https:// and include the host and port, e.g. http://192.168.1.10:1234 or http://host.docker.internal:1234. Got ${shown}.`,
		});
	}
	if (/[?#]/.test(value)) {
		throw new NodeOperationError(node, 'Invalid BlueBubbles server URL', {
			description: `The Server URL in the BlueBubbles credential must not contain a query string or fragment (the password is sent separately). Got ${shown}.`,
		});
	}
	return value.replace(/\/+$/, '');
}

/**
 * Decode a binary response body (Buffer / ArrayBuffer / typed array) as UTF-8,
 * parsing it as JSON when possible. Anything else is returned unchanged.
 */
export function decodeBinaryBody(data: unknown): unknown {
	let bytes: Buffer | undefined;
	if (Buffer.isBuffer(data)) bytes = data;
	else if (data instanceof ArrayBuffer) bytes = Buffer.from(data);
	else if (ArrayBuffer.isView(data))
		bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	if (!bytes) return data;

	const text = bytes.toString('utf8');
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return text;
	}
}

/** Pull a readable error text out of a BlueBubbles response envelope. */
function envelopeMessage(rawData: unknown): string | undefined {
	const data = decodeBinaryBody(rawData);
	if (typeof data === 'string') {
		const text = data.trim();
		// Short plain-text bodies are useful; HTML pages from proxies are not.
		return text && text.length <= 200 && !text.startsWith('<') ? text : undefined;
	}
	if (!isRecord(data)) return undefined;

	const error = data.error;
	const errorMessage =
		isRecord(error) && typeof error.message === 'string'
			? error.message
			: typeof error === 'string'
				? error
				: undefined;
	const message = typeof data.message === 'string' ? data.message : undefined;

	if (errorMessage && message && errorMessage !== message) return `${errorMessage} (${message})`;
	return errorMessage ?? message;
}

function toStatus(value: unknown): number | undefined {
	const status = typeof value === 'string' ? Number(value) : value;
	return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
		? status
		: undefined;
}

/**
 * Inspect an error thrown by `httpRequestWithAuthentication`.
 *
 * Depending on the n8n version this is a `NodeApiError` wrapping an `AxiosError`,
 * a bare `AxiosError`, or a plain error; this walks `cause` / `reason` /
 * `errorResponse` to find the status, network code and server message.
 */
export function inspectRequestError(error: unknown): RequestFailure {
	const failure: RequestFailure = {};
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();

	while (queue.length > 0 && seen.size < 10) {
		const item = queue.shift();
		if (!isRecord(item) || seen.has(item)) continue;
		seen.add(item);

		const response = isRecord(item.response) ? item.response : undefined;
		failure.status ??=
			toStatus(item.httpCode) ?? toStatus(response?.status) ?? toStatus(item.statusCode);

		if (typeof item.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(item.code)) {
			failure.code ??= item.code;
		}

		const context = isRecord(item.context) ? item.context : undefined;
		failure.serverMessage ??= envelopeMessage(response?.data) ?? envelopeMessage(context?.data);

		if (typeof item.message === 'string' && item.message) {
			// Keep the innermost message: it is the most specific one.
			failure.rawMessage = item.message;
		}

		queue.push(item.cause, item.reason, item.errorResponse);
	}

	return failure;
}

/** A short reason for the error message, e.g. "HTTP 401" or "connection refused". */
function failureReason(failure: RequestFailure): string {
	if (failure.status !== undefined) return `HTTP ${failure.status}`;
	if (failure.code) return CONNECTION_ERROR_CODES[failure.code] ?? 'network error';
	if (failure.rawMessage && /timeout|timed out/i.test(failure.rawMessage)) return REQUEST_TIMED_OUT;
	return 'request failed';
}

/**
 * Whether an error thrown by the request helpers of this module (a sanitized
 * `NodeApiError` from {@link buildApiError}) is a client-side timeout, i.e. the
 * server did not answer in time.
 */
export function isTimeoutError(error: unknown): boolean {
	if (!(error instanceof NodeApiError) || error.httpCode) return false;
	return (
		error.message.endsWith(`(${REQUEST_TIMED_OUT})`) ||
		error.message.endsWith(`(${CONNECTION_TIMED_OUT})`)
	);
}

/** An actionable hint for the most common failures. */
function failureHint(
	failure: RequestFailure,
	displayUrl: string,
	hints: BlueBubblesErrorHints = {},
): string | undefined {
	const isNetworkError =
		failure.status === undefined &&
		((failure.code !== undefined && failure.code in CONNECTION_ERROR_CODES) ||
			/timeout|timed out|fetch failed|socket hang up/i.test(failure.rawMessage ?? ''));

	if (isNetworkError) {
		return `n8n could not reach ${displayUrl}. Check that BlueBubbles Server is running and that the host and port are correct. If n8n runs in Docker, "localhost" is the container itself: use the host's LAN IP or host.docker.internal (on Linux, add extra_hosts: "host.docker.internal:host-gateway" to the n8n container).`;
	}
	if (
		/Private API is not enabled/i.test(`${failure.serverMessage ?? ''} ${failure.rawMessage ?? ''}`)
	) {
		return PRIVATE_API_HINT;
	}
	if (failure.status !== undefined && hints[failure.status]) return hints[failure.status];
	switch (failure.status) {
		case 401:
		case 403:
			return 'Check the server password in the BlueBubbles credential; it must match the password set in the BlueBubbles Server app.';
		case 404:
			return 'Check the server URL (scheme, host, port and any reverse-proxy path; do not include /api/v1) and the BlueBubbles Server version: the webhook API requires BlueBubbles Server 1.9.9 or newer.';
		case 400:
			return 'BlueBubbles rejected the request. Check the selected events, and that the n8n webhook URL starts with http:// or https:// (set WEBHOOK_URL if n8n runs behind a proxy).';
		default:
			return failure.status !== undefined && failure.status >= 500
				? 'The BlueBubbles server failed to process the request; check the BlueBubbles Server logs.'
				: undefined;
	}
}

/**
 * Build a `NodeApiError` that explains a failed BlueBubbles request without
 * leaking the server password.
 *
 * The original error is deliberately NOT passed to `NodeApiError`: it carries the
 * request URL / axios config (including the `password` query parameter) and would
 * end up in the error's `cause`, `context` or `messages`.
 */
export function buildApiError(
	node: INode,
	error: unknown,
	details: {
		operation: string;
		method: string;
		endpoint: string;
		serverUrl: string;
		hints?: BlueBubblesErrorHints;
	},
	secrets: string[] = [],
): NodeApiError {
	const failure = inspectRequestError(error);
	const displayUrl = toDisplayUrl(details.serverUrl);
	const reason = failureReason(failure);

	const parts = [
		`${details.operation}.`,
		`Server URL: ${displayUrl}.`,
		`Request: ${details.method} /api/v1${details.endpoint}.`,
	];
	if (failure.status !== undefined) {
		parts.push(`HTTP status: ${failure.status}.`);
	} else if (failure.code) {
		parts.push(`Network error: ${failure.code}.`);
	}
	if (failure.serverMessage) {
		parts.push(`BlueBubbles error: ${failure.serverMessage}.`);
	} else if (failure.rawMessage) {
		parts.push(`Details: ${failure.rawMessage}.`);
	}
	const hint = failureHint(failure, displayUrl, details.hints);
	if (hint) parts.push(`Hint: ${hint}`);

	const message = redactSecrets(`${details.operation} (${reason})`, secrets);
	const description = redactSecrets(parts.join(' '), secrets);
	const httpCode = failure.status !== undefined ? String(failure.status) : undefined;

	return new NodeApiError(node, { message, description } as JsonObject, {
		message,
		description,
		httpCode,
	});
}

/** Minimal shape of the WHATWG `FormData` global (Node 18+), which has no lib typing here. */
interface MultipartFormData {
	append(name: string, value: string | Blob, fileName?: string): void;
}
declare const FormData: { new (): MultipartFormData };

/** Credential-derived values every request needs. */
interface RequestTarget {
	serverUrl: string;
	secrets: string[];
}

async function getRequestTarget(ctx: BlueBubblesContext): Promise<RequestTarget> {
	const credentials = await ctx.getCredentials('blueBubblesApi');
	const serverUrl = normalizeServerUrl(ctx.getNode(), credentials.serverUrl);
	const secrets = typeof credentials.password === 'string' ? [credentials.password] : [];
	return { serverUrl, secrets };
}

/**
 * Send one authenticated request and turn any thrown error into a sanitized
 * `NodeApiError` (see {@link buildApiError}).
 */
async function sendAuthenticated(
	ctx: BlueBubblesContext,
	target: RequestTarget,
	request: Omit<IHttpRequestOptions, 'url' | 'method'>,
	{ method, endpoint, operation, timeout, hints }: Omit<BlueBubblesRequestOptions, 'body' | 'qs'>,
): Promise<unknown> {
	const options: IHttpRequestOptions = {
		...request,
		method,
		url: `${target.serverUrl}/api/v1${endpoint}`,
	};
	options.timeout = timeout ?? DEFAULT_REQUEST_TIMEOUT_MS;

	const logMeta = {
		method,
		path: `/api/v1${endpoint}`,
		serverUrl: toDisplayUrl(target.serverUrl),
	};
	ctx.logger.debug('BlueBubbles API request', logMeta);

	try {
		return (await ctx.helpers.httpRequestWithAuthentication.call(
			ctx,
			'blueBubblesApi',
			options,
		)) as unknown;
	} catch (error) {
		const apiError = buildApiError(
			ctx.getNode(),
			error,
			{ operation, method, endpoint, serverUrl: target.serverUrl, hints },
			target.secrets,
		);
		ctx.logger.debug('BlueBubbles API request failed', {
			...logMeta,
			httpCode: apiError.httpCode ?? undefined,
			error: apiError.message,
		});
		throw apiError;
	}
}

/**
 * Throw when a response that arrived with a 2xx HTTP status carries an error
 * status in its BlueBubbles envelope (`{ status: 4xx|5xx, message, error }`);
 * otherwise return the envelope's `data`.
 */
function unwrapEnvelope(
	ctx: BlueBubblesContext,
	target: RequestTarget,
	rawBody: unknown,
	{ method, endpoint, operation, hints }: Omit<BlueBubblesRequestOptions, 'body' | 'qs'>,
): unknown {
	const body = typeof rawBody === 'string' ? decodeBinaryBody(Buffer.from(rawBody)) : rawBody;
	if (!isRecord(body)) return body;

	const status = toStatus(body.status);
	if (status !== undefined && status >= 400) {
		throw buildApiError(
			ctx.getNode(),
			{ httpCode: status, response: { status, data: body } },
			{ operation, method, endpoint, serverUrl: target.serverUrl, hints },
			target.secrets,
		);
	}
	return body.data;
}

/**
 * Perform an authenticated request against the BlueBubbles REST API and return
 * the raw response body (the whole `{ status, message, data }` envelope).
 *
 * The server password is injected as the `password` query-string parameter by
 * the `blueBubblesApi` credential, so request options and raw errors are never
 * logged or attached to thrown errors.
 *
 * @throws NodeOperationError when the credential's server URL is invalid
 * @throws NodeApiError (sanitized) when the request fails
 */
export async function blueBubblesApiRequest(
	this: BlueBubblesContext,
	options: BlueBubblesRequestOptions,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const { body = {}, qs = {} } = options;
	const target = await getRequestTarget(this);
	const request: Omit<IHttpRequestOptions, 'url' | 'method'> = { qs, json: true };
	if (Object.keys(body).length > 0) request.body = body;
	return await sendAuthenticated(this, target, request, options);
}

/**
 * Like {@link blueBubblesApiRequest}, but also treats an HTTP 200 whose envelope
 * has `status >= 400` as a failure, and returns the envelope's `data`.
 *
 * Use this for action operations.
 *
 * @throws NodeApiError (sanitized) when the request fails or the envelope reports an error
 */
export async function blueBubblesApiCall<T = unknown>(
	this: BlueBubblesContext,
	options: BlueBubblesRequestOptions,
): Promise<T> {
	const { body = {}, qs = {} } = options;
	const target = await getRequestTarget(this);
	const request: Omit<IHttpRequestOptions, 'url' | 'method'> = { qs, json: true };
	if (Object.keys(body).length > 0) request.body = body;
	const response = await sendAuthenticated(this, target, request, options);
	return unwrapEnvelope(this, target, response, options) as T;
}

/**
 * Download a binary resource (e.g. an attachment). Returns the raw bytes and the
 * response headers. A JSON error envelope (as Buffer) is decoded before the
 * error message is extracted and redacted.
 *
 * @throws NodeApiError (sanitized) when the request fails
 */
export async function blueBubblesBinaryRequest(
	this: BlueBubblesContext,
	options: Omit<BlueBubblesRequestOptions, 'body'>,
): Promise<BlueBubblesBinaryResponse> {
	const target = await getRequestTarget(this);
	const response = await sendAuthenticated(
		this,
		target,
		{ qs: options.qs ?? {}, encoding: 'arraybuffer', returnFullResponse: true },
		{ ...options, timeout: options.timeout ?? ATTACHMENT_REQUEST_TIMEOUT_MS },
	);

	const full = isRecord(response) ? response : {};
	const headers = isRecord(full.headers) ? (full.headers as IDataObject) : {};
	const rawBody = 'body' in full ? full.body : response;
	let buffer: Buffer;
	if (Buffer.isBuffer(rawBody)) buffer = rawBody;
	else if (rawBody instanceof ArrayBuffer) buffer = Buffer.from(rawBody);
	else if (ArrayBuffer.isView(rawBody))
		buffer = Buffer.from(rawBody.buffer, rawBody.byteOffset, rawBody.byteLength);
	else if (typeof rawBody === 'string') buffer = Buffer.from(rawBody);
	else buffer = Buffer.alloc(0);

	// A 200 that is really a JSON error envelope.
	const contentType = String(headers['content-type'] ?? '');
	if (/json/i.test(contentType)) {
		unwrapEnvelope(this, target, decodeBinaryBody(buffer), options);
	}
	return { buffer, headers };
}

/**
 * Send a `multipart/form-data` request built with the global `FormData` and
 * `Blob` (the HTTP client sets the Content-Type boundary). The password stays
 * in the query string via the credential. Returns the envelope's `data`.
 *
 * @throws NodeApiError (sanitized) when the request fails or the envelope reports an error
 */
export async function blueBubblesFormRequest<T = unknown>(
	this: BlueBubblesContext,
	options: BlueBubblesFormRequestOptions,
): Promise<T> {
	const form = new FormData();
	for (const [name, value] of Object.entries(options.fields ?? {})) {
		if (value !== undefined && value !== null) form.append(name, String(value));
	}
	for (const file of options.files ?? []) {
		const blob = new Blob([file.buffer], { type: file.mimeType ?? 'application/octet-stream' });
		form.append(file.fieldName, blob, file.fileName);
	}

	const target = await getRequestTarget(this);
	const response = await sendAuthenticated(
		this,
		target,
		{ qs: options.qs ?? {}, body: form as unknown as IHttpRequestOptions['body'] },
		{ ...options, timeout: options.timeout ?? ATTACHMENT_REQUEST_TIMEOUT_MS },
	);
	return unwrapEnvelope(this, target, response, options) as T;
}

// --------------------------------------------------------------------------
// GUID helpers
// --------------------------------------------------------------------------

const IMESSAGE_DM_PREFIX = 'iMessage;-;';

/**
 * Normalize a chat GUID for the API: a leading `iMessage;-;` becomes `any;-;`.
 * Nothing else changes (SMS `(smsft)` / `(smsfp)` suffixes are kept). Never use
 * this on message GUIDs.
 */
export function normalizeChatGuid(chatGuid: string): string {
	return chatGuid.startsWith(IMESSAGE_DM_PREFIX)
		? `any;-;${chatGuid.slice(IMESSAGE_DM_PREFIX.length)}`
		: chatGuid;
}

/** The DM chat GUID for a phone number or email address. */
export function addressToChatGuid(address: string): string {
	return `any;-;${address.trim()}`;
}

/** A fresh `tempGuid` for send routes. */
export function tempGuid(): string {
	return `temp-${randomUUID()}`;
}

// --------------------------------------------------------------------------
// Send method
// --------------------------------------------------------------------------

/** A new per-execution cache; create one at the start of `execute()`. */
export function createExecutionCache(): BlueBubblesExecutionCache {
	return {};
}

/**
 * `GET /server/info` (its `data`), fetched at most once per cache object.
 * A failed lookup is not cached.
 */
export async function getServerInfo(
	ctx: BlueBubblesContext,
	cache: BlueBubblesExecutionCache,
): Promise<IDataObject> {
	if (!cache.serverInfo) {
		const pending = blueBubblesApiCall
			.call(ctx, {
				method: 'GET',
				endpoint: '/server/info',
				operation: 'Could not read BlueBubbles server info',
			})
			.then((data) => (isRecord(data) ? (data as IDataObject) : {}));
		cache.serverInfo = pending;
		pending.catch(() => {
			if (cache.serverInfo === pending) cache.serverInfo = undefined;
		});
	}
	return await cache.serverInfo;
}

/**
 * Decide the `method` for send routes. An explicit override wins; `auto` uses
 * `private-api` only when the server reports `private_api` enabled and the
 * helper connected (a missing `helper_connected` counts as connected).
 */
export async function resolveSendMethod(
	ctx: BlueBubblesContext,
	override: SendMethodOverride,
	cache: BlueBubblesExecutionCache,
): Promise<SendMethod> {
	if (override !== 'auto') return override;
	const info = await getServerInfo(ctx, cache);
	const helperConnected = info.helper_connected !== false && info.helper_connected !== 0;
	return info.private_api && helperConnected ? 'private-api' : 'apple-script';
}

// --------------------------------------------------------------------------
// Output shaping
// --------------------------------------------------------------------------

const SIMPLE_MESSAGE_FIELDS = [
	'guid',
	'text',
	'handle',
	'isFromMe',
	'dateCreated',
	'attachments',
	'replyToGuid',
	'associatedMessageGuid',
	'associatedMessageType',
	'dateEdited',
	'dateRetracted',
	'isAudioMessage',
	'error',
	'chats',
] as const;

function pick(source: Record<string, unknown>, keys: readonly string[]): IDataObject {
	const out: IDataObject = {};
	for (const key of keys) {
		if (key in source) out[key] = source[key] as IDataObject[string];
	}
	return out;
}

/**
 * Project a BlueBubbles message onto the fields workflows usually need:
 * handle reduced to `{ address, service }`, chats to `{ guid, displayName, isArchived }`.
 * Fields absent from the input are omitted.
 */
export function simplifyMessage(message: IDataObject): IDataObject {
	const out = pick(message, SIMPLE_MESSAGE_FIELDS);
	if (isRecord(out.handle)) out.handle = pick(out.handle, ['address', 'service']);
	if (Array.isArray(out.chats)) {
		out.chats = out.chats.map((chat) =>
			isRecord(chat) ? pick(chat, ['guid', 'displayName', 'isArchived']) : chat,
		) as IDataObject[];
	}
	return out;
}
