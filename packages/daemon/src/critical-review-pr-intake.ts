/** Disabled, host-only read seam. No gh/auth discovery, URL fetch, or chat PR binding. */
export interface ReviewPRRepository {
	id: string;
	owner: string;
	name: string;
}
export interface ReviewPRIdentity {
	host: string;
	account: { id: string; login: string };
	repository: ReviewPRRepository;
	pr: { id: string; number: number };
}
export interface ReviewPRSnapshot extends ReviewPRIdentity {
	head: { oid: string; repository: ReviewPRRepository; ref: string };
	/** Current target-ref tip from the same authenticated observation, NOT GitHub's historical baseRefOid.
	 * Deleted/unreadable/ambiguous refs must be null/unavailable, never a default-branch substitute.
	 */
	base: { oid: string; repository: ReviewPRRepository; ref: string };
}
export type ReviewGitObjectType = "commit" | "tree" | "blob";
export interface ReviewPRReadRequest {
	identity: ReviewPRIdentity;
	signal: AbortSignal;
	maxBytes: number;
}
/** Trusted acquisition adapter, not a model tool. Only synthetic adapters exist today.
 * Each response is bounded by maxBytes at transport level; account/host must match the
 * identity on EVERY read. Object bytes are raw Git payloads, not archives/packs or scripts.
 */
export interface ReviewPRReader {
	readPullRequest(request: ReviewPRReadRequest): Promise<unknown>;
	readObject(
		request: ReviewPRReadRequest & {
			repository: ReviewPRRepository;
			oid: string;
			type: ReviewGitObjectType;
		},
	): Promise<{ host: string; accountId: string; repositoryId: string; type: ReviewGitObjectType; bytes: Uint8Array }>;
}
export class ReviewPRCaptureError extends Error {
	readonly code: "identity" | "base" | "object" | "ancestry" | "quota" | "cancelled" | "timeout" | "changed" | "busy";
	constructor(
		code: "identity" | "base" | "object" | "ancestry" | "quota" | "cancelled" | "timeout" | "changed" | "busy",
	) {
		super(`PR capture unavailable: ${code}`);
		this.code = code;
	}
}
export const reviewGitOID = /^[a-f0-9]{40}$/;
const fail = (code: "identity" | "base" = "identity"): never => {
	throw new ReviewPRCaptureError(code);
};
function record(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
	return value as Record<string, unknown>;
}
function id(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_=-]{1,128}$/.test(value)) return fail();
	return value;
}
function name(value: unknown): string {
	if (typeof value !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/.test(value)) return fail();
	return value.toLowerCase();
}
function repository(value: unknown): ReviewPRRepository {
	const v = record(value);
	return { id: id(v.id), owner: name(v.owner), name: name(v.name) };
}
export function canonicalReviewPRIdentity(value: unknown): ReviewPRIdentity {
	const v = record(value),
		account = record(v.account),
		pr = record(v.pr);
	if (
		typeof v.host !== "string" ||
		!/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(v.host) ||
		v.host.includes("..")
	)
		return fail();
	if (!Number.isSafeInteger(pr.number) || (pr.number as number) < 1) return fail();
	return {
		host: v.host.toLowerCase(),
		account: { id: id(account.id), login: name(account.login) },
		repository: repository(v.repository),
		pr: { id: id(pr.id), number: pr.number as number },
	};
}
export function sameReviewRepository(a: ReviewPRRepository, b: ReviewPRRepository): boolean {
	return a.id === b.id && a.owner === b.owner && a.name === b.name;
}
export function pinReviewPR(expected: ReviewPRIdentity, response: unknown): ReviewPRSnapshot {
	const actual = canonicalReviewPRIdentity(response);
	if (
		actual.host !== expected.host ||
		actual.account.id !== expected.account.id ||
		actual.account.login !== expected.account.login ||
		!sameReviewRepository(actual.repository, expected.repository) ||
		actual.pr.id !== expected.pr.id ||
		actual.pr.number !== expected.pr.number
	)
		return fail();
	const v = record(response);
	const endpoint = (value: unknown, base: boolean) => {
		if (!value || Array.isArray(value)) return fail(base ? "base" : "identity");
		const e = record(value);
		if (
			typeof e.oid !== "string" ||
			!reviewGitOID.test(e.oid) ||
			typeof e.ref !== "string" ||
			e.ref.length > 1024 ||
			!e.ref ||
			/[\x00-\x20\x7f~^:?*[\\]/.test(e.ref) ||
			e.ref.includes("..") ||
			e.ref.startsWith("-")
		)
			return fail(base ? "base" : "identity");
		const repo = repository(e.repository);
		if (base && !sameReviewRepository(repo, actual.repository)) return fail("base");
		return { oid: e.oid, ref: e.ref, repository: repo };
	};
	return { ...actual, head: endpoint(v.head, false), base: endpoint(v.base, true) };
}
