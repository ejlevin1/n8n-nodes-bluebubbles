import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesExecutionCache, SendMethodOverride } from '../GenericFunctions';
import {
	addressToChatGuid,
	blueBubblesApiCall,
	CHAT_404_HINT,
	isTimeoutError,
	normalizeChatGuid,
	resolveSendMethod,
	simplifyMessage,
	tempGuid,
} from '../GenericFunctions';
import {
	asObject,
	collectPages,
	encodeGuid,
	matchesSender,
	MESSAGE_404_HINT,
	requireString,
	resolveMessageChats,
	senderClauses,
	textClauses,
	toTimestampMs,
	type SearchMethod,
	type WhereClause,
} from './messageHelpers';
import type { ResourceExecutor } from './shared';
import { getChatGuid, toItems } from './shared';

const REACTIONS = new Set(['love', 'like', 'dislike', 'laugh', 'emphasize', 'question']);

const SEARCH_METHODS: readonly SearchMethod[] = ['auto', 'spotlight', 'database'];

/**
 * How long Search Method "Auto" waits for the Spotlight search before it falls
 * back to the database search. A healthy helper answers in about a second; with
 * Spotlight indexing disabled on the Mac the helper never answers and the server
 * only fails after its 120 s transaction timeout. The server exposes no way to
 * tell that Spotlight is off, so this bound is the only protection in Auto mode.
 */
export const SPOTLIGHT_AUTO_TIMEOUT_MS = 10_000;

/** Note added to Auto results that came from the database fallback. */
function fallbackNote(reason: string): string {
	return `Spotlight search failed (${reason}); these results come from the database search, which misses sent messages whose text is stored only in rich-text form (macOS 13+). If Spotlight indexing is disabled on the Mac, set Search Method to Database to skip the Spotlight attempt.`;
}

interface SendOptions extends IDataObject {
	method?: SendMethodOverride;
	subject?: string;
	effectId?: string;
	replyToMessageGuid?: string;
}

function getOptions<T extends IDataObject>(ctx: IExecuteFunctions, itemIndex: number): T {
	return (ctx.getNodeParameter('options', itemIndex, {}) ?? {}) as T;
}

function getPartIndex(ctx: IExecuteFunctions, itemIndex: number): number {
	const value = Number(getOptions<IDataObject>(ctx, itemIndex).partIndex ?? 0);
	return Number.isInteger(value) && value >= 0 ? value : 0;
}

function maybeSimplify(rows: IDataObject[], simplify: boolean): IDataObject[] {
	return simplify ? rows.map((row) => simplifyMessage(row)) : rows;
}

/** `POST /message/text` to one chat. */
async function sendText(
	ctx: IExecuteFunctions,
	itemIndex: number,
	cache: BlueBubblesExecutionCache,
	chatGuid: string,
	text: string,
	options: SendOptions,
): Promise<IDataObject> {
	const method = await resolveSendMethod(ctx, options.method ?? 'auto', cache);
	const body: IDataObject = { chatGuid, tempGuid: tempGuid(), message: text, method };
	if (options.subject) body.subject = options.subject;
	if (options.effectId) body.effectId = options.effectId;

	const replyTo = (options.replyToMessageGuid ?? '').trim();
	if (replyTo) {
		if (method !== 'private-api') {
			throw new NodeOperationError(ctx.getNode(), 'Threaded replies require the Private API', {
				itemIndex,
				description:
					'"Reply to Message GUID" only works when the message is sent with the Private API, but the send method resolved to AppleScript. Enable the Private API in BlueBubbles Server (SIP off, helper connected), or remove the reply option.',
			});
		}
		body.selectedMessageGuid = replyTo;
	}

	const data = await blueBubblesApiCall.call(ctx, {
		method: 'POST',
		endpoint: '/message/text',
		body,
		operation: 'Could not send the BlueBubbles message',
	});
	return asObject(data);
}

async function send(
	this: IExecuteFunctions,
	i: number,
	cache: BlueBubblesExecutionCache,
): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(this, i);
	const text = requireString(this, 'text', i, 'Text');
	const data = await sendText(this, i, cache, chatGuid, text, getOptions<SendOptions>(this, i));
	return toItems(data, i);
}

async function sendToAddress(
	this: IExecuteFunctions,
	i: number,
	cache: BlueBubblesExecutionCache,
): Promise<INodeExecutionData[]> {
	const address = requireString(this, 'address', i, 'Address');
	const text = requireString(this, 'text', i, 'Text');
	const service = this.getNodeParameter('service', i, 'iMessage') as string;
	const options = getOptions<SendOptions>(this, i);

	if (service !== 'SMS') {
		return toItems(await sendText(this, i, cache, addressToChatGuid(address), text, options), i);
	}

	// SMS: only /chat/new can pin the service, and it needs the Private API.
	const method = await resolveSendMethod(this, options.method ?? 'auto', cache);
	if (method !== 'private-api') {
		throw new NodeOperationError(this.getNode(), 'Sending SMS requires the Private API', {
			itemIndex: i,
			description:
				'The SMS service can only be forced through the Private API, but the send method resolved to AppleScript. Enable the Private API in BlueBubbles Server (SIP off, helper connected), or use the iMessage service (the server then picks the service itself).',
		});
	}
	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: '/chat/new',
		body: {
			addresses: [address],
			message: text,
			method: 'private-api',
			service: 'SMS',
			tempGuid: tempGuid(),
		},
		operation: 'Could not send the BlueBubbles SMS',
	});
	return toItems(asObject(data), i);
}

