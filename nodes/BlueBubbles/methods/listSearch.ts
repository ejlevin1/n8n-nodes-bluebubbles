import type {
	IDataObject,
	ILoadOptionsFunctions,
	INodeListSearchItems,
	INodeListSearchResult,
} from 'n8n-workflow';

import { blueBubblesApiCall } from '../GenericFunctions';

/** Chats fetched per list page. */
const PAGE_SIZE = 100;

function isRecord(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Display name of a chat: its name, else its participants' addresses, else its GUID. */
export function chatDisplayName(chat: IDataObject): string {
	const displayName = typeof chat.displayName === 'string' ? chat.displayName.trim() : '';
	if (displayName) return displayName;

	const participants = Array.isArray(chat.participants) ? chat.participants : [];
	const addresses = participants
		.map((participant) =>
			isRecord(participant) && typeof participant.address === 'string' ? participant.address : '',
		)
		.filter((address) => address.length > 0);
	if (addresses.length > 0) return addresses.join(', ');

	if (typeof chat.chatIdentifier === 'string' && chat.chatIdentifier) return chat.chatIdentifier;
	return String(chat.guid ?? '');
}

/**
 * Resource-locator list for the Chat parameter: chats by most recent activity,
 * filtered client-side on name and GUID. The pagination token is the next offset.
 */
export async function searchChats(
	this: ILoadOptionsFunctions,
	filter?: string,
	paginationToken?: string,
): Promise<INodeListSearchResult> {
	const parsed = Number(paginationToken);
	const offset = Number.isInteger(parsed) && parsed > 0 ? parsed : 0;

	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: '/chat/query',
		body: { limit: PAGE_SIZE, offset, sort: 'lastmessage', with: ['lastmessage'] },
		operation: 'Could not list BlueBubbles chats',
	});
	const rows = Array.isArray(data) ? data.filter(isRecord) : [];

	const query = (filter ?? '').trim().toLowerCase();
	const results: INodeListSearchItems[] = [];
	for (const chat of rows) {
		const guid = typeof chat.guid === 'string' ? chat.guid : '';
		if (!guid) continue;
		const name = chatDisplayName(chat);
		if (query && !name.toLowerCase().includes(query) && !guid.toLowerCase().includes(query)) {
			continue;
		}
		results.push({ name, value: guid });
	}

	return {
		results,
		paginationToken: rows.length === PAGE_SIZE ? String(offset + rows.length) : undefined,
	};
}
