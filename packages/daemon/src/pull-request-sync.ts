/**
 * The daemon's single owner of GitHub PR state: discovery, mission-linked PRs and PR health for automatic
 * follow-ups. One scheduler decides what is due; a small fixed pool of jobs executes it.
 *
 * - Every session and linked PR is an entry with a due time. Events (an agent turn ending, a PR being
 *   created, a client opening a chat) mark an entry urgent; they never queue behind a full sweep.
 * - A job takes the most urgent entry plus every other entry of the same repository that is due soon,
 *   inspects their workspaces locally (git/jj), then asks GitHub once for all their heads and linked PRs,
 *   and once more for the health of PRs eligible for automatic follow-up.
 * - The cadence adapts to state: pending checks poll faster, settled PRs never poll, idle sessions without
 *   a PR back off, failures back off exponentially and a low GraphQL budget pauses the host.
 * - An entry never runs twice at once, so per-session results apply in order.
 */
import type { SessionPullRequest } from "@pilot/protocol";
import {
	type Candidate,
	githubRepository,
	type HealthRequest,
	type HealthResult,
	linkedPullRequest,
	lookupHealth,
	lookupPullRequests,
	type PullRequestProblems,
	RateLimits,
	type Repository,
	run,
	toSessionPullRequest,
} from "./github.ts";
import { discoverPullRequestProblems } from "./pull-request-health.ts";
import {
	checksState,
	inspectionHeads,
	inspectWorkspace,
	isTerminalPullRequest,
	type LinkedPullRequest,
	type LinkedPullRequestTracking,
	type PullRequestOptions,
	type PullRequestResult,
	type PullRequestSession,
	resolvePullRequests,
	sessionPullRequests,
	type WorkspaceInspection,
} from "./pull-requests.ts";
import type { Runner } from "./workspaces.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Entries per job. Bounded so one job cannot monopolize a worker. */
const maxBatch = 25;
/** Smaller batches for explicit refreshes, so their results are not delayed by many siblings. */
const maxUrgentBatch = 8;
/** Never poll more rarely than this while something is still open or undiscovered. */
const maxDelay = 30 * MINUTE;

export interface HealthCheck {
	pr: SessionPullRequest;
	problems: PullRequestProblems;
}

/** The host decides which fresh PRs may get an automatic follow-up, and gets their problems back. */
export interface HealthPlan<Context> {
	prs: SessionPullRequest[];
	/** Opaque to the sync, handed back with the results to detect stale lookups. */
	context: Context;
	/** Expected head branch for PRs without one. */
	branch?: string;
}

export interface PullRequestSyncHost<Session extends PullRequestSession, Context> {
	sessions(): Iterable<Session>;
	session(id: string): Session | undefined;
	/** Called serially per session, in completion order. Failures are logged and retried by cadence. */
	apply(
		session: Session,
		result: PullRequestResult,
		health?: { context: Context; checks: HealthCheck[] },
	): Promise<void>;
	/** PRs to check for problems, or undefined when no follow-up is possible now. */
	health?(session: Session, result: PullRequestResult): HealthPlan<Context> | undefined;
	linked?: LinkedPullRequestTracking;
}

interface Entry {
	key: string;
	/** Repository identity when known, used to batch entries into one GitHub request. */
	group?: string;
	dueAt: number;
	urgent: boolean;
	failures: number;
	running: boolean;
	checkedAt?: number;
	/** Settles when the next run that starts after it was requested completes. */
	next?: { promise: Promise<void>; resolve: () => void };
}

type Work<Session> =
	| { entry: Entry; kind: "session"; session: Session; inspection?: WorkspaceInspection; result?: PullRequestResult }
	| {
			entry: Entry;
			kind: "linked";
			target: LinkedPullRequest;
			repo: Repository;
			number: number;
			pr?: SessionPullRequest;
	  };

function sessionKey(id: string): string {
	return `session:${id}`;
}

function linkedKey(url: string): string {
	return `linked:${url}`;
}

function upstreamGroup(session: PullRequestSession): string | undefined {
	const upstream = session.workspace?.upstream;
	if (!upstream) return undefined;
	try {
		return githubRepository(upstream.trim()).identity;
	} catch {
		return undefined;
	}
}

function warn(message: string, error: unknown): void {
	console.warn(`pilotd: ${message}: ${error instanceof Error ? error.message : String(error)}`);
}

