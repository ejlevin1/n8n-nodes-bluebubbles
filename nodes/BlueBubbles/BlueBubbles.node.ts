import type {
	IExecuteFunctions,
	INodeExecutionData,
	INodeType,
	INodeTypeDescription,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { execute as attachmentExecute } from './actions/attachment';
import { execute as chatExecute } from './actions/chat';
import { execute as contactExecute } from './actions/contact';
import { execute as handleExecute } from './actions/handle';
import { execute as messageExecute } from './actions/message';
import { execute as scheduledMessageExecute } from './actions/scheduledMessage';
import { execute as serverExecute } from './actions/server';
import type { ResourceExecutor } from './actions/shared';
import { attachmentFields, attachmentOperations } from './descriptions/AttachmentDescription';
import { chatFields, chatOperations } from './descriptions/ChatDescription';
import { contactFields, contactOperations } from './descriptions/ContactDescription';
import { handleFields, handleOperations } from './descriptions/HandleDescription';
import { messageFields, messageOperations } from './descriptions/MessageDescription';
import {
	scheduledMessageFields,
	scheduledMessageOperations,
} from './descriptions/ScheduledMessageDescription';
import { serverFields, serverOperations } from './descriptions/ServerDescription';
import { createExecutionCache } from './GenericFunctions';
import { searchChats } from './methods/listSearch';

/** Resource value -> executor that handles its operations. */
const RESOURCE_EXECUTORS: Record<string, ResourceExecutor> = {
	attachment: attachmentExecute,
	chat: chatExecute,
	contact: contactExecute,
	handle: handleExecute,
	message: messageExecute,
	scheduledMessage: scheduledMessageExecute,
	server: serverExecute,
};

export class BlueBubbles implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BlueBubbles',
		name: 'blueBubbles',
		icon: { light: 'file:bluebubbles.svg', dark: 'file:bluebubbles.dark.svg' },
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
		description: 'Send and manage iMessages through a BlueBubbles server',
		defaults: {
			name: 'BlueBubbles',
		},
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'blueBubblesApi',
				required: true,
			},
		],
		properties: [
			{
				displayName: 'Resource',
				name: 'resource',
				type: 'options',
				noDataExpression: true,
				options: [
					{ name: 'Attachment', value: 'attachment' },
					{ name: 'Chat', value: 'chat' },
					{ name: 'Contact', value: 'contact' },
					{ name: 'Handle', value: 'handle' },
					{ name: 'Message', value: 'message' },
					{ name: 'Scheduled Message', value: 'scheduledMessage' },
					{ name: 'Server', value: 'server' },
				],
				default: 'message',
			},
			...messageOperations,
			...messageFields,
			...chatOperations,
			...chatFields,
			...attachmentOperations,
			...attachmentFields,
			...contactOperations,
			...contactFields,
			...handleOperations,
			...handleFields,
			...scheduledMessageOperations,
			...scheduledMessageFields,
			...serverOperations,
			...serverFields,
		],
	};

	methods = {
		listSearch: {
			searchChats,
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];
		// Per-execution cache (e.g. the resolved send method); never module state.
		const cache = createExecutionCache();

		for (let i = 0; i < items.length; i++) {
			try {
				const resource = this.getNodeParameter('resource', i) as string;
				const operation = this.getNodeParameter('operation', i) as string;
				const executor = RESOURCE_EXECUTORS[resource];
				if (!executor) {
					throw new NodeOperationError(this.getNode(), `Unsupported resource "${resource}"`, {
						itemIndex: i,
					});
				}
				const results = await executor.call(this, i, operation, cache);
				returnData.push(...results);
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Node errors from the request helpers are already sanitized; both
				// constructors hand them back unchanged instead of re-wrapping them.
				if (error instanceof NodeApiError) {
					error.context.itemIndex ??= i;
					throw new NodeApiError(this.getNode(), error as unknown as JsonObject, { itemIndex: i });
				}
				if (error instanceof NodeOperationError) {
					error.context.itemIndex ??= i;
				}
				throw new NodeOperationError(this.getNode(), error as Error, { itemIndex: i });
			}
		}

		return [returnData];
	}
}
