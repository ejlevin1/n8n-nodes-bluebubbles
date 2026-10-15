import type { INodeProperties } from 'n8n-workflow';

import { returnAllLimit } from './shared';

function showFor(operation: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: ['contact'], operation } };
}

export const contactOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['contact'] } },
		options: [
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get contacts from the address book of the Mac running BlueBubbles',
				action: 'Get many contacts',
			},
			{
				name: 'Lookup by Address',
				value: 'lookupByAddress',
				description: 'Find the contacts that own the given phone numbers or emails',
				action: 'Look up contacts by address',
			},
		],
		default: 'getMany',
	},
];

export const contactFields: INodeProperties[] = [
	// ----------------------------------------------------------------------
	// Get Many
	// ----------------------------------------------------------------------
	...returnAllLimit(showFor(['getMany'])),
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['getMany']),
		options: [
			{
				displayName: 'Search',
				name: 'search',
				type: 'string',
				default: '',
				placeholder: 'e.g. jane or 555123',
				description:
					'Only return contacts whose name, phone number or email contains this text (case-insensitive)',
			},
		],
	},

	// ----------------------------------------------------------------------
	// Lookup by Address
	// ----------------------------------------------------------------------
	{
		displayName: 'Addresses',
		name: 'addresses',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +15551234567, name@example.com',
		description:
			'Phone numbers or emails to look up, separated by commas. Addresses without a matching contact are left out of the output.',
		displayOptions: showFor(['lookupByAddress']),
	},
];
