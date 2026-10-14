import type {
	IDataObject,
	IExecuteFunctions,
	IHookFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	IWebhookFunctions,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';

/**
 * Perform an authenticated request against the BlueBubbles REST API.
 *
 * The server password is injected as a query-string parameter by the
 * `blueBubblesApi` credential, so request options must never be logged.
 *
 * @param method - HTTP method
 * @param endpoint - Path relative to `/api/v1`, starting with `/` (e.g. `/webhook`)
 * @param body - Optional JSON body; omitted when empty
 * @param qs - Optional query-string parameters
 */
export async function blueBubblesApiRequest(
	this: IHookFunctions | IWebhookFunctions | IExecuteFunctions | ILoadOptionsFunctions,
	method: IHttpRequestMethods,
	endpoint: string,
	body: IDataObject = {},
	qs: IDataObject = {},
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<any> {
	const credentials = await this.getCredentials('blueBubblesApi');
	// Keep the scheme and any reverse-proxy path prefix intact; only trim trailing slashes.
	const baseUrl = String(credentials.serverUrl).trim().replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}/api/v1${endpoint}`,
		qs,
		json: true,
	};

	if (Object.keys(body).length > 0) {
		options.body = body;
	}

	try {
		return await this.helpers.httpRequestWithAuthentication.call(this, 'blueBubblesApi', options);
	} catch (error) {
		throw new NodeApiError(this.getNode(), error as JsonObject);
	}
}
