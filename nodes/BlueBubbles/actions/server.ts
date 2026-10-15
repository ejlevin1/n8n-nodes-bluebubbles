import type { IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import type { BlueBubblesExecutionCache } from '../GenericFunctions';
import { getServerInfo } from '../GenericFunctions';
import { call, isRecord } from './helpers';
import type { ResourceExecutor } from './shared';
import { toItems } from './shared';

/** Timeout for `/icloud/account`, answered by the helper rather than the server. */
const ICLOUD_TIMEOUT_MS = 8000;

/** The trimmed string, or undefined when it is not a non-blank string. */
function trimmed(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Ordered aliases from an `/icloud/account` payload: `active_alias` first, then
 * `aliases[].Alias`, skipping entries with `IsUserVisible === false`.
 */
function accountAliases(account: unknown): string[] {
	if (!isRecord(account)) return [];
	const out: string[] = [];
	const active = trimmed(account.active_alias);
	if (active) out.push(active);
	const aliases = Array.isArray(account.aliases) ? account.aliases : [];
	for (const entry of aliases) {
		if (!isRecord(entry) || entry.IsUserVisible === false) continue;
		const alias = trimmed(entry.Alias);
		if (alias) out.push(alias);
	}
	return out;
}

/** Remove case-insensitive duplicates, keeping the first spelling and the order. */
function dedupe(addresses: string[]): string[] {
	const seen = new Set<string>();
	return addresses.filter((address) => {
		const key = address.toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * The addresses of the Apple account signed in on the Mac (port of the
 * reference `_resolve_identity`). The iCloud lookup is best-effort and only
 * attempted when `/server/info` reports the Private API.
 */
async function getMyAddresses(
	ctx: IExecuteFunctions,
	itemIndex: number,
	cache: BlueBubblesExecutionCache,
): Promise<IDataObject> {
	const info = await getServerInfo(ctx, cache);

	let aliases: string[] = [];
	let name: string | null = null;
	let source = 'server_info';
	if (info.private_api) {
		try {
			const account = await call<unknown>(ctx, {
				method: 'GET',
				endpoint: '/icloud/account',
				operation: 'Could not read the iCloud account',
				timeout: ICLOUD_TIMEOUT_MS,
			});
			aliases = accountAliases(account);
			if (isRecord(account)) name = trimmed(account.account_name) ?? null;
			if (aliases.length > 0) source = 'icloud_account';
		} catch (error) {
			ctx.logger.debug(
				'BlueBubbles: /icloud/account failed; using the addresses from /server/info',
				{ error: (error as Error).message },
			);
		}
	}

	const detected = [info.detected_imessage, info.detected_icloud]
		.map(trimmed)
		.filter((address): address is string => address !== undefined);
	const addresses = dedupe([...aliases, ...detected]);
	if (addresses.length === 0) {
		throw new NodeOperationError(ctx.getNode(), 'Could not determine your addresses', {
			itemIndex,
			description:
				'BlueBubbles Server did not report a detected iMessage or iCloud address, and the iCloud account (Private API) returned none.',
		});
	}
	return { address: addresses[0], addresses, name, source };
}

export const execute: ResourceExecutor = async function (
	this: IExecuteFunctions,
	itemIndex: number,
	operation: string,
	cache,
): Promise<INodeExecutionData[]> {
	switch (operation) {
		case 'ping': {
			const data = await call<unknown>(this, {
				method: 'GET',
				endpoint: '/ping',
				operation: 'Could not ping the BlueBubbles server',
			});
			return toItems(isRecord(data) ? data : { message: data ?? 'pong' }, itemIndex);
		}
		case 'getInfo': {
			const data = await call<unknown>(this, {
				method: 'GET',
				endpoint: '/server/info',
				operation: 'Could not read BlueBubbles server info',
			});
			return toItems(isRecord(data) ? data : {}, itemIndex);
		}
		case 'getMyAddresses':
			return toItems(await getMyAddresses(this, itemIndex, cache), itemIndex);
		default:
			throw new NodeOperationError(
				this.getNode(),
				`The operation "${operation}" is not supported for the server`,
				{ itemIndex },
			);
	}
};
