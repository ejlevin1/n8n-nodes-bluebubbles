import type {
	IDataObject,
	IHookFunctions,
	INodeType,
	INodeTypeDescription,
	IWebhookFunctions,
	IWebhookResponseData,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

import { blueBubblesApiRequest } from './GenericFunctions';

/** A webhook registration as returned by the BlueBubbles `/api/v1/webhook` endpoints. */
interface BlueBubblesWebhook {
	id: number | string;
	url: string;
	events: string[];
}

/**
 * BlueBubbles stores a webhook's `events` as a JSON string and normally parses it
 * before responding. Accept both an array and a JSON-encoded string.
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

/** Convert a raw webhook entry from the API, or `undefined` if it is unusable. */
function toWebhook(entry: unknown): BlueBubblesWebhook | undefined {
	if (typeof entry !== 'object' || entry === null) return undefined;
	const { id, url, events } = entry as IDataObject;
	if ((typeof id !== 'number' && typeof id !== 'string') || typeof url !== 'string') {
		return undefined;
	}
	return { id, url, events: normalizeEvents(events) };
}

/** `GET /api/v1/webhook` (unfiltered) and return every registered webhook. */
async function listWebhooks(this: IHookFunctions): Promise<BlueBubblesWebhook[]> {
	const response = (await blueBubblesApiRequest.call(this, {
		method: 'GET',
		endpoint: '/webhook',
		operation: 'Could not list BlueBubbles webhooks',
	})) as IDataObject | undefined;

	const data = Array.isArray(response?.data) ? (response.data as unknown[]) : [];
	return data.map(toWebhook).filter((webhook): webhook is BlueBubblesWebhook => !!webhook);
}

/** `POST /api/v1/webhook` and return the webhook the server reports. */
async function registerWebhook(
	this: IHookFunctions,
	url: string,
	events: string[],
): Promise<BlueBubblesWebhook> {
	const response = (await blueBubblesApiRequest.call(this, {
		method: 'POST',
		endpoint: '/webhook',
		body: { url, events },
		operation: 'Could not register the BlueBubbles webhook',
	})) as IDataObject | undefined;

	const webhook = toWebhook(response?.data);
	if (!webhook) {
		throw new NodeOperationError(
			this.getNode(),
			'BlueBubbles did not return the registered webhook',
			{
				description:
					'POST /api/v1/webhook succeeded but the response had no webhook ID in "data". Check that the server URL points to BlueBubbles Server 1.9.9 or newer.',
			},
		);
	}
	return webhook;
}

/**
 * `DELETE /api/v1/webhook/:id`. A 404 counts as success (already gone).
 *
 * @param warnOnly - log a warning and return `false` instead of throwing on failure
 * @returns `true` when the webhook is gone
 */
async function deleteWebhook(
	this: IHookFunctions,
	webhookId: number | string,
	operation: string,
	{ warnOnly = false }: { warnOnly?: boolean } = {},
): Promise<boolean> {
	try {
		await blueBubblesApiRequest.call(this, {
			method: 'DELETE',
			endpoint: `/webhook/${encodeURIComponent(String(webhookId))}`,
			operation,
		});
		this.logger.info('BlueBubbles Trigger: deleted webhook', { webhookId });
		return true;
	} catch (error) {
		if (error instanceof NodeApiError && String(error.httpCode) === '404') {
			this.logger.debug('BlueBubbles Trigger: webhook already deleted', { webhookId });
			return true;
		}
		if (!warnOnly) {
			// blueBubblesApiRequest only throws already-sanitized node errors; both
			// constructors hand those back unchanged instead of re-wrapping them.
			if (error instanceof NodeApiError)
				throw new NodeApiError(this.getNode(), error as unknown as JsonObject);
			throw new NodeOperationError(this.getNode(), error as Error);
		}

		this.logger.warn(`BlueBubbles Trigger: ${(error as Error).message}`, {
			webhookId,
			description: (error as NodeApiError).description ?? undefined,
		});
		return false;
	}
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
					"Your BlueBubbles server must be able to reach this n8n instance's webhook URL. If n8n runs behind a proxy or on a private network, set the WEBHOOK_URL environment variable to an address the BlueBubbles server can reach.",
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
						description:
							'Sent when the BlueBubbles HTTP server starts (not when the webhook is registered)',
					},
					{
						name: 'iMessage Alias Removed',
						value: 'imessage-alias-removed',
						description:
							'An iMessage alias was deregistered. Note: BlueBubbles Server currently emits this as "imessage-aliases-removed", so only All Events receives it.',
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
						name: 'Settings Backup Created',
						value: 'settings-backup-created',
						description: 'A settings backup was created',
					},
					{
						name: 'Settings Backup Deleted',
						value: 'settings-backup-deleted',
						description: 'A settings backup was deleted',
					},
					{
						name: 'Settings Backup Updated',
						value: 'settings-backup-updated',
						description: 'A settings backup was updated',
					},
					{
						name: 'Theme Backup Created',
						value: 'theme-backup-created',
						description: 'A theme backup was created',
					},
					{
						name: 'Theme Backup Deleted',
						value: 'theme-backup-deleted',
						description: 'A theme backup was deleted',
					},
					{
						name: 'Theme Backup Updated',
						value: 'theme-backup-updated',
						description: 'A theme backup was updated',
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

				let webhooks: BlueBubblesWebhook[];
				try {
					webhooks = await listWebhooks.call(this);
				} catch (error) {
					// Do not fail activation here: `create` runs next and reports a
					// problem (unreachable server, wrong password, ...) with full context.
					this.logger.warn(
						'BlueBubbles Trigger: could not list webhooks; will try to register one',
						{
							error: (error as Error).message,
							description: (error as NodeApiError).description ?? undefined,
						},
					);
					return false;
				}

				// Match the URL exactly. The server's `?url=` filter is not used: it
				// returns HTTP 500 when no webhook has that URL.
				const matching = webhooks.filter((webhook) => webhook.url === webhookUrl);
				const existing = matching.find((webhook) => sameEventSet(webhook.events, events));

				this.logger.debug('BlueBubbles Trigger: checked for an existing webhook', {
					webhookUrl,
					events,
					registeredWebhooks: webhooks.length,
					matchingIds: matching.map((webhook) => webhook.id),
					existingId: existing?.id,
				});

				// BlueBubbles keeps one webhook per URL. Remove registrations for this URL
				// whose events differ, so `create` can register the new event list.
				for (const stale of matching.filter((webhook) => webhook !== existing)) {
					await deleteWebhook.call(
						this,
						stale.id,
						'Could not remove an outdated BlueBubbles webhook',
						{
							warnOnly: true,
						},
					);
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

				if (!Array.isArray(events) || events.length === 0) {
					throw new NodeOperationError(this.getNode(), 'No BlueBubbles events selected', {
						description: 'Select at least one event (or "All Events") in the Events field.',
					});
				}

				let webhook = await registerWebhook.call(this, webhookUrl, events);

				// BlueBubbles stores one webhook per URL: when the URL is already registered
				// it returns the existing row unchanged and ignores the requested events.
				// Replace it once so the subscription matches the node configuration.
				if (!sameEventSet(webhook.events, events)) {
					this.logger.warn(
						'BlueBubbles Trigger: server returned an existing webhook with different events; replacing it',
						{ webhookId: webhook.id, registeredEvents: webhook.events, requestedEvents: events },
					);
					await deleteWebhook.call(
						this,
						webhook.id,
						'Could not replace the existing BlueBubbles webhook',
					);
					webhook = await registerWebhook.call(this, webhookUrl, events);

					if (!sameEventSet(webhook.events, events)) {
						throw new NodeOperationError(
							this.getNode(),
							'BlueBubbles did not apply the selected events to the webhook',
							{
								description: `BlueBubbles webhook ${webhook.id} for ${webhookUrl} is subscribed to [${webhook.events.join(', ')}] instead of [${events.join(', ')}]. Remove it in the BlueBubbles Server app (API & Webhooks) and activate the workflow again.`,
							},
						);
					}
				}

				staticData.webhookId = webhook.id;
				this.logger.info('BlueBubbles Trigger: registered webhook', {
					webhookId: webhook.id,
					webhookUrl,
					events: webhook.events,
				});
				return true;
			},

			async delete(this: IHookFunctions): Promise<boolean> {
				const staticData = this.getWorkflowStaticData('node');
				if (staticData.webhookId === undefined) return true;

				const webhookId = staticData.webhookId as number | string;
				const deleted = await deleteWebhook.call(
					this,
					webhookId,
					'Could not delete the BlueBubbles webhook',
					{
						warnOnly: true,
					},
				);
				if (!deleted) return false;

				delete staticData.webhookId;
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
