import type { INodeProperties } from 'n8n-workflow';

type DisplayOptions = INodeProperties['displayOptions'];

/** Chat picker shared by every operation that targets one chat. */
export function chatLocator(
	displayOptions: DisplayOptions,
	overrides: Partial<INodeProperties> = {},
): INodeProperties {
	return {
		displayName: 'Chat',
		name: 'chat',
		type: 'resourceLocator',
		default: { mode: 'list', value: '' },
		required: true,
		description: 'The chat to use',
		modes: [
			{
				displayName: 'From List',
				name: 'list',
				type: 'list',
				typeOptions: { searchListMethod: 'searchChats', searchable: true },
			},
			{
				displayName: 'By GUID',
				name: 'guid',
				type: 'string',
				placeholder: 'e.g. any;-;+15551234567 or iMessage;+;chat123456',
			},
			{
				displayName: 'By Address',
				name: 'address',
				type: 'string',
				placeholder: 'e.g. +15551234567 or name@example.com',
				hint: 'Targets the one-to-one chat with this phone number or email',
			},
		],
		displayOptions,
		...overrides,
	};
}

/** Send Method / Subject / Effect ID options for text sends. */
export const sendMethodOption: INodeProperties = {
	displayName: 'Send Method',
	name: 'method',
	type: 'options',
	default: 'auto',
	options: [
		{
			name: 'Auto',
			value: 'auto',
			description:
				'Use the Private API when it is enabled and its helper is connected, otherwise AppleScript',
		},
		{ name: 'Private API', value: 'private-api' },
		{ name: 'AppleScript', value: 'apple-script' },
	],
};

export function simplifyField(displayOptions: DisplayOptions): INodeProperties {
	return {
		displayName: 'Simplify',
		name: 'simplify',
		type: 'boolean',
		default: true,
		description: 'Whether to return a simplified version of each message instead of the raw data',
		displayOptions,
	};
}

/** Return All + Limit pair. Limit max is the server page cap (1000). */
export function returnAllLimit(displayOptions: DisplayOptions): INodeProperties[] {
	return [
		{
			displayName: 'Return All',
			name: 'returnAll',
			type: 'boolean',
			default: false,
			description: 'Whether to return all results or only up to a given limit',
			displayOptions,
		},
		{
			displayName: 'Limit',
			name: 'limit',
			type: 'number',
			default: 50,
			typeOptions: { minValue: 1 },
			description: 'Max number of results to return',
			displayOptions: {
				...displayOptions,
				show: { ...(displayOptions?.show ?? {}), returnAll: [false] },
			},
		},
	];
}
