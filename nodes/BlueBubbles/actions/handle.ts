import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { call, isRecord } from './helpers';
import type { ResourceExecutor } from './shared';
import { toItems } from './shared';

const SERVICES: Record<string, { path: string; label: string }> = {
	checkIMessage: { path: 'imessage', label: 'iMessage' },
	checkFaceTime: { path: 'facetime', label: 'FaceTime' },
};

export const execute: ResourceExecutor = async function (
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
): Promise<INodeExecutionData[]> {
	const service = SERVICES[operation];
	if (!service) {
		throw new NodeOperationError(
			this.getNode(),
			`The operation "${operation}" is not supported for handles`,
			{ itemIndex },
		);
	}
	const address = (this.getNodeParameter('address', itemIndex) as string).trim();
	if (!address) {
		throw new NodeOperationError(this.getNode(), 'Address is required', { itemIndex });
	}

	const data = await call<unknown>(this, {
		method: 'GET',
		endpoint: `/handle/availability/${service.path}`,
		qs: { address },
		operation: `Could not check ${service.label} availability`,
	});
	const result: IDataObject = isRecord(data) ? data : { available: data === true };
	return toItems({ address, ...result }, itemIndex);
};
