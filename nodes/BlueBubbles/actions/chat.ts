import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesRequestOptions, SendMethodOverride } from '../GenericFunctions';
import { CHAT_404_HINT, resolveSendMethod, simplifyMessage, tempGuid } from '../GenericFunctions';
import { call, isRecord, splitList } from './helpers';
import type { ResourceExecutor } from './shared';
import { MAX_PAGE_SIZE, getChatGuid, toItems } from './shared';

/** Smallest page used while filtering for unread chats (fewer round trips). */
const UNREAD_MIN_PAGE_SIZE = 100;

/** `/chat/<guid>` with the GUID safely encoded for a URL path segment. */
function chatPath(chatGuid: string, suffix = ''): string {
	return `/chat/${encodeURIComponent(chatGuid)}${suffix}`;
}

/** Output for routes whose `data` is empty or not an object. */
function actionResult(data: unknown, chatGuid: string): IDataObject {
	return isRecord(data) ? data : { success: true, chatGuid };
}

/** A chat action without a body that only needs the chat GUID. */
async function simpleChatAction(
	ctx: IExecuteFunctions,
	itemIndex: number,
	method: BlueBubblesRequestOptions['method'],
	suffix: string,
	operation: string,
	body?: IDataObject,
): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(ctx, itemIndex);
	const data = await call(ctx, {
		method,
		endpoint: chatPath(chatGuid, suffix),
		body,
		operation,
		hints: { 404: CHAT_404_HINT },
	});
	return toItems(actionResult(data, chatGuid), itemIndex);
}

async function getMany(ctx: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const limit = returnAll ? Infinity : (ctx.getNodeParameter('limit', itemIndex, 50) as number);
	const simplify = ctx.getNodeParameter('simplify', itemIndex, true) as boolean;
	const options = ctx.getNodeParameter('options', itemIndex, {}) as {
		unreadOnly?: boolean;
		recentMessages?: number;
	};
	const unreadOnly = options.unreadOnly === true;
	const recentCount = Math.min(Math.max(Math.floor(options.recentMessages ?? 0), 0), MAX_PAGE_SIZE);

	let pageSize = returnAll ? MAX_PAGE_SIZE : Math.min(Math.max(limit, 1), MAX_PAGE_SIZE);
	// When filtering, a page can come back with few matches: read bigger pages.
	if (unreadOnly) pageSize = Math.min(Math.max(pageSize, UNREAD_MIN_PAGE_SIZE), MAX_PAGE_SIZE);

	const chats: IDataObject[] = [];
	let offset = 0;
	while (chats.length < limit) {
		const page = await call<unknown>(ctx, {
			method: 'POST',
			endpoint: '/chat/query',
			body: { limit: pageSize, offset, sort: 'lastmessage', with: ['lastmessage'] },
			operation: 'Could not list BlueBubbles chats',
		});
		const rows = Array.isArray(page) ? page.filter(isRecord) : [];
		for (const chat of rows) {
			if (unreadOnly && !chat.hasUnreadMessages) continue;
			chats.push(chat);
			if (chats.length >= limit) break;
		}
		const pageLength = Array.isArray(page) ? page.length : 0;
		if (pageLength < pageSize) break;
		offset += pageLength;
	}

	if (recentCount > 0) {
		for (const chat of chats) {
			const chatGuid = String(chat.guid ?? '');
			if (!chatGuid) continue;
			const messages = await call<unknown>(ctx, {
				method: 'GET',
				endpoint: chatPath(chatGuid, '/message'),
				qs: { limit: recentCount, sort: 'DESC', with: 'attachment' },
				operation: 'Could not get the recent messages of a BlueBubbles chat',
				hints: { 404: CHAT_404_HINT },
			});
			const rows = Array.isArray(messages) ? messages.filter(isRecord) : [];
			chat.recentMessages = simplify ? rows.map(simplifyMessage) : rows;
		}
	}

	return toItems(chats, itemIndex);
}