export class PullRequestSync<Session extends PullRequestSession, Context = unknown> {
	private readonly entries = new Map<string, Entry>();
	/** Linked PRs refreshed explicitly, for when the host no longer lists them. */
	private readonly linkedTargets = new Map<string, LinkedPullRequest>();
	private readonly jobs = new Set<Promise<void>>();
	private readonly limits = new RateLimits();
	private readonly runner: Runner;
	private readonly base: number;
	private readonly concurrency: number;
	private timer?: ReturnType<typeof setTimeout>;
	private pumpQueued = false;
	private reconcileAt = 0;
	private started = false;
	private stopped = false;
	private readonly host: PullRequestSyncHost<Session, Context>;

	constructor(host: PullRequestSyncHost<Session, Context>, options: PullRequestOptions = {}) {
		this.host = host;
		this.runner = options.runner ?? run;
		this.base = Math.max(1, options.intervalMs ?? MINUTE);
		this.concurrency = Math.max(1, options.concurrency ?? 3);
	}

	/** Check every known session and linked PR once, then keep them on their cadence. */
	start(): void {
		if (this.started || this.stopped) return;
		this.started = true;
		this.reconcileAt = 0;
		this.wake();
	}

	/** Explicit refresh after activity. Settles after a run that started after this call. */
	refresh(session: Session): Promise<void> {
		if (this.stopped || !session.workspace) return Promise.resolve();
		return this.request(this.entry(sessionKey(session.id), upstreamGroup(session)));
	}

	refreshLinked(target: LinkedPullRequest): Promise<void> {
		if (this.stopped || !this.host.linked || isTerminalPullRequest(target.pullRequest)) return Promise.resolve();
		let group: string;
		try {
			group = linkedPullRequest(target.url).repo.identity;
		} catch (error) {
			warn(`could not cache pull request for ${linkedKey(target.url)}`, error);
			return Promise.resolve();
		}
		this.linkedTargets.set(target.url, target);
		return this.request(this.entry(linkedKey(target.url), group));
	}

	/**
	 * A client is showing these sessions. Recheck them soon unless they were checked recently, so a
	 * visible PR badge is fresh without polling every hidden session as often.
	 */
	focus(ids: Iterable<string>, minAgeMs = 15_000): void {
		if (this.stopped) return;
		const now = Date.now();
		for (const id of ids) {
			const session = this.host.session(id);
			if (!session || !this.eligible(session)) continue;
			const entry = this.entry(sessionKey(id), upstreamGroup(session));
			if (entry.running || now - (entry.checkedAt ?? 0) < minAgeMs) continue;
			entry.urgent = true;
			entry.dueAt = Math.min(entry.dueAt, now);
		}
		this.wake();
	}

	/** Resolves once nothing is running or due now. For tests and orderly shutdown. */
	async settled(): Promise<void> {
		for (;;) {
			if (this.pumpQueued) await new Promise<void>((resolve) => queueMicrotask(resolve));
			else if (this.jobs.size) await Promise.allSettled([...this.jobs]);
			else return;
		}
	}

	/** Drain running jobs (their results persist), skip everything else. */
	async stop(): Promise<void> {
		this.stopped = true;
		clearTimeout(this.timer);
		await Promise.allSettled([...this.jobs]);
		for (const entry of this.entries.values()) this.settle(entry);
	}

	private entry(key: string, group?: string): Entry {
		let entry = this.entries.get(key);
		if (!entry) {
			entry = { key, dueAt: Number.POSITIVE_INFINITY, urgent: false, failures: 0, running: false };
			this.entries.set(key, entry);
		}
		if (group) entry.group = group;
		return entry;
	}

	private request(entry: Entry): Promise<void> {
		entry.urgent = true;
		entry.dueAt = Math.min(entry.dueAt, Date.now());
		if (!entry.next) {
			let resolve!: () => void;
			const promise = new Promise<void>((done) => {
				resolve = done;
			});
			entry.next = { promise, resolve };
		}
		this.wake();
		return entry.next.promise;
	}

	private settle(entry: Entry): void {
		entry.next?.resolve();
		delete entry.next;
	}

	/** Coalesce bursts of events into one scheduling pass. */
	private wake(): void {
		if (this.pumpQueued || this.stopped) return;
		this.pumpQueued = true;
		queueMicrotask(() => {
			this.pumpQueued = false;
			this.pump();
		});
	}

	/** Sessions worth polling at all. Explicit refreshes may still check the others. */
	private eligible(session: PullRequestSession): boolean {
		if (session.archivedAt !== undefined || !session.workspace || session.workspaceRecovery) return false;
		const prs = sessionPullRequests(session);
		return !prs.length || prs.some((pr) => !isTerminalPullRequest(pr));
	}

