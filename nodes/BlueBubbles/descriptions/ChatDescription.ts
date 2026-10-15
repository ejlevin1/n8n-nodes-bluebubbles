import type { INodeProperties } from 'n8n-workflow';

import { chatLocator, returnAllLimit, sendMethodOption, simplifyField } from './shared';

/** 'displayOptions' for chat fields shown on the given operations. */
function showFor(operation: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: ['chat'], operation } };
}

export const chatOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['chat'] } },
		options: [
			{
				name: 'Add Participant (Private API)',
				value: 'addParticipant',
				description:
					'Add a phone number or email to a group chat. The group sees the change. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Add a participant to a group chat',
			},
			{
				name: 'Create (Private API)',
				value: 'create',
				description:
					'Start a new chat with one or more addresses by sending a first message. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Create a chat',
			},
			{
				name: 'Delete (Private API)',
				value: 'delete',
				description:
					'Permanently delete a chat and all of its messages from the Mac. This cannot be undone. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Delete a chat',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a chat with its participants and last message',
				action: 'Get a chat',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get many chats, most recently active first',
				action: 'Get many chats',
			},
			{
				name: 'Leave (Private API)',
				value: 'leave',
				description:
					'Leave a group chat. You stop receiving its messages and cannot rejoin on your own. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Leave a group chat',
			},
			{
				name: 'Mark as Read (Private API)',
				value: 'markRead',
				description:
					'Mark a chat as read. The other person can see a read receipt. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Mark a chat as read',
			},
			{
				name: 'Mark as Unread (Private API)',
				value: 'markUnread',
				description:
					'Mark a chat as unread (macOS 13 or newer). Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Mark a chat as unread',
			},
			{
				name: 'Remove Participant (Private API)',
				value: 'removeParticipant',
				description:
					'Remove a phone number or email from a group chat. The group sees the change. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Remove a participant from a group chat',
			},
			{
				name: 'Rename Group (Private API)',
				value: 'rename',
				description:
					'Set the display name of a group chat. The group sees the new name. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Rename a group chat',
			},
			{
				name: 'Start Typing (Private API)',
				value: 'startTyping',
				description:
					'Show the typing indicator in a chat. The other person sees it. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Start the typing indicator in a chat',
			},
			{
				name: 'Stop Typing (Private API)',
				value: 'stopTyping',
				description:
					'Hide the typing indicator in a chat. Requires the Private API (SIP disabled on the Mac and the BlueBubbles helper connected).',
				action: 'Stop the typing indicator in a chat',
			},
		],
		default: 'getMany',
	},
];

export const chatFields: INodeProperties[] = [
	// ----------------------------------------------------------------------
	// Operations that target one existing chat
	// ----------------------------------------------------------------------
	chatLocator(
		showFor([
			'get',
			'markRead',
			'markUnread',
			'startTyping',
			'stopTyping',
			'rename',
			'addParticipant',
			'removeParticipant',
			'leave',
			'delete',
		]),
	),

	// ----------------------------------------------------------------------
	// Notices for visible / destructive operations
	// ----------------------------------------------------------------------
	{
		displayName:
			'The other participants see this action (read receipt or typing indicator) on their devices',
		name: 'visibleNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['markRead', 'startTyping', 'stopTyping']),
	},
	{
		displayName:
			'Deleting a chat permanently removes it and all of its messages from the Mac. This cannot be undone.',
		name: 'deleteNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['delete']),
	},
	{
		displayName: 'Leaving a group chat cannot be undone from n8n; another member must add you back',
		name: 'leaveNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['leave']),
	},
	{
		displayName:
			"The removed person stops receiving the group's messages, and the group sees the change",
		name: 'removeParticipantNotice',
		type: 'notice',
		default: '',
		displayOptions: showFor(['removeParticipant']),
	},

	// ----------------------------------------------------------------------
	// Rename
	// ----------------------------------------------------------------------
	{
		displayName: 'New Name',
		name: 'displayName',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. Weekend Plans',
		description: 'The new display name for the group chat',
		displayOptions: showFor(['rename']),
	},

	// ----------------------------------------------------------------------
	// Add / remove participant
	// ----------------------------------------------------------------------
	{
		displayName: 'Address',
		name: 'address',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +15551234567 or name@example.com',
		description: 'Phone number or email of the participant',
		displayOptions: showFor(['addParticipant', 'removeParticipant']),
	},

	// ----------------------------------------------------------------------
	// Create
	// ----------------------------------------------------------------------
	{
		displayName: 'Addresses',
		name: 'addresses',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +15551234567, name@example.com',
		description:
			'Phone numbers or emails to start the chat with, separated by commas. More than one creates a group chat.',
		displayOptions: showFor(['create']),
	},
	{
		displayName: 'Message',
		name: 'message',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 3 },
		description: 'The first message to send; BlueBubbles needs one to create the chat',
		displayOptions: showFor(['create']),
	},
	{
		displayName: 'Service',
		name: 'service',
		type: 'options',
		default: 'iMessage',
		options: [
			{ name: 'iMessage', value: 'iMessage' },
			{ name: 'SMS', value: 'SMS' },
		],
		description: 'Whether to create an iMessage or an SMS chat',
		displayOptions: showFor(['create']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['create']),
		options: [sendMethodOption],
	},

	// ----------------------------------------------------------------------
	// Get Many
	// ----------------------------------------------------------------------
	...returnAllLimit(showFor(['getMany'])),
	{
		...simplifyField(showFor(['getMany'])),
		description:
			'Whether to return a simplified version of each recent message (see Include Recent Messages) instead of the raw data',
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: showFor(['getMany']),
		options: [
			{
				displayName: 'Include Recent Messages',
				name: 'recentMessages',
				type: 'number',
				default: 0,
				typeOptions: { minValue: 0, maxValue: 1000 },
				description:
					'How many of the newest messages to add to each chat as "recentMessages" (one extra request per chat). 0 adds none.',
			},
			{
				displayName: 'Unread Only',
				name: 'unreadOnly',
				type: 'boolean',
				default: false,
				description:
					"Whether to return only chats with unread messages. This is the read flag of the Mac's user, not of this workflow. The limit applies after filtering.",
			},
		],
	},
];
