import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { blueBubblesApiRequest } from './GenericFunctions';

/** Shape of a webhook registration as returned by `GET /api/v1/webhook`. */
interface BlueBubblesWebhook {
	id: number | string;
	url: string;
	events: string[];
}

/**
 * BlueBubbles may return a webhook's `events` either as an array or as a
 * JSON-encoded string. Normalize to a string array.
 */
function normalizeEvents(events: unknown): string[] {
	let value = events;
	if (typeof value === 'string') {
		try {
			value = JSON.parse(value) as unknown;
		} catch {
			return [value as string];
		}
	}
	return Array.isArray(value) ? value.map((event) => String(event)) : [];
}

/** Order-insensitive set equality for two event lists. */
function sameEventSet(a: string[], b: string[]): boolean {
	const setA = new Set(a);
	const setB = new Set(b);
	if (setA.size !== setB.size) return false;
	for (const event of setA) {
		if (!setB.has(event)) return false;
	}
	return true;
}

export class BlueBubblesTrigger implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'BlueBubbles Trigger',
		name: 'blueBubblesTrigger',
		icon: { light: 'file:bluebubbles.svg', dark: 'file:bluebubbles.dark.svg' },
		group: ['trigger'],
		version: 1,
		subtitle: '={{"Events: " + $parameter["events"].join(", ")}}',
		description: 'Starts the workflow when BlueBubbles events occur',
		defaults: {
			name: 'BlueBubbles Trigger',
		},
		inputs: [],
		outputs: [NodeConnectionTypes.Main],
		credentials: [
			{
				name: 'blueBubblesApi',
				required: true,
			},
		],
		webhooks: [
			{
				name: 'default',
				httpMethod: 'POST',
				responseMode: 'onReceived',
				path: 'webhook',
			},
		],
		properties: [
			{
				displayName:
					'Your BlueBubbles server must be able to reach this n8n instance\'s webhook URL. If n8n runs behind a proxy or on a private network, set the WEBHOOK_URL environment variable to an address the BlueBubbles server can reach.',
				name: 'notice',
				type: 'notice',
				default: '',
			},
			{
				displayName: 'Events',
				name: 'events',
				type: 'multiOptions',
				required: true,
				default: ['new-message'],
				description: 'The BlueBubbles events to listen to',
				options: [
					{
						name: 'All Events',
						value: '*',
						description: 'Receive every event the server emits',
					},
					{
						name: 'Chat Read Status Changed',
						value: 'chat-read-status-changed',
						description: 'A chat was marked as read or unread',
					},
					{
						name: 'FaceTime Call Status Changed',
						value: 'ft-call-status-changed',
						description: 'The status of a FaceTime call changed',
					},
					{
						name: 'Group Icon Changed',
						value: 'group-icon-changed',
						description: 'A group chat icon was changed',
					},
					{
						name: 'Group Icon Removed',
						value: 'group-icon-removed',
						description: 'A group chat icon was removed',
					},
					{
						name: 'Group Name Changed',
						value: 'group-name-change',
						description: 'A group chat was renamed',
					},
					{
						name: 'Hello World',
						value: 'hello-world',
						description: 'Test event sent by the server',
					},
					{
						name: 'iMessage Alias Removed',
						value: 'imessage-alias-removed',
						description: 'An iMessage alias was deregistered',
					},
					{
						name: 'Incoming FaceTime',
						value: 'incoming-facetime',
						description: 'An incoming FaceTime call was received',
					},
					{
						name: 'Message Send Error',
						value: 'message-send-error',
						description: 'A message failed to send',
					},
					{
						name: 'New Find My Location',
						value: 'new-findmy-location',
						description: 'A Find My location update was received',
					},
					{
						name: 'New Message',
						value: 'new-message',
						description: 'A new message was sent or received',
					},
					{
						name: 'New Server',
						value: 'new-server',
						description: 'The server URL changed',
					},
					{
						name: 'Participant Added',
						value: 'participant-added',
						description: 'A participant was added to a group chat',
					},
					{
						name: 'Participant Left',
						value: 'participant-left',
						description: 'A participant left a group chat',
					},
					{
						name: 'Participant Removed',
						value: 'participant-removed',
						description: 'A participant was removed from a group chat',
					},
					{
						name: 'Scheduled Message Error',
						value: 'scheduled-message-error',
						description: 'A scheduled message failed to send',
					},
					{
						name: 'Server Update',
						value: 'server-update',
						description: 'A server update is available',
					},
					{
						name: 'Typing Indicator',
						value: 'typing-indicator',
						description: 'Someone started or stopped typing',
					},
					{
						name: 'Updated Message',
						value: 'updated-message',
						description: 'A message was updated (delivered, read, edited, or reacted to)',
					},
				],
			},
		],
	};

	webhookMethods = {
		default: {
			async checkExists(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				const staticData = this.getWorkflowStaticData('node');

				const response = (await blueBubblesApiRequest.call(this, 'GET', '/webhook', {}, {
					url: webhookUrl,
				})) as IDataObject | undefined;

				const rawData = Array.isArray(response?.data) ? (response.data as IDataObject[]) : [];
				// The server-side `url` filter may be fuzzy, so match exactly here.
				const matching: BlueBubblesWebhook[] = rawData
					.filter((entry) => entry.url === webhookUrl)
					.map((entry) => ({
						id: entry.id as number | string,
						url: entry.url as string,
						events: normalizeEvents(entry.events),
					}));

				const existing = matching.find((webhook) => sameEventSet(webhook.events, events));

				// Remove every other registration for this URL (stale event lists or
				// duplicates) so BlueBubbles delivers each event to n8n exactly once.
				for (const stale of matching.filter((webhook) => webhook !== existing)) {
					try {
						await blueBubblesApiRequest.call(this, 'DELETE', `/webhook/${stale.id}`);
					} catch (error) {
						this.logger.warn(
							`BlueBubbles Trigger: failed to delete stale webhook ${stale.id}: ${(error as Error).message}`,
						);
					}
				}

				if (existing) {
					staticData.webhookId = existing.id;
					return true;
				}

				return false;
			},

			async create(this: IHookFunctions): Promise<boolean> {
				const webhookUrl = this.getNodeWebhookUrl('default') as string;
				const events = this.getNodeParameter('events') as string[];
				const staticData = this.getWorkflowStaticData('node');

				const response = (await blueBubblesApiRequest.call(this, 'POST', '/webhook', {
					url: webhookUrl,
					events,
				})) as IDataObject | undefined;

				const id = (response?.data as IDataObject | undefined)?.id;
				if (id === undefined || id === null) {
					throw new NodeOperationError(
						this.getNode(),
						'BlueBubbles server did not return a webhook ID when registering the webhook',
					);
				}

				staticData.webhookId = id as number | string;
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');

				if (staticData.webhookId !== undefined) {
					try {
						await blueBubblesApiRequest.call(
							this,
							'DELETE',
							`/webhook/${staticData.webhookId as string}`,
						);
					} catch (error) {
						const httpCode = error instanceof NodeApiError ? String(error.httpCode) : null;
						if (httpCode !== '404') {
							this.logger.warn(
								`BlueBubbles Trigger: failed to delete webhook ${staticData.webhookId as string}: ${(error as Error).message}`,
							);
							return false;
						}
					}
					delete staticData.webhookId;
				}

				return true;
			},
		},
	};

	async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
		const body = this.getBodyData();
		return {
			workflowData: [this.helpers.returnJsonArray(body as IDataObject)],
		};
	}
}