	/** Track new sessions and linked PRs, and forget settled or removed ones. Cheap, in-memory only. */
	private reconcile(now: number): void {
		this.reconcileAt = now + Math.max(this.base / 2, 10);
		const live = new Set<string>();
		for (const session of this.host.sessions()) {
			if (!this.eligible(session)) continue;
			const key = sessionKey(session.id);
			live.add(key);
			const entry = this.entry(key, upstreamGroup(session));
			if (entry.checkedAt === undefined && !entry.running && entry.dueAt === Number.POSITIVE_INFINITY)
				entry.dueAt = now;
		}
		for (const target of this.host.linked?.targets() ?? []) {
			if (isTerminalPullRequest(target.pullRequest)) continue;
			const key = linkedKey(target.url);
			if (live.has(key)) continue;
			live.add(key);
			let group: string;
			try {
				group = linkedPullRequest(target.url).repo.identity;
			} catch {
				continue;
			}
			const entry = this.entry(key, group);
			if (entry.checkedAt === undefined && !entry.running && entry.dueAt === Number.POSITIVE_INFINITY)
				entry.dueAt = now;
		}
		for (const [key, entry] of this.entries)
			if (!live.has(key) && !entry.running && !entry.next && !entry.urgent) {
				this.entries.delete(key);
				if (key.startsWith("linked:")) this.linkedTargets.delete(key.slice("linked:".length));
			}
	}

	private pump(): void {
		if (this.stopped) return;
		clearTimeout(this.timer);
		const now = Date.now();
		if (this.started && now >= this.reconcileAt) this.reconcile(now);
		while (this.jobs.size < this.concurrency) {
			const batch = this.take(now);
			if (!batch) break;
			const job: Promise<void> = this.run(batch)
				.catch((error: unknown) => warn("pull request sync failed", error))
				.finally(() => {
					this.jobs.delete(job);
					this.wake();
				});
			this.jobs.add(job);
		}
		let next = this.started ? this.reconcileAt : Number.POSITIVE_INFINITY;
		for (const entry of this.entries.values()) if (!entry.running) next = Math.min(next, entry.dueAt);
		if (Number.isFinite(next) && this.jobs.size < this.concurrency) {
			this.timer = setTimeout(() => this.pump(), Math.max(0, next - now));
			this.timer.unref?.();
		}
	}

	/** The most urgent due entry and its due-soon siblings in the same repository. */
	private take(now: number): Entry[] | undefined {
		let head: Entry | undefined;
		for (const entry of this.entries.values()) {
			if (entry.running || entry.dueAt > now) continue;
			// Background checks follow eligibility (archived, settled). Explicit requests always run.
			if (!entry.urgent && entry.key.startsWith("session:")) {
				const session = this.host.session(entry.key.slice("session:".length));
				if (!session || !this.eligible(session)) {
					entry.dueAt = Number.POSITIVE_INFINITY;
					continue;
				}
			}
			const host = entry.group?.split("/")[0];
			const blocked = host ? this.limits.blockedUntil(host, now) : 0;
			if (blocked > now) {
				entry.dueAt = blocked;
				continue;
			}
			if (
				!head ||
				Number(entry.urgent) - Number(head.urgent) > 0 ||
				(entry.urgent === head.urgent && entry.dueAt < head.dueAt)
			)
				head = entry;
		}
		if (!head) return undefined;
		const batch = [head];
		if (head.group) {
			// Piggyback siblings due within a quarter interval: one GitHub request instead of several.
			const soon = now + this.base / 4;
			const limit = head.urgent ? maxUrgentBatch : maxBatch;
			for (const entry of this.entries.values()) {
				if (batch.length >= limit) break;
				if (entry !== head && !entry.running && entry.group === head.group && entry.dueAt <= soon)
					batch.push(entry);
			}
		}
		for (const entry of batch) entry.running = true;
		return batch;
	}

	private async run(batch: Entry[]): Promise<void> {
		// Requests arriving from now on wait for the next run, not this one.
		const waiters = batch.map((entry) => {
			const next = entry.next;
			delete entry.next;
			entry.urgent = false;
			entry.dueAt = Number.POSITIVE_INFINITY;
			return next;
		});
		const outcomes = new Map<Entry, { failed: boolean; checks?: ReturnType<typeof checksState> }>();
		try {
			const work = this.resolve(batch);
			await this.execute(work, outcomes);
		} finally {
			const now = Date.now();
			for (const entry of batch) {
				entry.running = false;
				const outcome = outcomes.get(entry);
				if (outcome) {
					entry.checkedAt = now;
					entry.failures = outcome.failed ? entry.failures + 1 : 0;
				}
				// A request during the run already set an earlier due time.
				entry.dueAt = Math.min(entry.dueAt, now + this.delay(entry, outcome?.checks, now));
			}
			for (const waiter of waiters) waiter?.resolve();
		}
	}

