/** Shared bounded, fingerprint-fenced pages for source hits and call edges. */
import type { ExplorationPage, ExplorationQuery } from "./exploration-contract.ts";

export function paginate<T>(
	page: { results: T[]; page: ExplorationPage["page"]; freshness: { fingerprint: string } },
	hits: T[],
	input: Pick<ExplorationQuery, "limit" | "cursor">,
): void {
	if (input.cursor) {
		let cursor: { fingerprint?: unknown; offset?: unknown };
		try {
			cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
		} catch {
			throw new Error("Invalid exploration cursor; restart without cursor");
		}
		if (
			!cursor ||
			cursor.fingerprint !== page.freshness.fingerprint ||
			!Number.isSafeInteger(cursor.offset) ||
			Number(cursor.offset) < 0 ||
			Number(cursor.offset) >= hits.length
		)
			throw new Error("Stale or invalid exploration cursor; source/query/workspace changed. Restart without cursor");
		page.page.offset = Number(cursor.offset);
	}
	page.page.retained = hits.length;
	for (const hit of hits.slice(page.page.offset, page.page.offset + (input.limit ?? 25))) {
		page.results.push(hit);
		if (Buffer.byteLength(JSON.stringify(page)) > 48 * 1024 - 512) {
			page.results.pop();
			break;
		}
	}
	page.page.returned = page.results.length;
	if (
		(hits.length > page.page.offset && !page.page.returned) ||
		Buffer.byteLength(JSON.stringify(page)) > 48 * 1024 - 512
	)
		throw new Error("Exploration metadata exceeds page budget; narrow path/query");
	const next = page.page.offset + page.page.returned;
	if (next < hits.length)
		page.page.nextCursor = Buffer.from(
			JSON.stringify({ fingerprint: page.freshness.fingerprint, offset: next }),
		).toString("base64url");
}
