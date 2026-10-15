import type { INodeProperties } from 'n8n-workflow';

export const handleOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['handle'] } },
		options: [
			{
				name: 'Check FaceTime Availability (Private API)',
				value: 'checkFaceTime',
				description:
					'Check whether a phone number or email is registered for FaceTime. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				// eslint-disable-next-line n8n-nodes-base/node-param-operation-option-action-miscased -- "FaceTime" is a brand name
				action: 'Check FaceTime availability',
			},
			{
				name: 'Check iMessage Availability (Private API)',
				value: 'checkIMessage',
				description:
					'Check whether a phone number or email can receive iMessage (blue bubble) rather than only SMS. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				// eslint-disable-next-line n8n-nodes-base/node-param-operation-option-action-miscased -- "iMessage" is a brand name
				action: 'Check iMessage availability',
			},
		],
		default: 'checkIMessage',
	},
];

export const handleFields: INodeProperties[] = [
	{
		displayName: 'Address',
		name: 'address',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +15551234567 or name@example.com',
		description: 'Phone number or email to check',
		displayOptions: {
			show: { resource: ['handle'], operation: ['checkIMessage', 'checkFaceTime'] },
		},
	},
];