	/** Look up each entry's current object. Removed sessions and settled linked PRs drop out. */
	private resolve(batch: Entry[]): Work<Session>[] {
		const linked = new Map<string, LinkedPullRequest>();
		if (batch.some((entry) => entry.key.startsWith("linked:")))
			for (const target of this.host.linked?.targets() ?? [])
				if (!linked.has(target.url)) linked.set(target.url, target);
		const work: Work<Session>[] = [];
		for (const entry of batch) {
			if (entry.key.startsWith("session:")) {
				const session = this.host.session(entry.key.slice("session:".length));
				if (session?.workspace) work.push({ entry, kind: "session", session });
			} else {
				const url = entry.key.slice("linked:".length);
				const target = linked.get(url) ?? this.linkedTargets.get(url);
				if (!target) continue;
				if (isTerminalPullRequest(target.pullRequest)) continue;
				try {
					const { repo, number } = linkedPullRequest(url);
					work.push({ entry, kind: "linked", target, repo, number });
				} catch (error) {
					warn(`could not cache pull request for ${entry.key}`, error);
				}
			}
		}
		return work;
	}

	private async execute(
		work: Work<Session>[],
		outcomes: Map<Entry, { failed: boolean; checks?: ReturnType<typeof checksState> }>,
	): Promise<void> {
		// 1. Local inspection, one session at a time: git and jj only.
		for (const item of work) {
			if (item.kind !== "session" || this.stopped) continue;
			try {
				item.inspection = await inspectWorkspace(item.session, this.runner);
			} catch (error) {
				item.result = {
					error: `Pull request lookup failed: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
			if (item.inspection?.repo) item.entry.group = item.inspection.repo.identity;
		}
		if (this.stopped) {
			// Shutdown before any GitHub request: nothing fresh to persist.
			return;
		}

		// 2. One discovery request per repository for every head and linked number.
		const repos = new Map<string, { repo: Repository; cwd: string; heads: Set<string>; numbers: Set<number> }>();
		const group = (repo: Repository, cwd: string) => {
			let entry = repos.get(repo.identity);
			if (!entry) {
				entry = { repo, cwd, heads: new Set(), numbers: new Set() };
				repos.set(repo.identity, entry);
			}
			return entry;
		};
		for (const item of work) {
			if (item.kind === "session") {
				const inspection = item.inspection;
				if (!inspection || inspection.result) continue;
				const target = group(inspection.repo!, item.session.cwd);
				for (const head of inspectionHeads(inspection)) target.heads.add(head);
			} else group(item.repo, item.target.cwd).numbers.add(item.number);
		}
		const found = new Map<string, Awaited<ReturnType<typeof lookupPullRequests>> | Error>();
		for (const [identity, request] of repos) {
			try {
				found.set(identity, await lookupPullRequests(request.repo, request, request.cwd, this.runner, this.limits));
			} catch (error) {
				found.set(identity, error instanceof Error ? error : new Error(String(error)));
			}
		}

		const now = Date.now();
		for (const item of work) {
			if (item.kind === "session") {
				if (!item.result && item.inspection) {
					const batch = item.inspection.repo ? found.get(item.inspection.repo.identity) : undefined;
					const heads: ReadonlyMap<string, Candidate | undefined> | Error =
						batch instanceof Error ? batch : (batch?.heads ?? new Map());
					item.result = resolvePullRequests(item.session, item.inspection, heads, now);
					outcomes.set(item.entry, {
						failed: heads instanceof Error,
						checks: heads instanceof Error ? undefined : checksState(item.inspection, heads),
					});
				} else outcomes.set(item.entry, { failed: false });
			} else {
				const batch = found.get(item.repo.identity);
				const error = batch instanceof Error ? batch : batch?.numberErrors.get(item.number);
				const pr = batch instanceof Error ? undefined : batch?.numbers.get(item.number);
				if (error || !pr) {
					warn(`could not cache pull request for ${item.entry.key}`, error ?? "missing result");
					outcomes.set(item.entry, { failed: true });
				} else {
					item.pr = toSessionPullRequest(pr, now);
					outcomes.set(item.entry, { failed: false, checks: pr.state === "OPEN" ? pr.checks : undefined });
				}
			}
		}

		for (const item of work)
			if (item.kind === "linked" && item.pr)
				try {
					this.host.linked?.apply(item.pr);
				} catch (error) {
					warn(`could not cache pull request for ${item.entry.key}`, error);
				}
		await this.applyResults(
			work.flatMap((item) =>
				item.kind === "session" && item.result
					? [{ key: item.entry.key, session: item.session, result: item.result, repo: item.inspection?.repo }]
					: [],
			),
		);
	}

	/**
	 * Look up the health of fresh PRs eligible for automatic follow-up, batched per repository, then apply
	 * each result serially. Results of a job that was running at shutdown still persist.
	 */
	private async applyResults(
		items: { key: string; session: Session; result: PullRequestResult; repo?: Repository }[],
	): Promise<void> {
		const plans = new Map<(typeof items)[number], HealthPlan<Context>>();
		const requests = new Map<string, { repo: Repository; cwd: string; prs: HealthRequest[] }>();
		for (const item of items) {
			if (item.result.error || !item.repo) continue;
			const plan = this.host.health?.(item.session, item.result);
			if (!plan?.prs.length) continue;
			plans.set(item, plan);
			let request = requests.get(item.repo.identity);
			if (!request) {
				request = { repo: item.repo, cwd: item.session.cwd, prs: [] };
				requests.set(item.repo.identity, request);
			}
			for (const pr of plan.prs) request.prs.push({ number: pr.number, branch: pr.branch ?? plan.branch });
		}
		const health = new Map<string, Map<number, HealthResult>>();
		for (const [identity, request] of requests) {
			if (this.stopped) break;
			health.set(identity, await lookupHealth(request.repo, request.prs, request.cwd, this.runner, this.limits));
		}
		for (const item of items) {
			try {
				const plan = plans.get(item);
				let checks: HealthCheck[] | undefined;
				if (plan && item.repo) {
					checks = [];
					const results = health.get(item.repo.identity);
					for (const pr of plan.prs) {
						const problems = await this.problems(item.session, pr, plan.branch, results?.get(pr.number));
						if (problems && (problems.failedChecks.length || problems.reviewComments || problems.mergeConflicts))
							checks.push({ pr, problems });
					}
				}
				await this.host.apply(
					item.session,
					item.result,
					plan && checks ? { context: plan.context, checks } : undefined,
				);
			} catch (error) {
				// A metadata I/O failure must not kill polling or become an agent failure.
				warn(`could not cache pull request for ${item.key}`, error);
			}
		}
	}

	/** Batched health, falling back to the paginated single-PR lookup for very busy PRs. */
	private async problems(
		session: Session,
		pr: SessionPullRequest,
		branch: string | undefined,
		result: HealthResult | undefined,
	): Promise<PullRequestProblems | undefined> {
		if (result && "problems" in result) return result.problems;
		if (result && "overflow" in result && !this.stopped) {
			try {
				return await discoverPullRequestProblems(
					{ cwd: session.cwd, workspace: { ...session.workspace, branch: pr.branch ?? branch }, pullRequest: pr },
					this.runner,
				);
			} catch (error) {
				warn(`could not check pull request health for ${pr.url}`, error);
				return undefined;
			}
		}
		// A failed health lookup must not hide fresh actionable evidence from another head.
		if (result && "error" in result) warn(`could not check pull request health for ${pr.url}`, result.error);
		return undefined;
	}

	/** Milliseconds until an entry's next scheduled check. Infinity means only events check it. */
	private delay(entry: Entry, checks: string | undefined, now: number): number {
		if (entry.failures) return Math.min(this.base * 2 ** (entry.failures - 1), maxDelay);
		if (entry.key.startsWith("linked:")) {
			const url = entry.key.slice("linked:".length);
			for (const target of this.host.linked?.targets() ?? [])
				if (target.url === url)
					return isTerminalPullRequest(target.pullRequest) ? Number.POSITIVE_INFINITY : this.base * 2;
			return Number.POSITIVE_INFINITY;
		}
		const session = this.host.session(entry.key.slice("session:".length));
		if (!session || !this.eligible(session)) return Number.POSITIVE_INFINITY;
		const prs = sessionPullRequests(session);
		if (prs.some((pr) => pr.state === "open" || pr.state === "draft"))
			return checks === "pending" ? this.base / 2 : this.base * 2;
		// No PR yet. Agent activity triggers explicit refreshes, so polling only catches PRs opened elsewhere.
		const idle = now - (session.updatedAt ?? 0);
		if (idle < HOUR) return this.base;
		if (idle < DAY) return Math.min(this.base * 5, maxDelay);
		return maxDelay;
	}
}
