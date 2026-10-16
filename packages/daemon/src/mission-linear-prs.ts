/** Event-driven, read-only checks. Never edits PRs, posts on GitHub or merges. */
import { linkedPullRequest, run } from "./github.ts";
import { closingIssueIds, type linearPrGuidance, ticketScope } from "./mission-linear-pr-guidance.ts";
import type { MissionStore } from "./missions.ts";
import type { Runner } from "./workspaces.ts";

export interface LinearPrText {
	title: string;
	body: string;
	branch: string;
	commits: string[];
	complete: boolean;
}

export async function readLinearPrText(
	url: string,
	cwd: string,
	signal: AbortSignal,
	runner: Runner = run,
): Promise<LinearPrText> {
	const { repo, number } = linkedPullRequest(url);
	const query =
		"query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){title body headRefName commits(first:100){pageInfo{hasNextPage} nodes{commit{message}}}}}}";
	const raw = JSON.parse(
		await runner(
			"gh",
			[
				"api",
				"graphql",
				"--hostname",
				repo.host,
				"-f",
				`query=${query}`,
				"-f",
				`owner=${repo.owner}`,
				"-f",
				`name=${repo.name}`,
				"-F",
				`number=${number}`,
			],
			cwd,
			20_000,
			signal,
		),
	);
	const pr = raw?.data?.repository?.pullRequest;
	if (
		raw.errors ||
		!pr ||
		typeof pr.title !== "string" ||
		typeof pr.body !== "string" ||
		typeof pr.headRefName !== "string" ||
		!Array.isArray(pr.commits?.nodes) ||
		pr.commits.nodes.length > 100 ||
		typeof pr.commits.pageInfo?.hasNextPage !== "boolean"
	)
		throw new Error("Invalid PR text response");
	const commits: string[] = [];
	let complete = !pr.commits.pageInfo.hasNextPage && pr.body.length <= 65_536;
	for (const node of pr.commits.nodes) {
		if (typeof node?.commit?.message !== "string") throw new Error("Invalid commit text");
		if (node.commit.message.length > 8000) complete = false;
		commits.push(node.commit.message.slice(0, 8000));
	}
	return {
		title: pr.title.slice(0, 1000),
		body: pr.body.slice(0, 65_536),
		branch: pr.headRefName.slice(0, 1000),
		commits,
		complete,
	};
}

type Guidance = Awaited<ReturnType<typeof linearPrGuidance>>;
type Read = (url: string, cwd: string, signal: AbortSignal) => Promise<LinearPrText>;

