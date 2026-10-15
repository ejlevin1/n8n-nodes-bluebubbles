import type { IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

import { blueBubblesApiCall } from '../GenericFunctions';
import { MAX_PAGE_SIZE } from './shared';

/** Hint for message routes that answer 404. */
export const MESSAGE_404_HINT = 'Message does not exist; check the message GUID';

/** Hint for attachment routes that answer 404. */
export const ATTACHMENT_404_HINT = 'Attachment does not exist; check the attachment GUID';

/**
 * Batch size for the message -> chat lookup. Well under SQLite's 999-variable
 * ceiling once the `IN (:...guids)` spread expands.
 */
export const GUID_CHUNK_SIZE = 400;

/** Encode a GUID for use as one URL path segment. */
export function encodeGuid(guid: string): string {
	return encodeURIComponent(guid.trim());
}

/** Wrap a non-object API result so it can be an item's `json`. */
export function asObject(data: unknown, fallback: IDataObject = { success: true }): IDataObject {
	if (data === undefined || data === null || data === '') return fallback;
	if (typeof data === 'object' && !Array.isArray(data)) return data as IDataObject;
	return { result: data as IDataObject[string] };
}

/** Read a non-empty, trimmed string parameter or throw a user-facing error. */
export function requireString(
	ctx: IExecuteFunctions,
	name: string,
	itemIndex: number,
	label: string,
): string {
	const value = String(ctx.getNodeParameter(name, itemIndex, '') ?? '').trim();
	if (!value) {
		throw new NodeOperationError(ctx.getNode(), `${label} is required`, { itemIndex });
	}
	return value;
}

// --------------------------------------------------------------------------
// Timestamps
// --------------------------------------------------------------------------

/** ISO date or date-time without a zone designator ("naive", i.e. wall-clock time). */
const NAIVE_DATE_TIME =
	/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/;

/** Offset of `timeZone` from UTC at the instant `utcMs`, in ms. */
function zoneOffsetMs(utcMs: number, timeZone: string): number {
	const formatter = new Intl.DateTimeFormat('en-US', {
		timeZone,
		hourCycle: 'h23',
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});
	const parts: Record<string, number> = {};
	for (const part of formatter.formatToParts(new Date(utcMs))) {
		if (part.type !== 'literal') parts[part.type] = Number(part.value);
	}
	const asUtc = Date.UTC(
		parts.year,
		parts.month - 1,
		parts.day,
		parts.hour,
		parts.minute,
		parts.second,
	);
	return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** Interpret a wall-clock time in `timeZone` and return epoch ms. */
function wallClockToMs(match: RegExpExecArray, timeZone: string): number {
	const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '0'] = match;
	const naiveUtc = Date.UTC(
		Number(y),
		Number(mo) - 1,
		Number(d),
		Number(h),
		Number(mi),
		Number(s),
		Number(frac.padEnd(3, '0')),
	);
	try {
		const first = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
		return naiveUtc - zoneOffsetMs(first, timeZone);
	} catch {
		// Unknown zone name: fall back to UTC.
		return naiveUtc;
	}
}

/**
 * Convert an n8n date parameter to epoch milliseconds.
 *
 * Accepts epoch milliseconds (number or digit string), Luxon `DateTime` / `Date`
 * objects from expressions, ISO strings with a zone (`Z` / `+02:00`) and n8n's
 * zone-less `dateTime` strings, which are read in the workflow's timezone.
 *
 * @returns `undefined` for an empty value
 * @throws NodeOperationError when the value cannot be parsed
 */
export function toTimestampMs(
	ctx: IExecuteFunctions,
	value: unknown,
	itemIndex: number,
	label: string,
): number | undefined {
	if (value === undefined || value === null || value === '') return undefined;
	if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
	if (value instanceof Date && !Number.isNaN(value.getTime())) return value.getTime();
	if (
		typeof value === 'object' &&
		typeof (value as { toMillis?: unknown }).toMillis === 'function'
	) {
		const ms = (value as { toMillis: () => number }).toMillis();
		if (Number.isFinite(ms)) return Math.trunc(ms);
	}

	const text = String(value).trim();
	if (/^\d+$/.test(text)) return Number(text);

	const naive = NAIVE_DATE_TIME.exec(text);
	if (naive) return wallClockToMs(naive, ctx.getTimezone());

	const parsed = Date.parse(text);
	if (Number.isNaN(parsed)) {
		throw new NodeOperationError(ctx.getNode(), `${label} is not a valid date`, {
			itemIndex,
			description: `Use an ISO date such as 2026-01-31T09:00:00 or epoch milliseconds. Got "${text}".`,
		});
	}
	return parsed;
}

// --------------------------------------------------------------------------
// Pagination
// --------------------------------------------------------------------------

/**
 * Collect rows from an offset-paginated route.
 *
 * Pages are at most {@link MAX_PAGE_SIZE} rows (more is a 400) and never 0
 * (also a 400). Paging stops at the first short page, or once `limit` rows
 * were fetched when `returnAll` is off.
 */
export async function collectPages(
	fetchPage: (offset: number, pageSize: number) => Promise<unknown>,
	returnAll: boolean,
	limit: number,
): Promise<IDataObject[]> {
	const wanted = Math.max(1, Math.floor(Number(limit) || 1));
	const rows: IDataObject[] = [];
	let offset = 0;
	for (;;) {
		const pageSize = returnAll ? MAX_PAGE_SIZE : Math.min(MAX_PAGE_SIZE, wanted - rows.length);
		if (pageSize <= 0) break;
		const page = await fetchPage(offset, pageSize);
		const pageRows = Array.isArray(page) ? (page as IDataObject[]) : [];
		rows.push(...pageRows);
		offset += pageRows.length;
		if (pageRows.length < pageSize) break;
	}
	return returnAll ? rows : rows.slice(0, wanted);
}

// --------------------------------------------------------------------------
// Message search
// --------------------------------------------------------------------------

/** One clause of a `/message/query` `where` array. */
export interface WhereClause extends IDataObject {
	statement: string;
	args: IDataObject;
}

/** Escape `\`, `%` and `_` for a LIKE pattern used with `ESCAPE '\'`. */
export function escapeLike(term: string): string {
	return term.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

/**
 * How Search looks for text:
 * - `spotlight`: one `message.text` clause, which BlueBubbles Server reroutes to
 *   Spotlight via the Private API helper on macOS 13+ (plain SQL otherwise).
 * - `database`: plain SQL `LIKE` on `message.text`, never rerouted.
 * - `auto`: Spotlight with a bounded timeout, then the database on a timeout or 5xx.
 */
export type SearchMethod = 'auto' | 'spotlight' | 'database';

/**
 * The text clause. The statement is concatenated into SQL verbatim, so the term
 * only ever goes into `args`. The bind name must stay the 3rd space-separated
 * token: on macOS 13+ with the Private API the server reroutes `message.text`
 * clauses to Spotlight and reads the bind name as `statement.split(" ")[2]`.
 */
export function likeClause(query: string): WhereClause {
	return {
		statement: "message.text LIKE :query ESCAPE '\\'",
		args: { query: `%${escapeLike(query)}%` },
	};
}

/**
 * Clause that only matches rows with a `message.text` value. Redundant next to
 * {@link likeClause} (`NULL LIKE ...` is never true) but it is what keeps the
 * search in SQLite: BlueBubbles Server only reroutes to Spotlight when exactly
 * ONE `where` statement contains `message.text`; with two it runs the query
 * against the database unchanged.
 */
export const TEXT_NOT_NULL_CLAUSE: Readonly<WhereClause> = {
	statement: 'message.text IS NOT NULL',
	args: {},
};

/**
 * The text clauses for a search method. `spotlight` (and `auto`'s first try) is
 * the single {@link likeClause} the server reroutes; `database` adds
 * {@link TEXT_NOT_NULL_CLAUSE} so the server keeps the plain SQL `LIKE`.
 */
export function textClauses(query: string, method: Exclude<SearchMethod, 'auto'>): WhereClause[] {
	if (!query) return [];
	if (method === 'spotlight') return [likeClause(query)];
	return [likeClause(query), { ...TEXT_NOT_NULL_CLAUSE, args: {} }];
}

/** Whether a From Address value means "messages I sent". */
export function isMe(address: string): boolean {
	return address.trim().toLowerCase() === 'me';
}

/**
 * The sender clause. `handle` names the *other* party even on outgoing
 * messages, so "me" goes through `message.is_from_me`.
 */
export function senderClauses(fromAddress: string | undefined): WhereClause[] {
	const address = (fromAddress ?? '').trim();
	if (!address) return [];
	if (isMe(address)) return [{ statement: 'message.is_from_me = :fromMe', args: { fromMe: 1 } }];
	return [{ statement: 'handle.id = :address', args: { address } }];
}

/** Client-side equivalent of {@link senderClauses} for routes without `where`. */
export function matchesSender(message: IDataObject, fromAddress: string | undefined): boolean {
	const address = (fromAddress ?? '').trim();
	if (!address) return true;
	if (isMe(address)) return Boolean(message.isFromMe);
	const handle = message.handle as IDataObject | null | undefined;
	return handle?.address === address;
}

/**
 * Map message GUID -> chats with a second `/message/query` pass, in chunks of
 * {@link GUID_CHUNK_SIZE}. Uses the TypeORM spread `IN (:...guids)` (a plain
 * `IN (:guids)` is a 500). Never call `with: ["chats"]` on the main query: that
 * join is INNER and drops messages without a chat row.
 */
export async function resolveMessageChats(
	ctx: IExecuteFunctions,
	messageGuids: string[],
): Promise<Map<string, IDataObject[]>> {
	const unique = [...new Set(messageGuids.filter((guid) => typeof guid === 'string' && guid))];
	const resolved = new Map<string, IDataObject[]>();
	if (unique.length === 0) return resolved;

	const chunks: string[][] = [];
	for (let i = 0; i < unique.length; i += GUID_CHUNK_SIZE) {
		chunks.push(unique.slice(i, i + GUID_CHUNK_SIZE));
	}
	const responses = await Promise.all(
		chunks.map(
			async (guids) =>
				await blueBubblesApiCall.call(ctx, {
					method: 'POST',
					endpoint: '/message/query',
					body: {
						limit: GUID_CHUNK_SIZE,
						offset: 0,
						sort: 'ASC',
						with: ['chat'],
						where: [{ statement: 'message.guid IN (:...guids)', args: { guids } }],
					},
					operation: 'Could not look up the chats of the found messages',
				}),
		),
	);

	for (const rows of responses) {
		for (const row of Array.isArray(rows) ? (rows as IDataObject[]) : []) {
			const guid = row?.guid;
			if (typeof guid !== 'string' || !guid) continue;
			let chats = row.chats as IDataObject[] | undefined | null;
			if (!Array.isArray(chats)) {
				const single = row.chat;
				chats = single && typeof single === 'object' ? [single as IDataObject] : [];
			}
			resolved.set(guid, chats);
		}
	}
	return resolved;
}