async function get(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const messageGuid = requireString(this, 'messageGuid', i, 'Message GUID');
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const data = await blueBubblesApiCall.call(this, {
		method: 'GET',
		endpoint: `/message/${encodeGuid(messageGuid)}`,
		qs: { with: 'chats,attachments' },
		operation: 'Could not get the BlueBubbles message',
		hints: { 404: MESSAGE_404_HINT },
	});
	const message = asObject(data, {});
	return toItems(simplify ? simplifyMessage(message) : message, i);
}

async function getMany(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;

	const qs: IDataObject = { with: 'attachment', sort: filters.sort === 'ASC' ? 'ASC' : 'DESC' };
	const after = toTimestampMs(this, filters.after, i, 'Created After');
	const before = toTimestampMs(this, filters.before, i, 'Created Before');
	if (after !== undefined) qs.after = after;
	if (before !== undefined) qs.before = before;

	const rows = await collectPages(
		async (offset, pageSize) =>
			await blueBubblesApiCall.call(this, {
				method: 'GET',
				endpoint: `/chat/${encodeGuid(chatGuid)}/message`,
				qs: { ...qs, limit: pageSize, offset },
				operation: 'Could not get the BlueBubbles chat messages',
				hints: { 404: CHAT_404_HINT },
			}),
		returnAll,
		limit,
	);

	const fromAddress = typeof filters.fromAddress === 'string' ? filters.fromAddress : undefined;
	const matching = rows.filter((row) => matchesSender(row, fromAddress));
	return toItems(maybeSimplify(matching, simplify), i);
}

/** The optional chat scope of Search; `undefined` searches every chat. */
function getOptionalChatGuid(ctx: IExecuteFunctions, i: number): string | undefined {
	const locator = ctx.getNodeParameter('chat', i, { mode: 'list', value: '' }) as
		{ mode?: string; value?: unknown } | string | undefined;
	const value = typeof locator === 'string' ? locator : locator?.value;
	if (typeof value !== 'string' || !value.trim()) return undefined;
	if (typeof locator === 'string') return normalizeChatGuid(locator.trim());
	return getChatGuid(ctx, i);
}

function getSearchMethod(ctx: IExecuteFunctions, i: number): SearchMethod {
	const value = String(ctx.getNodeParameter('searchMethod', i, 'auto') ?? 'auto');
	if ((SEARCH_METHODS as readonly string[]).includes(value)) return value as SearchMethod;
	throw new NodeOperationError(ctx.getNode(), `Unknown search method "${value}"`, {
		itemIndex: i,
		description: `Use one of: ${SEARCH_METHODS.join(', ')}.`,
	});
}

/** Whether a failed Spotlight search should be retried against the database. */
function isSpotlightFailure(error: unknown): error is NodeApiError {
	if (!(error instanceof NodeApiError)) return false;
	if (isTimeoutError(error)) return true;
	const status = Number(error.httpCode);
	return Number.isInteger(status) && status >= 500;
}

