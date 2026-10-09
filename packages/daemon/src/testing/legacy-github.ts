/**
 * Test adapter: answers Pilot's batched GitHub GraphQL requests by calling a runner that emulates the
 * per-PR gh commands Pilot used before batching (gh pr list, gh pr view and the review-thread query).
 * Lets behavioral tests describe GitHub state per head or PR while exercising the real batched queries,
 * response parsing and validation.
 */
import type { Runner } from "../workspaces.ts";

const fields = "number,url,title,state,isDraft,headRefName,isCrossRepository,createdAt,mergedAt";

function variables(args: string[]): Map<string, string> {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i++)
		if (args[i] === "-f" || args[i] === "-F") {
			const [name, ...rest] = args[++i]!.split("=");
			values.set(name!, rest.join("="));
		}
	return values;
}

function rows(output: string): unknown[] {
	const parsed: unknown = JSON.parse(output);
	if (!Array.isArray(parsed)) throw new Error("Invalid GitHub pull request response");
	return parsed;
}

export function legacyGitHub(legacy: Runner): Runner {
	return async (file, args, cwd, timeoutMs, signal, env) => {
		const call = (next: string[]) => legacy("gh", next, cwd, timeoutMs, signal, env);
		if (file !== "gh" || args[0] !== "api" || args[1] !== "graphql")
			return legacy(file, args, cwd, timeoutMs, signal, env);
		const vars = variables(args);
		const query = vars.get("query") ?? "";
		const batch = query.startsWith("query PilotPullRequests(");
		const health = query.startsWith("query PilotPullRequestHealth(");
		if (!batch && !health) return legacy(file, args, cwd, timeoutMs, signal, env);
		const host = args.find((arg) => arg.startsWith("--hostname="))!.slice("--hostname=".length);
		const owner = vars.get("owner")!;
		const name = vars.get("name")!;
		const repo = `--repo=${host}/${owner}/${name}`;
		const repository: Record<string, unknown> = {};
		for (const [key, value] of vars) {
			if (batch && /^h\d+$/.test(key)) {
				const index = key.slice(1);
				const list = (state: string) =>
					call(["pr", "list", `--head=${value}`, repo, `--state=${state}`, "--limit=100", `--json=${fields}`]);
				const open = rows(await list("open"));
				repository[`o${index}`] = { nodes: open };
				// Like gh before batching, read history only when no same-repository PR is open.
				const active = open.some((row) => {
					const pr = row as { headRefName?: unknown; isCrossRepository?: unknown; state?: unknown } | null;
					return pr?.headRefName === value && pr.isCrossRepository === false && pr.state === "OPEN";
				});
				repository[`a${index}`] = { nodes: active ? [] : rows(await list("all")) };
			} else if (batch && /^n\d+$/.test(key)) {
				repository[key] = JSON.parse(await call(["pr", "view", value, repo, `--json=${fields}`]));
			} else if (health && /^p\d+$/.test(key)) {
				const view = JSON.parse(
					await call(["pr", "view", value, repo, "--json=statusCheckRollup,mergeable,state,headRefName"]),
				) as Record<string, unknown>;
				let reviewThreads: unknown = { nodes: [], pageInfo: { hasNextPage: false } };
				if (view.state === "OPEN") {
					const response = JSON.parse(
						await call([
							"api",
							"graphql",
							`--hostname=${host}`,
							"-f",
							"query=reviewThreads",
							"-f",
							`owner=${owner}`,
							"-f",
							`name=${name}`,
							"-F",
							`number=${value}`,
						]),
					) as { data?: { repository?: { pullRequest?: { reviewThreads?: unknown } } }; errors?: unknown };
					if (response.errors !== undefined) throw new Error("Invalid GitHub pull request health response");
					reviewThreads = response.data?.repository?.pullRequest?.reviewThreads;
				}
				const rollup = view.statusCheckRollup;
				repository[key] = {
					number: Number(value),
					state: view.state,
					headRefName: view.headRefName,
					mergeable: view.mergeable,
					commits: {
						nodes: [
							{
								commit: {
									statusCheckRollup: Array.isArray(rollup)
										? {
												contexts: {
													nodes: rollup.map((check: Record<string, unknown>) =>
														check.conclusion === "" ? { ...check, conclusion: null } : check,
													),
													pageInfo: { hasNextPage: false },
												},
											}
										: rollup,
								},
							},
						],
					},
					reviewThreads,
				};
			}
		}
		return JSON.stringify({
			data: { rateLimit: { remaining: 5_000, resetAt: "2100-01-01T00:00:00Z" }, repository },
		});
	};
}
