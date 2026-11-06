/** On-demand host reads. No polling, mutation, cached-green fallback or delivery authority. */
import { graphql, type RateLimits } from "./github.ts";
import { linkedPullRequest } from "./github-url.ts";
import { deliveryDigest } from "./mission-delivery-evidence.ts";
import type { Runner } from "./workspaces.ts";

const maxPages = 10;
const oidPattern = /^[a-f0-9]{40}$/;
function object(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Incomplete GitHub observation");
	return value as Record<string, unknown>;
}
function oid(value: unknown): string {
	if (typeof value !== "string" || !oidPattern.test(value)) throw new Error("Missing exact GitHub revision");
	return value;
}
function string(value: unknown): string {
	if (typeof value !== "string" || !value || value.length > 2000) throw new Error("Missing GitHub identity");
	return value;
}
export interface CodePullRequestIdentity {
	url: string;
	repository: string;
	number: number;
	state: "OPEN" | "CLOSED" | "MERGED";
	head: string;
	base: string;
	baseRef: string;
	merge: string | null;
	defaultRef: string;
	target: string;
}
export interface CodeCheckContext {
	id: string;
	kind: "CheckRun" | "StatusContext";
	name: string;
	state: string;
	conclusion: string | null;
	appId: number | null;
}
export type CodePullRequestObservation =
	| { url: string; status: "unknown" | "stale"; reason: string }
	| {
			url: string;
			status: "observed";
			identity: CodePullRequestIdentity;
			observedAt: number;
			checks:
				| { status: "unknown"; reason: string }
				| {
						status: "observed";
						revision: string;
						contexts: CodeCheckContext[];
						configurationSha256: string;
						branchProtection: unknown;
				  };
			// Branch protection alone is not the complete applicable ruleset/check policy.
			configuredChecks: { status: "unknown"; reason: string };
			integration: {
				status: "observed" | "not-integrated" | "unknown";
				reason: string;
				revision: string | null;
				target: string;
			};
	  };

const identitySelection = `
	defaultBranchRef { name target { oid } }
	pullRequest(number: $number) {
		number url state headRefOid baseRefOid baseRefName mergeCommit { oid }
		baseRef { branchProtectionRule {
			requiresStatusChecks requiresStrictStatusChecks requiredStatusChecks { context app { databaseId } }
		} }
	}`;

