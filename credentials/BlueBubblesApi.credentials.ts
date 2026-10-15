import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/**
 * Credentials for a self-hosted BlueBubbles server.
 *
 * BlueBubbles authenticates every REST call with a query-string parameter
 * (`guid`, `password` or `token`; see the server's authMiddleware), so the
 * generic authenticator injects `password` into `qs`. Because the secret is in
 * the URL, request URLs and raw HTTP errors must never be logged or surfaced.
 */
export class BlueBubblesApi implements ICredentialType {
	name = 'blueBubblesApi';

	displayName = 'BlueBubbles API';

	icon: Icon = {
		light: 'file:../nodes/BlueBubbles/bluebubbles.svg',
		dark: 'file:../nodes/BlueBubbles/bluebubbles.dark.svg',
	};

	documentationUrl = 'https://docs.bluebubbles.app/server/developer-guides/rest-api-and-webhooks';

	properties: INodeProperties[] = [
		{
			displayName: 'Server URL',
			name: 'serverUrl',
			type: 'string',
			default: '',
			required: true,
			placeholder: 'https://my-mac.example.com',
			description:
				"Full base URL of your BlueBubbles server, including the scheme (http:// or https://) and port, e.g. http://192.168.1.10:1234. Do not include /api/v1. If n8n runs in Docker, use the Mac's LAN IP or http://host.docker.internal:1234 instead of localhost.",
		},
		{
			displayName: 'Password',
			name: 'password',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
			description: 'The server password configured in the BlueBubbles server settings',
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			qs: {
				password: '={{$credentials.password}}',
			},
		},
	};

	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.serverUrl.replace(/\\/+$/, "")}}',
			url: '/api/v1/ping',
			method: 'GET',
		},
	};
}
