import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { call, isRecord, splitList } from './helpers';
import type { ResourceExecutor } from './shared';
import { toItems } from './shared';

/** Address entries (`phoneNumbers` / `emails`) of a contact. */
function addressesOf(contact: IDataObject): string[] {
	const out: string[] = [];
	for (const key of ['phoneNumbers', 'emails']) {
		const list = contact[key];
		if (!Array.isArray(list)) continue;
		for (const entry of list) {
			if (isRecord(entry) && typeof entry.address === 'string') out.push(entry.address);
		}
	}
	return out;
}

/**
 * Case-insensitive substring match on `displayName` and on every phone number
 * and email address (same as the reference `get_contacts(query)`).
 */
export function contactMatches(contact: IDataObject, search: string): boolean {
	const query = search.toLowerCase();
	const name = typeof contact.displayName === 'string' ? contact.displayName : '';
	return (
		name.toLowerCase().includes(query) ||
		addressesOf(contact).some((address) => address.toLowerCase().includes(query))
	);
}

async function getMany(ctx: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
	const returnAll = ctx.getNodeParameter('returnAll', itemIndex, false) as boolean;
	const options = ctx.getNodeParameter('options', itemIndex, {}) as { search?: string };
	const search = (options.search ?? '').trim();

	const data = await call<unknown>(ctx, {
		method: 'GET',
		endpoint: '/contact',
		operation: 'Could not list BlueBubbles contacts',
	});
	let contacts = Array.isArray(data) ? data.filter(isRecord) : [];
	if (search) contacts = contacts.filter((contact) => contactMatches(contact, search));
	if (!returnAll) {
		const limit = ctx.getNodeParameter('limit', itemIndex, 50) as number;
		contacts = contacts.slice(0, limit);
	}
	return toItems(contacts, itemIndex);
}

async function lookupByAddress(
	ctx: IExecuteFunctions,
	itemIndex: number,
): Promise<INodeExecutionData[]> {
	const addresses = splitList(ctx.getNodeParameter('addresses', itemIndex) as string);
	if (addresses.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'At least one address is required', { itemIndex });
	}
	const data = await call<unknown>(ctx, {
		method: 'POST',
		endpoint: '/contact/query',
		body: { addresses },
		operation: 'Could not look up BlueBubbles contacts',
	});
	return toItems(Array.isArray(data) ? data.filter(isRecord) : [], itemIndex);
}

export const execute: ResourceExecutor = async function (
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'getMany':
			return await getMany(this, itemIndex);
		case 'lookupByAddress':
			return await lookupByAddress(this, itemIndex);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for contacts`,
				{ itemIndex },
			);
	}
};
