import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';

import type { BlueBubblesRequestOptions } from '../GenericFunctions';
import { blueBubblesApiCall } from '../GenericFunctions';

/** Small helpers shared by the chat, contact, handle and server executors. */

export function isRecord(value: unknown): value is IDataObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Split a comma / newline separated list, trimming and dropping blanks. */
export function splitList(value: string): string[] {
	return value
		.split(/[,\n]/)
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

/** `blueBubblesApiCall` bound to the execute context. */
export async function call<T = unknown>(
	ctx: IExecuteFunctions,
	options: BlueBubblesRequestOptions,
): Promise<T> {
	return (await blueBubblesApiCall.call(ctx, options)) as T;
}