/** All owned URLs, including terminal/stacked PRs, use exact number lookup. */
export async function observeCodePullRequest(
	url: string,
	cwd: string,
	runner: Runner,
	limits: RateLimits,
): Promise<CodePullRequestObservation> {
	try {
		const { repo, number } = linkedPullRequest(url);
		const deadline = Date.now() + 60_000;
		const read = async (selection: string, extra: ["-f" | "-F", string, string][] = []) => {
			if (Date.now() >= deadline) throw new Error("GitHub observation deadline");
			if (limits.blockedUntil(repo.host)) throw new Error("GitHub rate budget unavailable");
			return graphql(
				repo,
				`query($owner: String!, $name: String!, $number: Int!${extra.length ? ", $revision: String!, $cursor: String" : ""}) {
				rateLimit { remaining resetAt }
				repository(owner: $owner, name: $name) { ${selection} }
			}`,
				[["-F", "number", String(number)], ...extra],
				cwd,
				runner,
				limits,
			);
		};
		const parse = (repository: Record<string, unknown>) => {
			const pr = object(repository.pullRequest),
				target = object(repository.defaultBranchRef);
			const returned = linkedPullRequest(string(pr.url));
			if (
				returned.repo.identity.toLowerCase() !== repo.identity.toLowerCase() ||
				returned.number !== number ||
				pr.number !== number
			)
				throw new Error("Wrong GitHub pull request identity");
			if (!["OPEN", "CLOSED", "MERGED"].includes(String(pr.state))) throw new Error("Unknown PR state");
			const identity: CodePullRequestIdentity = {
				url,
				repository: repo.identity,
				number,
				state: pr.state as CodePullRequestIdentity["state"],
				head: oid(pr.headRefOid),
				base: oid(pr.baseRefOid),
				baseRef: string(pr.baseRefName),
				merge: pr.mergeCommit === null ? null : oid(object(pr.mergeCommit).oid),
				defaultRef: string(target.name),
				target: oid(object(target.target).oid),
			};
			if (identity.state === "MERGED" && !identity.merge) throw new Error("Missing merge revision");
			// Deleted stack branches cannot establish current branch protection. Preserve null, not empty requirements.
			if (!("baseRef" in pr)) throw new Error("Missing branch configuration observation");
			const branchProtection = pr.baseRef === null ? null : object(pr.baseRef).branchProtectionRule;
			if (branchProtection === undefined) throw new Error("Missing branch configuration observation");
			return { identity, branchProtection };
		};
		const before = parse(await read(identitySelection));
		const contexts: CodeCheckContext[] = [],
			seen = new Set<string>(),
			cursors = new Set<string>();
		let cursor: string | null = null;
		let checks: Extract<CodePullRequestObservation, { status: "observed" }>["checks"];
		try {
			for (let page = 0; ; page++) {
				if (page >= maxPages) throw new Error("GitHub check pagination limit");
				const variables: ["-f" | "-F", string, string][] = [["-f", "revision", before.identity.head]];
				// gh -F cursor=null produces a GraphQL null, not the string "null".
				variables.push(cursor === null ? ["-F", "cursor", "null"] : ["-f", "cursor", cursor]);
				const result = await read(
					`${identitySelection} object(expression: $revision) { ... on Commit { oid statusCheckRollup {
				contexts(first: 100, after: $cursor) { nodes {
					__typename ... on CheckRun { id name status conclusion checkSuite { app { databaseId } } }
					... on StatusContext { id context state }
				} pageInfo { hasNextPage endCursor } }
			} } }`,
					variables,
				);
				const commit = object(result.object);
				if (oid(commit.oid) !== before.identity.head) throw new Error("Checks returned for another revision");
				// A null rollup is missing observation, not proof of zero required checks.
				const connection = object(object(commit.statusCheckRollup).contexts),
					info = object(connection.pageInfo);
				if (
					!Array.isArray(connection.nodes) ||
					connection.nodes.length > 100 ||
					typeof info.hasNextPage !== "boolean"
				)
					throw new Error("Incomplete check page");
				for (const raw of connection.nodes) {
					const c = object(raw),
						id = string(c.id),
						kind = c.__typename;
					if (seen.has(id) || !["CheckRun", "StatusContext"].includes(String(kind)))
						throw new Error("Ambiguous check page");
					seen.add(id);
					const appId = kind === "CheckRun" ? object(object(c.checkSuite).app).databaseId : null;
					if (appId !== null && (!Number.isSafeInteger(appId) || Number(appId) < 1))
						throw new Error("Missing check producer");
					contexts.push({
						id,
						kind: kind as CodeCheckContext["kind"],
						name: string(kind === "CheckRun" ? c.name : c.context),
						state: string(kind === "CheckRun" ? c.status : c.state),
						conclusion: kind === "CheckRun" && c.conclusion !== null ? string(c.conclusion) : null,
						appId: appId as number | null,
					});
				}
				if (!info.hasNextPage) break;
				cursor = string(info.endCursor);
				if (cursors.has(cursor)) throw new Error("Repeated check cursor");
				cursors.add(cursor);
			}
			checks = {
				status: "observed",
				revision: before.identity.head,
				contexts,
				configurationSha256: deliveryDigest(before.branchProtection),
				branchProtection: before.branchProtection,
			};
		} catch {
			checks = { status: "unknown", reason: "Exact check pages unavailable, partial or denied" };
		}
		let integration: Extract<CodePullRequestObservation, { status: "observed" }>["integration"] = {
			status: "not-integrated",
			reason: "PR is not merged",
			revision: before.identity.merge,
			target: before.identity.target,
		};
		if (before.identity.state === "MERGED") {
			try {
				if (Date.now() >= deadline) throw new Error("GitHub observation deadline");
				if (limits.blockedUntil(repo.host)) throw new Error("GitHub rate budget unavailable");
				const path = `repos/${repo.owner}/${repo.name}/compare/${before.identity.merge}...${before.identity.target}?per_page=1`;
				const output = await runner("gh", ["api", `--hostname=${repo.host}`, path], cwd, 20_000);
				if (Buffer.byteLength(output) > 4 * 1024 * 1024) throw new Error("GitHub comparison too large");
				const compared = object(JSON.parse(output));
				if (oid(object(compared.base_commit).sha) !== before.identity.merge)
					throw new Error("Wrong integration base");
				if (!["ahead", "behind", "diverged", "identical"].includes(String(compared.status)))
					throw new Error("Unknown integration comparison");
				const mergeBase = oid(object(compared.merge_base_commit).sha);
				const contained =
					["ahead", "identical"].includes(String(compared.status)) && mergeBase === before.identity.merge;
				integration = {
					...integration,
					status: contained ? "observed" : "not-integrated",
					reason: contained
						? "Exact merge commit is contained in the observed default-branch revision"
						: "Merge commit is not contained in the observed default branch",
				};
			} catch {
				integration = { ...integration, status: "unknown", reason: "Exact target containment unavailable" };
			}
		}
		const after = parse(await read(identitySelection));
		if (deliveryDigest(before) !== deliveryDigest(after))
			return { url, status: "stale", reason: "PR, target or branch configuration changed during observation" };
		return {
			url,
			status: "observed",
			identity: before.identity,
			observedAt: Date.now(),
			checks,
			configuredChecks: {
				status: "unknown",
				reason:
					"Complete applicable check policy (including rulesets) and qualified local-check binding are unavailable; observed contexts are not a configured pass",
			},
			integration,
		};
	} catch {
		return { url, status: "unknown", reason: "Exact PR/check observation unavailable, incomplete or denied" };
	}
}
