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

export type BlueBubblesContext =
	IHookFunctions | IWebhookFunctions | IExecuteFunctions | ILoadOptionsFunctions;

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

/** Network error codes that mean "n8n could not reach the server". */
const CONNECTION_ERROR_CODES: Record<string, string> = {
	ECONNREFUSED: 'connection refused',
	ENOTFOUND: 'host not found',
	EAI_AGAIN: 'DNS lookup failed',
	ETIMEDOUT: 'connection timed out',
	ECONNABORTED: 'request timed out',
	ESOCKETTIMEDOUT: 'request timed out',
	EHOSTUNREACH: 'host unreachable',
	ENETUNREACH: 'network unreachable',
	ECONNRESET: 'connection reset',
	EPIPE: 'connection closed',
	UND_ERR_CONNECT_TIMEOUT: 'connection timed out',
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

/** Pull a readable error text out of a BlueBubbles response envelope. */
function envelopeMessage(data: unknown): string | undefined {
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
	if (failure.rawMessage && /timeout|timed out/i.test(failure.rawMessage))
		return 'request timed out';
	return 'request failed';
}

/** An actionable hint for the most common failures. */
function failureHint(failure: RequestFailure, displayUrl: string): string | undefined {
	const isNetworkError =
		failure.status === undefined &&
		((failure.code !== undefined && failure.code in CONNECTION_ERROR_CODES) ||
			/timeout|timed out|fetch failed|socket hang up/i.test(failure.rawMessage ?? ''));

	if (isNetworkError) {
		return `n8n could not reach ${displayUrl}. Check that BlueBubbles Server is running and that the host and port are correct. If n8n runs in Docker, "localhost" is the container itself: use the host's LAN IP or host.docker.internal (on Linux, add extra_hosts: "host.docker.internal:host-gateway" to the n8n container).`;
	}
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
	details: { operation: string; method: string; endpoint: string; serverUrl: string },
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
	const hint = failureHint(failure, displayUrl);
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

/**
 * Perform an authenticated request against the BlueBubbles REST API.
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
	{ method, endpoint, body = {}, qs = {}, operation }: BlueBubblesRequestOptions,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const credentials = await this.getCredentials('blueBubblesApi');
	const serverUrl = normalizeServerUrl(this.getNode(), credentials.serverUrl);
	const secrets = typeof credentials.password === 'string' ? [credentials.password] : [];

	const options: IHttpRequestOptions = {
		method,
		url: `${serverUrl}/api/v1${endpoint}`,
		qs,
		json: true,
	};
	if (Object.keys(body).length > 0) {
		options.body = body;
	}

	const logMeta = { method, path: `/api/v1${endpoint}`, serverUrl: toDisplayUrl(serverUrl) };
	this.logger.debug('BlueBubbles API request', logMeta);

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'blueBubblesApi', options);
	} catch (error) {
		const apiError = buildApiError(
			this.getNode(),
			error,
			{ operation, method, endpoint, serverUrl },
			secrets,
		);
		this.logger.debug('BlueBubbles API request failed', {
			...logMeta,
			httpCode: apiError.httpCode ?? undefined,
			error: apiError.message,
		});
		throw apiError;
	}
}
