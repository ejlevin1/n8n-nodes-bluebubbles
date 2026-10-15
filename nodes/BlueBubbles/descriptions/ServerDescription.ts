import type { INodeProperties } from 'n8n-workflow';

export const serverOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['server'] } },
		options: [
			{
				name: 'Get Info',
				value: 'getInfo',
				description: 'Get the server version, macOS version and Private API status',
				action: 'Get server info',
			},
			{
				name: 'Get My Addresses',
				value: 'getMyAddresses',
				description:
					'Get the phone numbers and emails of the Apple account signed in on the Mac, primary first. Uses the iCloud account when the Private API is enabled.',
				action: 'Get my addresses',
			},
			{
				name: 'Ping',
				value: 'ping',
				description: 'Check that the BlueBubbles server is reachable',
				action: 'Ping the server',
			},
		],
		default: 'ping',
	},
];

/** Server operations take no parameters. */
export const serverFields: INodeProperties[] = [];