async function create(
	ctx: IExecuteFunctions,
	itemIndex: number,
	cache: Parameters<ResourceExecutor>[2],
): Promise<INodeExecutionData[]> {
	const addresses = splitList(ctx.getNodeParameter('addresses', itemIndex) as string);
	if (addresses.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'At least one address is required', { itemIndex });
	}
	const message = ctx.getNodeParameter('message', itemIndex) as string;
	if (!message.trim()) {
		throw new NodeOperationError(ctx.getNode(), 'A message is required to create a chat', {
			itemIndex,
		});
	}
	const service = ctx.getNodeParameter('service', itemIndex, 'iMessage') as string;
	const options = ctx.getNodeParameter('options', itemIndex, {}) as {
		method?: SendMethodOverride;
	};
	const method = await resolveSendMethod(ctx, options.method ?? 'auto', cache);

	const data = await call(ctx, {
		method: 'POST',
		endpoint: '/chat/new',
		body: { addresses, message, method, service, tempGuid: tempGuid() },
		operation: 'Could not create the BlueBubbles chat',
	});
	return toItems(isRecord(data) ? data : { success: true }, itemIndex);
}

export const execute: ResourceExecutor = async function (
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
	cache,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'get': {
			const chatGuid = getChatGuid(this, itemIndex);
			const getChat = async (withParam: string) =>
				await call(this, {
					method: 'GET',
					endpoint: chatPath(chatGuid),
					qs: { with: withParam },
					operation: 'Could not get the BlueBubbles chat',
					hints: { 404: CHAT_404_HINT },
				});
			// The server answers 500 ("reading 'ROWID'") for `with=lastmessage` on a
			// chat that has no messages; retry without the last message.
			const data = await getChat('participants,lastmessage').catch(async (error: unknown) => {
				if (error instanceof NodeApiError && error.httpCode === '500') {
					return await getChat('participants');
				}
				throw error;
			});
			return toItems(isRecord(data) ? data : {}, itemIndex);
		}
		case 'getMany':
			return await getMany(this, itemIndex);
		case 'markRead':
			return await simpleChatAction(
				this,
				itemIndex,
				'POST',
				'/read',
				'Could not mark the chat as read',
			);
		case 'markUnread':
			return await simpleChatAction(
				this,
				itemIndex,
				'POST',
				'/unread',
				'Could not mark the chat as unread',
			);
		case 'startTyping':
			return await simpleChatAction(
				this,
				itemIndex,
				'POST',
				'/typing',
				'Could not start the typing indicator',
			);
		case 'stopTyping':
			return await simpleChatAction(
				this,
				itemIndex,
				'DELETE',
				'/typing',
				'Could not stop the typing indicator',
			);
		case 'rename': {
			const displayName = this.getNodeParameter('displayName', itemIndex) as string;
			return await simpleChatAction(this, itemIndex, 'PUT', '', 'Could not rename the group chat', {
				displayName,
			});
		}
		case 'addParticipant':
		case 'removeParticipant': {
			const address = (this.getNodeParameter('address', itemIndex) as string).trim();
			if (!address) {
				throw new NodeOperationError(this.getNode(), 'Address is required', { itemIndex });
			}
			const add = operation === 'addParticipant';
			return await simpleChatAction(
				this,
				itemIndex,
				'POST',
				add ? '/participant/add' : '/participant/remove',
				add ? 'Could not add the participant' : 'Could not remove the participant',
				{ address },
			);
		}
		case 'leave':
			return await simpleChatAction(this, itemIndex, 'POST', '/leave', 'Could not leave the chat');
		case 'delete':
			return await simpleChatAction(this, itemIndex, 'DELETE', '', 'Could not delete the chat');
		case 'create':
			return await create(this, itemIndex, cache);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for chats`,
				{ itemIndex },
			);
	}
};