async function search(
	this: IExecuteFunctions,
	i: number,
	cache: BlueBubblesExecutionCache,
): Promise<INodeExecutionData[]> {
	const query = String(this.getNodeParameter('query', i, '') ?? '');
	const searchMethod = getSearchMethod(this, i);
	const chatGuid = getOptionalChatGuid(this, i);
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const limit = returnAll ? 0 : (this.getNodeParameter('limit', i, 50) as number);
	const simplify = this.getNodeParameter('simplify', i, true) as boolean;
	const filters = this.getNodeParameter('filters', i, {}) as IDataObject;

	// Never `with: ["chats"]` here: that join is INNER and silently drops ~5% of rows.
	const base: IDataObject = { sort: 'DESC', with: ['attachment'] };
	if (chatGuid) base.chatGuid = chatGuid;
	const after = toTimestampMs(this, filters.after, i, 'Created After');
	const before = toTimestampMs(this, filters.before, i, 'Created Before');
	if (after !== undefined) base.after = after;
	if (before !== undefined) base.before = before;

	const senders = senderClauses(
		typeof filters.fromAddress === 'string' ? filters.fromAddress : undefined,
	);

	const fetchRows = async (text: WhereClause[], timeout?: number): Promise<IDataObject[]> => {
		const where = [...text, ...senders];
		const body: IDataObject = where.length > 0 ? { ...base, where } : base;
		return await collectPages(
			async (offset, pageSize) =>
				await blueBubblesApiCall.call(this, {
					method: 'POST',
					endpoint: '/message/query',
					body: { limit: pageSize, offset, ...body },
					operation: 'Could not search BlueBubbles messages',
					timeout,
				}),
			returnAll,
			limit,
		);
	};

	const notes: string[] = [];
	let rows: IDataObject[];
	if (query && searchMethod === 'auto' && cache.spotlightFailed) {
		// An earlier item of this execution already saw Spotlight fail.
		rows = await fetchRows(textClauses(query, 'database'));
		notes.push(fallbackNote('skipped after an earlier item of this execution failed'));
	} else if (!query || searchMethod !== 'auto') {
		rows = await fetchRows(
			textClauses(query, searchMethod === 'auto' ? 'spotlight' : searchMethod),
		);
	} else {
		rows = await fetchRows(textClauses(query, 'spotlight'), SPOTLIGHT_AUTO_TIMEOUT_MS).catch(
			async (error: unknown) => {
				if (!isSpotlightFailure(error)) throw error;
				const reason = error.message;
				this.logger.warn('BlueBubbles Spotlight search failed; using the database search', {
					error: reason,
				});
				cache.spotlightFailed = true;
				notes.push(fallbackNote(reason));
				return await fetchRows(textClauses(query, 'database'));
			},
		);
	}

	// Second pass: attach chats. A failure here must not fail the item.
	try {
		const chats = await resolveMessageChats(
			this,
			rows.map((row) => String(row.guid ?? '')),
		);
		for (const row of rows) row.chats = chats.get(String(row.guid ?? '')) ?? [];
	} catch (error) {
		for (const row of rows) row.chats = Array.isArray(row.chats) ? row.chats : [];
		notes.push(
			`Chat lookup failed (${(error as Error).message}); the messages are complete but have no chats.`,
		);
	}

	const output = maybeSimplify(rows, simplify);
	if (notes.length > 0) {
		const note = notes.join(' ');
		for (const row of output) row.note = note;
	}
	return toItems(output, i);
}

async function react(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(this, i);
	const messageGuid = requireString(this, 'messageGuid', i, 'Message GUID');
	const reaction = String(this.getNodeParameter('reaction', i, 'love'))
		.trim()
		.toLowerCase();
	if (!REACTIONS.has(reaction)) {
		throw new NodeOperationError(this.getNode(), `Unknown reaction "${reaction}"`, {
			itemIndex: i,
			description: `Use one of: ${[...REACTIONS].join(', ')}.`,
		});
	}
	const remove = this.getNodeParameter('remove', i, false) as boolean;
	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: '/message/react',
		body: {
			chatGuid,
			selectedMessageGuid: messageGuid,
			reaction: remove ? `-${reaction}` : reaction,
			partIndex: getPartIndex(this, i),
		},
		operation: 'Could not send the BlueBubbles reaction',
	});
	return toItems(asObject(data), i);
}

async function edit(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const messageGuid = requireString(this, 'messageGuid', i, 'Message GUID');
	const newText = requireString(this, 'newText', i, 'New Text');
	const options = getOptions<IDataObject>(this, i);
	const fallback = String(options.backwardsCompatibilityMessage ?? '').trim();
	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: `/message/${encodeGuid(messageGuid)}/edit`,
		body: {
			editedMessage: newText,
			backwardsCompatibilityMessage: fallback || `Edited to: ${newText}`,
			partIndex: getPartIndex(this, i),
		},
		operation: 'Could not edit the BlueBubbles message',
		hints: { 404: MESSAGE_404_HINT },
	});
	return toItems(asObject(data), i);
}

async function unsend(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const messageGuid = requireString(this, 'messageGuid', i, 'Message GUID');
	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: `/message/${encodeGuid(messageGuid)}/unsend`,
		body: { partIndex: getPartIndex(this, i) },
		operation: 'Could not unsend the BlueBubbles message',
		hints: { 404: MESSAGE_404_HINT },
	});
	return toItems(asObject(data), i);
}

/** Runs one Message operation for one input item. */
export const execute: ResourceExecutor = async function (this, itemIndex, operation, cache) {
	switch (operation) {
		case 'send':
			return await send.call(this, itemIndex, cache);
		case 'sendToAddress':
			return await sendToAddress.call(this, itemIndex, cache);
		case 'get':
			return await get.call(this, itemIndex);
		case 'getMany':
			return await getMany.call(this, itemIndex);
		case 'search':
			return await search.call(this, itemIndex, cache);
		case 'react':
			return await react.call(this, itemIndex);
		case 'edit':
			return await edit.call(this, itemIndex);
		case 'unsend':
			return await unsend.call(this, itemIndex);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for messages`,
				{ itemIndex },
			);
	}
};
