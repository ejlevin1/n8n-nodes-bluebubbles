import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesExecutionCache } from '../GenericFunctions';
import { addressToChatGuid, normalizeChatGuid } from '../GenericFunctions';

/** Signature every resource module exports as `execute`. */
export type ResourceExecutor = (
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
	cache: BlueBubblesExecutionCache,
) => Promise<INodeExecutionData[]>;

/** Largest page the server accepts; above this it answers 400. */
export const MAX_PAGE_SIZE = 1000;

/** Resolves the `chat` resource locator to a normalized chat GUID. */
export function getChatGuid(ctx: IExecuteFunctions, itemIndex: number, name = 'chat'): string {
	const locator = ctx.getNodeParameter(name, itemIndex) as { mode: string; value: string };
	const value = String(locator?.value ?? '').trim();
	if (!value) {
		throw new NodeOperationError(ctx.getNode(), 'Chat is required', { itemIndex });
	}
	return locator.mode === 'address' ? addressToChatGuid(value) : normalizeChatGuid(value);
}

/** Wraps results as paired output items for one input item. */
export function toItems(
	data: IDataObject | IDataObject[] | null | undefined,
	itemIndex: number,
): INodeExecutionData[] {
	const rows = Array.isArray(data) ? data : [data ?? {}];
	return rows.map((json) => ({ json, pairedItem: { item: itemIndex } }));
}
