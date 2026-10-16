import type { SessionPullRequest } from "@pilot/protocol";
import type { LinkedPullRequest, LinkedPullRequestTracking } from "./pull-requests.ts";
import type { WatchService } from "./watch-service.ts";

/** Shares the daemon's existing bounded, batched PR tracker, never creates a second poller. */
export class PullRequestWatchSource implements LinkedPullRequestTracking {
	private readonly watches: WatchService;
	private readonly cwd: string;
	private readonly refresh: (target: LinkedPullRequest) => void;
	private readonly standalone = new Map<string, LinkedPullRequest>();
	private readonly owners = new Map<string, Set<string>>();
	private readonly writes = new Set<Promise<unknown>>();
	private readonly unsubscribe: () => void;
	private syncing?: Promise<void>;
	private dirty = false;
	private stopped = false;
	private readonly queue: SessionPullRequest[] = [];
	private draining?: Promise<void>;
	constructor(watches: WatchService, cwd: string, refresh: (target: LinkedPullRequest) => void) {
		this.watches = watches;
		this.cwd = cwd;
		this.refresh = refresh;
		this.unsubscribe = watches.onChange(() => this.sync());
		this.sync();
	}
	private track<T>(write: Promise<T>): Promise<T> {
		this.writes.add(write);
		void write.finally(() => this.writes.delete(write)).catch(() => {});
		return write;
	}
	private sync(): void {
		this.dirty = true;
		if (this.syncing || this.stopped) return;
		this.syncing = (async () => {
			while (this.dirty && !this.stopped) {
				this.dirty = false;
				const urls = new Set((await this.watches.targets("pr")).map((target) => target.id));
				for (const url of this.standalone.keys()) if (!urls.has(url)) this.standalone.delete(url);
				for (const url of urls)
					if (!this.standalone.has(url)) {
						const target = { url, cwd: this.cwd };
						this.standalone.set(url, target);
						this.refresh(target);
					}
			}
		})()
			.catch((error) => console.warn(`pilotd: PR watch registration failed: ${error}`))
			.finally(() => {
				this.syncing = undefined;
			});
	}
	targets(): Iterable<LinkedPullRequest> {
		return this.standalone.values();
	}
	/** Only PRs actually opened by this chat belong to chat_prs, not manually bound references. */
	openedBy(sessionId: string, prs: SessionPullRequest[]): void {
		for (const [url, ids] of this.owners) {
			ids.delete(sessionId);
			if (!ids.size) this.owners.delete(url);
		}
		for (const pr of prs) {
			const url = pr.url.toLowerCase();
			let ids = this.owners.get(url);
			if (!ids) {
				if (this.owners.size >= 50000) continue;
				ids = new Set();
				this.owners.set(url, ids);
			}
			ids.add(sessionId);
		}
	}
	apply(pr: SessionPullRequest): void {
		if (this.stopped) return;
		if (this.queue.length >= 50000) {
			console.warn("pilotd: PR watch queue full");
			return;
		}
		this.queue.push(pr);
		if (this.draining) return;
		this.draining = (async () => {
			while (this.queue.length) await this.observe(this.queue.shift()!);
		})()
			.catch((error) => console.warn(`pilotd: PR watch failed: ${error}`))
			.finally(() => {
				this.draining = undefined;
			});
	}
	async observe(pr: SessionPullRequest): Promise<number> {
		const url = pr.url.toLowerCase();
		const target = this.standalone.get(url);
		if (target) target.pullRequest = pr;
		const state = pr.state === "open" && pr.readiness?.state === "ready" ? "ready" : pr.state;
		const event =
			state === "merged"
				? "pr.merged"
				: state === "closed"
					? "pr.closed"
					: state === "ready"
						? "pr.ready"
						: undefined;
		return this.track(
			this.watches.transition({
				source: `pr:${url}`,
				state,
				candidate: event
					? {
							source: url,
							event,
							at: Date.now(),
							text: `PR #${pr.number} ${pr.title}: ${state}`,
							targets: [
								{ kind: "pr", id: url },
								...[...(this.owners.get(url) ?? [])].map((id) => ({ kind: "chat_prs" as const, id })),
							],
						}
					: undefined,
			}),
		);
	}
	async idle(): Promise<void> {
		await this.syncing;
		await this.draining;
		await Promise.all(this.writes);
	}
	async stop(): Promise<void> {
		this.stopped = true;
		this.unsubscribe();
		await this.idle();
	}
}
