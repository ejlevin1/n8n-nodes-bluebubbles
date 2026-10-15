import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesExecutionCache, SendMethodOverride } from '../GenericFunctions';
import {
	blueBubblesApiCall,
	blueBubblesBinaryRequest,
	blueBubblesFormRequest,
	resolveSendMethod,
	tempGuid,
} from '../GenericFunctions';
import { asObject, ATTACHMENT_404_HINT, encodeGuid, requireString } from './messageHelpers';
import type { ResourceExecutor } from './shared';
import { getChatGuid, toItems } from './shared';

async function getMetadata(ctx: IExecuteFunctions, attachmentGuid: string): Promise<IDataObject> {
	const data = await blueBubblesApiCall.call(ctx, {
		method: 'GET',
		endpoint: `/attachment/${encodeGuid(attachmentGuid)}`,
		operation: 'Could not get the BlueBubbles attachment',
		hints: { 404: ATTACHMENT_404_HINT },
	});
	return asObject(data, {});
}

async function get(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const attachmentGuid = requireString(this, 'attachmentGuid', i, 'Attachment GUID');
	return toItems(await getMetadata(this, attachmentGuid), i);
}

async function download(this: IExecuteFunctions, i: number): Promise<INodeExecutionData[]> {
	const attachmentGuid = requireString(this, 'attachmentGuid', i, 'Attachment GUID');
	const binaryPropertyName = requireString(
		this,
		'binaryPropertyName',
		i,
		'Put Output File in Field',
	);

	const { buffer, headers } = await blueBubblesBinaryRequest.call(this, {
		method: 'GET',
		endpoint: `/attachment/${encodeGuid(attachmentGuid)}/download`,
		qs: { original: 'true' },
		operation: 'Could not download the BlueBubbles attachment',
		hints: { 404: ATTACHMENT_404_HINT },
	});
	const metadata = await getMetadata(this, attachmentGuid);

	const fileName =
		typeof metadata.transferName === 'string' && metadata.transferName
			? metadata.transferName
			: attachmentGuid;
	const headerType = typeof headers['content-type'] === 'string' ? headers['content-type'] : '';
	const mimeType =
		typeof metadata.mimeType === 'string' && metadata.mimeType
			? metadata.mimeType
			: headerType.split(';')[0].trim() || 'application/octet-stream';

	const binaryData = await this.helpers.prepareBinaryData(buffer, fileName, mimeType);
	return [
		{
			json: metadata,
			binary: { [binaryPropertyName]: binaryData },
			pairedItem: { item: i },
		},
	];
}

async function send(
	this: IExecuteFunctions,
	i: number,
	cache: BlueBubblesExecutionCache,
): Promise<INodeExecutionData[]> {
	const chatGuid = getChatGuid(this, i);
	const binaryPropertyName = requireString(this, 'binaryPropertyName', i, 'Input Binary Field');
	const options = this.getNodeParameter('options', i, {}) as IDataObject;

	const binary = this.helpers.assertBinaryData(i, binaryPropertyName);
	const buffer = await this.helpers.getBinaryDataBuffer(i, binaryPropertyName);
	const fileName =
		String(options.fileName ?? '').trim() ||
		binary.fileName ||
		`attachment${binary.fileExtension ? `.${binary.fileExtension}` : ''}`;
	const mimeType = binary.mimeType || 'application/octet-stream';
	const method = await resolveSendMethod(
		this,
		(options.method as SendMethodOverride | undefined) ?? 'auto',
		cache,
	);

	const data = await blueBubblesFormRequest.call(this, {
		method: 'POST',
		endpoint: '/message/attachment',
		fields: { chatGuid, tempGuid: tempGuid(), method, name: fileName },
		files: [{ fieldName: 'attachment', buffer, fileName, mimeType }],
		operation: 'Could not send the BlueBubbles attachment',
	});
	return toItems(asObject(data), i);
}

/** Runs one Attachment operation for one input item. */
export const execute: ResourceExecutor = async function (this, itemIndex, operation, cache) {
	switch (operation) {
		case 'get':
			return await get.call(this, itemIndex);
		case 'download':
			return await download.call(this, itemIndex);
		case 'send':
			return await send.call(this, itemIndex, cache);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for attachments`,
				{ itemIndex },
			);
	}
};
