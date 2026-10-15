import type { INodeProperties } from 'n8n-workflow';

import { chatLocator, returnAllLimit, sendMethodOption } from './shared';

function show(operation: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: ['scheduledMessage'], operation } };
}

export const scheduledMessageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['scheduledMessage'] } },
		options: [
			{
				name: 'Create',
				value: 'create',
				description: 'Schedule a text message to be sent once at a future time',
				action: 'Create a scheduled message',
			},
			{
				name: 'Delete',
				value: 'delete',
				description: 'Cancel and delete a scheduled message',
				action: 'Delete a scheduled message',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description:
					'Get many scheduled messages, including ones already sent or failed (see each record’s status)',
				action: 'Get many scheduled messages',
			},
		],
		default: 'create',
	},
];

export const scheduledMessageFields: INodeProperties[] = [
	// ------------------------------------------------------------------
	// Create
	// ------------------------------------------------------------------
	{
		displayName:
			'Scheduling is not delivery. The send method is fixed now: a message scheduled with the Private API fails (no fallback, no retry) if the helper is disconnected when it fires. Check Get Many for status "error" afterwards.',
		name: 'scheduleNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['create']),
	},
	chatLocator(show(['create'])),
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 3 },
		description: 'The message text',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Send At',
		name: 'scheduledFor',
		type: 'dateTime',
		required: true,
		default: '',
		description:
			'When to send the message. Times without a timezone use the workflow timezone; epoch milliseconds also work.',
		displayOptions: show(['create']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['create']),
		options: [sendMethodOption],
	},

	// ------------------------------------------------------------------
	// Get Many
	// ------------------------------------------------------------------
	{
		displayName:
			'Each record has a status: "pending" (queued), "in-progress" (sending), "complete" (sent) or "error" (the send failed; the reason is in the error field).',
		name: 'scheduledStatusNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['getMany']),
	},
	...returnAllLimit(show(['getMany'])),

	// ------------------------------------------------------------------
	// Delete
	// ------------------------------------------------------------------
	{
		displayName: 'This cancels the scheduled message permanently and cannot be undone.',
		name: 'deleteScheduledNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['delete']),
	},
	{
		displayName: 'Scheduled Message ID',
		name: 'scheduledMessageId',
		type: 'number',
		required: true,
		default: 0,
		typeOptions: { minValue: 1, numberPrecision: 0 },
		description: 'The numeric ID of the scheduled message (from Get Many or Create)',
		displayOptions: show(['delete']),
	},
];
