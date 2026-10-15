import type { INodeProperties } from 'n8n-workflow';

import { chatLocator, returnAllLimit, sendMethodOption, simplifyField } from './shared';

const PRIVATE_API =
	'Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).';

function show(operation: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: ['message'], operation } };
}

export const messageOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['message'] } },
		options: [
			{
				name: 'Edit (Private API)',
				value: 'edit',
				description:
					'Edit a message you sent; recipients see the edit. Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).',
				action: 'Edit a message',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get a message by its GUID',
				action: 'Get a message',
			},
			{
				name: 'Get Many',
				value: 'getMany',
				description: 'Get many messages in a chat',
				action: 'Get many messages',
			},
			{
				name: 'React (Private API)',
				value: 'react',
				description:
					'Add or remove a tapback reaction; the other participants see it. Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).',
				action: 'React to a message',
			},
			{
				name: 'Search',
				value: 'search',
				description: 'Search messages by text, chat, sender or date',
				action: 'Search messages',
			},
			{
				name: 'Send',
				value: 'send',
				description: 'Send a text message to an existing chat',
				action: 'Send a message',
			},
			{
				name: 'Send to Address',
				value: 'sendToAddress',
				description: 'Send a text message to a phone number or email address',
				action: 'Send a message to an address',
			},
			{
				name: 'Unsend (Private API)',
				value: 'unsend',
				description:
					'Retract a message you sent, for every participant. Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).',
				action: 'Unsend a message',
			},
		],
		default: 'send',
	},
];

/** Optional send settings shared by Send and Send to Address. */
function sendOptions(operation: string[], extra: INodeProperties[] = []): INodeProperties {
	return {
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(operation),
		options: [
			{
				// UNVERIFIED in the reference implementation; test manually.
				displayName: 'Effect ID (Private API)',
				name: 'effectId',
				type: 'string',
				default: '',
				placeholder: 'e.g. com.apple.MobileSMS.expressivesend.impact',
				description:
					'Identifier of the iMessage bubble or screen effect. Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).',
			},
			...extra,
			sendMethodOption,
			{
				// UNVERIFIED in the reference implementation; test manually.
				displayName: 'Subject (Private API)',
				name: 'subject',
				type: 'string',
				default: '',
				description:
					'Subject line shown in bold above the message. Requires the BlueBubbles Private API (SIP disabled on the Mac and the Private API helper connected).',
			},
		],
	};
}

const partIndexOption: INodeProperties = {
	displayName: 'Part Index',
	name: 'partIndex',
	type: 'number',
	default: 0,
	typeOptions: { minValue: 0 },
	description:
		'Which part of a multi-part message to target (0 is the first part, which is right for plain text messages)',
};

const dateFilters: INodeProperties[] = [
	{
		displayName: 'Created After',
		name: 'after',
		type: 'dateTime',
		default: '',
		description: 'Only return messages created after this time',
	},
	{
		displayName: 'Created Before',
		name: 'before',
		type: 'dateTime',
		default: '',
		description: 'Only return messages created before this time',
	},
];

