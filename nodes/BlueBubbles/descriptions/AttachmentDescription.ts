import type { INodeProperties } from 'n8n-workflow';

import { chatLocator, sendMethodOption } from './shared';

function show(operation: string[]): INodeProperties['displayOptions'] {
	return { show: { resource: ['attachment'], operation } };
}

export const attachmentOperations: INodeProperties[] = [
	{
		displayName: 'Operation',
		name: 'operation',
		type: 'options',
		noDataExpression: true,
		displayOptions: { show: { resource: ['attachment'] } },
		options: [
			{
				name: 'Download',
				value: 'download',
				description: 'Download an attachment’s file into a binary field',
				action: 'Download an attachment',
			},
			{
				name: 'Get',
				value: 'get',
				description: 'Get an attachment’s metadata (file name, MIME type, size)',
				action: 'Get an attachment',
			},
			{
				name: 'Send',
				value: 'send',
				description: 'Send a file from a binary field to a chat',
				action: 'Send an attachment',
			},
		],
		default: 'download',
	},
];

export const attachmentFields: INodeProperties[] = [
	{
		displayName: 'Attachment GUID',
		name: 'attachmentGuid',
		type: 'string',
		required: true,
		default: '',
		placeholder: 'e.g. 9A1B2C3D-4E5F-6789-ABCD-EF0123456789',
		description: 'The GUID of the attachment (found in a message’s attachments)',
		displayOptions: show(['get', 'download']),
	},
	{
		displayName: 'Put Output File in Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		hint: 'The name of the output binary field to put the file in',
		displayOptions: show(['download']),
	},

	// ------------------------------------------------------------------
	// Send
	// ------------------------------------------------------------------
	chatLocator(show(['send'])),
	{
		displayName: 'Input Binary Field',
		name: 'binaryPropertyName',
		type: 'string',
		required: true,
		default: 'data',
		hint: 'The name of the input binary field containing the file to send',
		displayOptions: show(['send']),
	},
	{
		displayName: 'Options',
		name: 'options',
		type: 'collection',
		placeholder: 'Add Option',
		default: {},
		displayOptions: show(['send']),
		options: [
			{
				displayName: 'File Name',
				name: 'fileName',
				type: 'string',
				default: '',
				placeholder: 'e.g. photo.jpg',
				description: 'File name to send instead of the binary data’s own file name',
			},
			sendMethodOption,
		],
	},
];
