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
 * BlueBubbles authenticates every REST call with a `password` query-string
 * parameter, so the generic authenticator injects it into `qs`.
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
				'Full base URL of your BlueBubbles server, including the scheme (http:// or https://). Do not include /api/v1.',
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