export const messageFields: INodeProperties[] = [
	// ------------------------------------------------------------------
	// Shared: chat and message GUID
	// ------------------------------------------------------------------
	chatLocator(show(['send', 'getMany', 'react'])),
	chatLocator(show(['search']), {
		required: false,
		description: 'Only search this chat. Leave empty to search every chat.',
	}),
	{
		displayName: 'Address',
		name: 'address',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. +15551234567 or name@example.com',
		description: 'Phone number (E.164) or email address to send to',
		displayOptions: show(['sendToAddress']),
	},
	{
		displayName: 'Service',
		name: 'service',
		type: 'options',
		default: 'iMessage',
		options: [
			{
				name: 'iMessage',
				value: 'iMessage',
				description:
					'Let the server pick the service for the one-to-one chat; returns the sent message',
			},
			{
				name: 'SMS',
				value: 'SMS',
				description: `Force SMS via a new chat. ${PRIVATE_API} Returns the chat (its GUID, text is empty), not the message.`,
			},
		],
		displayOptions: show(['sendToAddress']),
	},
	{
		displayName: 'Message GUID',
		name: 'messageGuid',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 5F0C3E2A-1B2C-4D5E-8F90-1234567890AB',
		description: 'The GUID of the message',
		displayOptions: show(['get', 'react', 'edit', 'unsend']),
	},

	// ------------------------------------------------------------------
	// Send / Send to Address
	// ------------------------------------------------------------------
	{
		displayName: 'Text',
		name: 'text',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 3 },
		description: 'The message text',
		displayOptions: show(['send', 'sendToAddress']),
	},
	sendOptions(
		['send'],
		[
			{
				displayName: 'Reply to Message GUID (Private API)',
				name: 'replyToMessageGuid',
				type: 'string',
				default: '',
				description: `Send the text as a threaded reply to this message. ${PRIVATE_API} Fails when the send method resolves to AppleScript.`,
			},
		],
	),
	sendOptions(['sendToAddress']),

	// ------------------------------------------------------------------
	// React
	// ------------------------------------------------------------------
	{
		displayName:
			'The other participants see this reaction. Reactions only work in iMessage chats, not SMS.',
		name: 'reactNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['react']),
	},
	{
		displayName: 'Reaction',
		name: 'reaction',
		type: 'options',
		default: 'love',
		options: [
			{ name: 'Dislike', value: 'dislike' },
			{ name: 'Emphasize', value: 'emphasize' },
			{ name: 'Laugh', value: 'laugh' },
			{ name: 'Like', value: 'like' },
			{ name: 'Love', value: 'love' },
			{ name: 'Question', value: 'question' },
		],
		description: 'The tapback to add or remove',
		displayOptions: show(['react']),
	},
	{
		displayName: 'Remove Reaction',
		name: 'remove',
		type: 'boolean',
		default: false,
		description: 'Whether to remove this reaction instead of adding it',
		displayOptions: show(['react']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['react', 'unsend']),
		options: [partIndexOption],
	},

	// ------------------------------------------------------------------
	// Edit
	// ------------------------------------------------------------------
	{
		displayName:
			'Recipients see that the message was edited. Only iMessages you sent can be edited, and only for a short time after sending.',
		name: 'editNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['edit']),
	},
	{
		displayName: 'New Text',
		name: 'newText',
		type: 'string',
		required: true,
		default: '',
		typeOptions: { rows: 3 },
		description: 'The replacement text',
		displayOptions: show(['edit']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['edit']),
		options: [
			{
				displayName: 'Fallback Text',
				name: 'backwardsCompatibilityMessage',
				type: 'string',
				default: '',
				description:
					'Text shown on devices that cannot display edits. Defaults to "Edited to: &lt;new text&gt;".',
			},
			partIndexOption,
		],
	},

	// ------------------------------------------------------------------
	// Unsend
	// ------------------------------------------------------------------
	{
		displayName:
			'This retracts the message for every participant and cannot be undone. Only iMessages you sent recently can be unsent.',
		name: 'unsendNotice',
		type: 'notice',
		default: '',
		displayOptions: show(['unsend']),
	},

	// ------------------------------------------------------------------
	// Get Many / Search
	// ------------------------------------------------------------------
	{
		displayName: 'Search Text',
		name: 'query',
		type: 'string',
		default: '',
		placeholder: 'e.g. dinner',
		description:
			'Text to look for in message bodies (case-insensitive substring). Leave empty to match every message. See Search Method for how the text is matched.',
		displayOptions: show(['search']),
	},
	{
		displayName: 'Search Method',
		name: 'searchMethod',
		type: 'options',
		default: 'auto',
		description:
			'How Search Text is matched. Spotlight finds every message but needs the Private API helper on macOS 13+ and Spotlight indexing enabled on the Mac; otherwise it hangs until the server times out (about 2 minutes). Database is a plain SQL search that always answers quickly but misses sent messages whose text is stored only in rich-text form (attributedBody) on macOS 13+. If Spotlight indexing is disabled on the Mac, choose Database. Ignored when Search Text is empty.',
		options: [
			{
				name: 'Auto',
				value: 'auto',
				description:
					'Try Spotlight for up to 10 seconds, then fall back to the database search on a timeout or server error (the results then carry a note, and later items of the same run skip Spotlight)',
			},
			{
				name: 'Database',
				value: 'database',
				description:
					'Plain SQL text search; fast, but misses sent messages stored only in rich-text form on macOS 13+. Use this when Spotlight indexing is disabled on the Mac.',
			},
			{
				name: 'Spotlight',
				value: 'spotlight',
				description:
					'Let the server search through Spotlight (Private API on macOS 13+); fails after about 2 minutes if Spotlight indexing is disabled or the helper does not answer',
			},
		],
		displayOptions: show(['search']),
	},
	...returnAllLimit(show(['getMany', 'search'])),
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show(['getMany']),
		options: [
			...dateFilters,
			{
				displayName: 'From Address',
				name: 'fromAddress',
				type: 'string',
				default: '',
				placeholder: 'e.g. +15551234567 or me',
				description:
					'Only return messages from this phone number or email (the other party), or "me" for messages you sent. Applied after each page is fetched, so fewer results than the limit may come back.',
			},
			{
				displayName: 'Sort',
				name: 'sort',
				type: 'options',
				default: 'DESC',
				options: [
					{ name: 'Newest First', value: 'DESC' },
					{ name: 'Oldest First', value: 'ASC' },
				],
			},
		],
	},
	{
		displayName: 'Filters',
		name: 'filters',
		type: 'collection',
		placeholder: 'Add Filter',
		default: {},
		displayOptions: show(['search']),
		options: [
			...dateFilters,
			{
				displayName: 'From Address',
				name: 'fromAddress',
				type: 'string',
				default: '',
				placeholder: 'e.g. +15551234567 or me',
				description:
					'Only return messages whose other party is this phone number or email, or "me" for messages you sent',
			},
		],
	},
	simplifyField(show(['get', 'getMany', 'search'])),
];
