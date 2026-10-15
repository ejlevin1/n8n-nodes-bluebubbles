import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesExecutionCache, SendMethodOverride } from '../GenericFunctions';
import { blueBubblesApiCall, resolveSendMethod } from '../GenericFunctions';
import { asObject, requireString, toTimestampMs } from './messageHelpers';
import type { ResourceExecutor } from './shared';
import { getChatGuid, toItems } from './shared';

const SCHEDULE_404_HINT = 'Scheduled message does not exist; check the ID with Get Many';

async function create(
	this: IExecuteFunctions,
	i: number,
	cache: BlueBubblesExecutionCache,
): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(this, i);
	const text = requireString(this, 'text', i, 'Text');
	const scheduledFor = toTimestampMs(
		this,
		this.getNodeParameter('scheduledFor', i, ''),
		i,
		'Send At',
	);
	if (scheduledFor === undefined) {
		throw new NodeOperationError(this.getNode(), 'Send At is required', { itemIndex: i });
	}
	const options = this.getNodeParameter('options', i, {}) as IDataObject;
	// Frozen into the record: the server replays it verbatim when the message fires.
	const method = await resolveSendMethod(
		this,
		(options.method as SendMethodOverride | undefined) ?? 'auto',
		cache,
	);

	const data = await blueBubblesApiCall.call(this, {
		method: 'POST',
		endpoint: '/message/schedule',
		body: {
			type: 'send-message',
			payload: { chatGuid, message: text, method },
			scheduledFor,
			schedule: { type: 'once' },
		},
		operation: 'Could not schedule the BlueBubbles message',
	});
	return toItems(asObject(data), i);
}

async function getMany(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const returnAll = this.getNodeParameter('returnAll', i, false) as boolean;
	const data = await blueBubblesApiCall.call(this, {
		method: 'GET',
		endpoint: '/message/schedule',
		operation: 'Could not list BlueBubbles scheduled messages',
	});
	const rows = Array.isArray(data) ? (data as IDataObject[]) : [];
	if (returnAll) return toItems(rows, i);
	const limit = Math.max(1, Math.floor(Number(this.getNodeParameter('limit', i, 50)) || 1));
	return toItems(rows.slice(0, limit), i);
}

async function remove(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const id = Number(this.getNodeParameter('scheduledMessageId', i));
	if (!Number.isInteger(id) || id < 1) {
		throw new NodeOperationError(
			this.getNode(),
			'Scheduled Message ID must be a positive whole number',
			{ itemIndex: i },
		);
	}
	await blueBubblesApiCall.call(this, {
		method: 'DELETE',
		endpoint: `/message/schedule/${id}`,
		operation: 'Could not delete the BlueBubbles scheduled message',
		hints: { 404: SCHEDULE_404_HINT },
	});
	return toItems({ success: true, id }, i);
}

/** Runs one Scheduled Message operation for one input item. */
export const execute: ResourceExecutor = async function (this, itemIndex, operation, cache) {
	switch (operation) {
		case 'create':
			return await create.call(this, itemIndex, cache);
		case 'getMany':
			return await getMany.call(this, itemIndex);
		case 'delete':
			return await remove.call(this, itemIndex);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for scheduled messages`,
				{ itemIndex },
			);
	}
};