export class MissionLinearPrChecks {
	private readonly store: MissionStore;
	private readonly guidance: (missionId: string, taskId: string) => Promise<Guidance>;
	private readonly cwd: (projectId: string) => string | undefined;
	private readonly read: Read;
	private readonly pending = new Set<string>();
	private readonly checked = new Map<string, string>();
	private overflow = false;
	private stopped = false;
	private timer?: ReturnType<typeof setTimeout>;
	private running?: Promise<void>;
	private unsubscribe?: () => void;
	private readonly controller = new AbortController();
	constructor(
		store: MissionStore,
		guidance: (missionId: string, taskId: string) => Promise<Guidance>,
		cwd: (projectId: string) => string | undefined,
		read: Read = readLinearPrText,
	) {
		this.store = store;
		this.guidance = guidance;
		this.cwd = cwd;
		this.read = read;
	}
	start(): void {
		if (this.unsubscribe || this.stopped) return;
		this.unsubscribe = this.store.onChange((id) => this.enqueue(id));
		for (const mission of this.store.pullRequestMissions()) this.enqueue(mission.id);
	}
	private enqueue(id: string): void {
		if (this.stopped) return;
		if (this.pending.size < 256) this.pending.add(id);
		else this.overflow = true;
		if (this.running || this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = undefined;
			void this.flush();
		}, 200);
		this.timer.unref();
	}
	/** Bounded one-at-a-time network work, coalesced by mission and existing PR observation. */
	flush(): Promise<void> {
		if (this.running) return this.running;
		clearTimeout(this.timer);
		this.timer = undefined;
		this.running = this.drain()
			.catch((error) =>
				console.warn(`pilotd: Linear PR check failed: ${error instanceof Error ? error.name : "error"}`),
			)
			.finally(() => {
				this.running = undefined;
			});
		return this.running;
	}
	private async drain(): Promise<void> {
		while (!this.stopped && (this.pending.size || this.overflow)) {
			const batch = this.overflow
				? this.store.pullRequestMissions().map((mission) => mission.id)
				: [...this.pending];
			this.pending.clear();
			this.overflow = false;
			for (const id of batch) {
				if (this.stopped) return;
				await this.check(id);
			}
		}
	}
	private async check(id: string): Promise<void> {
		if (!this.store.get(id)) return;
		const detail = this.store.linearPrScope(id);
		if (detail.mission.status !== "active") return;
		const cwd = this.cwd(detail.mission.projectId);
		if (!cwd) return;
		const scope = ticketScope(detail);
		const linked = new Set(detail.resources.filter((ref) => ref.kind === "linear.issue").map((ref) => ref.taskId));
		const hasManaged = detail.resources.some((ref) => ref.linearRole === "managed");
		for (const ref of detail.resources) {
			if (this.stopped) return;
			if (!ref.taskId || ref.kind !== "github.pr" || ref.relationship !== "ownership") continue;
			if (
				(!linked.has(ref.taskId) && !hasManaged) ||
				(ref.pullRequest && ["merged", "closed"].includes(ref.pullRequest.state))
			) {
				this.store.reportLinearPrSafety(id, ref.id, ref.url, []);
				continue;
			}
			const key = `${id}:${ref.id}`;
			const version = `${scope}:${ref.pullRequest?.checkedAt ?? 0}`;
			if (this.checked.get(key) === version) continue;
			this.checked.delete(key);
			this.checked.set(key, version);
			if (this.checked.size > 2000) this.checked.delete(this.checked.keys().next().value!);
			const warnings: string[] = [];
			try {
				const text = await this.read(ref.url, cwd, this.controller.signal);
				const guidance = await this.guidance(id, ref.taskId);
				const prIds = closingIssueIds(`${text.title}\n${text.body}`);
				const commitIds = closingIssueIds(text.commits.join("\n"));
				if (!text.complete)
					warnings.push("PR text/commit coverage is incomplete; inspect all commits manually before merging");
				for (const ticket of guidance.tickets) {
					const prCloses = !!ticket.identifier && prIds.has(ticket.identifier.toUpperCase());
					const commitCloses = !!ticket.identifier && commitIds.has(ticket.identifier.toUpperCase());
					if (!ticket.closingAllowed && (prCloses || commitCloses))
						warnings.push(
							`${ticket.identifier}: premature closing directive (${ticket.reason}). Use ${ticket.directive}; correct the PR/commits explicitly`,
						);
					if (ticket.closingAllowed && !prCloses)
						warnings.push(
							`${ticket.identifier}: final contributor should include ${ticket.directive} in its PR title or description`,
						);
					if (
						!ticket.closingAllowed &&
						ticket.identifier &&
						new RegExp(
							`(?:^|[^a-z0-9])${ticket.identifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
							"i",
						).test(text.branch)
					)
						warnings.push(
							`${ticket.identifier}: branch-name linking may trigger Linear automation independently; use a branch without this ticket ID or review integration settings`,
						);
				}
			} catch {
				warnings.push(
					"Could not verify PR text or live ticket safeguards; retry after GitHub/Linear reconnects before merging",
				);
			}
			if (this.stopped || !this.store.get(id)) return;
			if (ticketScope(this.store.linearPrScope(id)) !== scope) {
				this.enqueue(id);
				continue;
			}
			this.store.reportLinearPrSafety(id, ref.id, ref.url, warnings);
			await this.store.whenDurable();
		}
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe?.();
		clearTimeout(this.timer);
		this.controller.abort();
		await this.running;
		this.pending.clear();
		this.checked.clear();
	}
}
