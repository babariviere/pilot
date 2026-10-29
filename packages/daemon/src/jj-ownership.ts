import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
	identifier,
	type JjCreation,
	type JjOwnedChange,
	type JjOwnershipBinding,
	type JjRevision,
	operationIdPattern,
	repositoryIdPattern,
	revisionRecord,
} from "./jj-ownership-contract.ts";
import { type Runner, run } from "./workspaces.ts";

export type { JjOwnedChange, JjOwnershipBinding, JjWorkerScope } from "./jj-ownership-contract.ts";

/** Physical repository instance, not a remote URL (forks/copies must not share claims). */
export async function jjRepositoryIdentity(repository: string): Promise<string> {
	const path = await realpath(join(repository, ".jj/repo"));
	const info = await stat(path, { bigint: true });
	return createHash("sha256").update(`${path}\0${info.dev}\0${info.ino}`).digest("hex");
}

interface Checkpoint {
	binding: JjOwnershipBinding;
	cursor: string;
	problem: string | null;
	coverage: "complete" | "unknown";
}
interface Operation {
	id: string;
	workspace: string;
	description: string;
}

const creationDescription =
	/^(new empty commit|commit [a-f0-9]{40}|split commit [a-f0-9]{40}|squash commits into [a-f0-9]{40}|abandon commit [a-f0-9]{40})$/;

/** Internal daemon API. No shell/HTTP supplied ownership assertions are accepted. */
export class JjOwnershipStore {
	private worker?: Worker;
	private fault?: Error;
	private closed = false;
	private closing = false;
	private drain?: Promise<void>;
	private readonly abort = new AbortController();
	private serial = 0;
	private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
	private readonly observing = new Map<string, Promise<void>>();
	private readonly file: string;
	private readonly runner: Runner;
	constructor(file: string, runner: Runner = run) {
		this.file = file;
		this.runner = runner;
	}

	private rpc<T>(method: string, args: object): Promise<T> {
		if (this.closed || this.fault) return Promise.reject(this.fault ?? new Error("Ownership store closed"));
		if (this.pending.size >= 32) return Promise.reject(new Error("Ownership store busy"));
		if (!this.worker) {
			const worker = new Worker(new URL("./jj-ownership-worker.ts", import.meta.url), {
				workerData: { file: this.file },
			});
			this.worker = worker;
			worker.on("message", ({ id, value, error }) => {
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				if (error) waiter.reject(new Error(error));
				else waiter.resolve(value);
				if (!this.pending.size) worker.unref();
			});
			const fail = (error: Error) => {
				this.fault = error;
				for (const waiter of this.pending.values()) waiter.reject(error);
				this.pending.clear();
			};
			worker.on("error", fail);
			worker.on("exit", (code) => fail(new Error(`Ownership store exited (${code})`)));
			worker.unref();
		}
		return new Promise((resolve, reject) => {
			const id = ++this.serial;
			this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
			this.worker!.ref();
			this.worker!.postMessage({ id, method, args });
		});
	}

	/** Called only by the managed-workspace creation path, before any worker admission. */
	register(binding: JjOwnershipBinding, creation: JjCreation): Promise<void> {
		if (this.closing) return Promise.reject(new Error("Ownership store closed"));
		return this.rpc("register", { binding, creation });
	}

	async binding(repositoryId: string, workspace: string): Promise<Checkpoint | undefined> {
		identifier(repositoryId, repositoryIdPattern);
		identifier(workspace, /^pilot-[a-zA-Z0-9_-]+-[a-f0-9]{16}$/);
		if (!(await this.available())) return undefined;
		return this.rpc("binding", { repositoryId, workspace });
	}

	async available(): Promise<boolean> {
		if (this.worker) return true;
		return stat(this.file).then(
			() => true,
			(error: NodeJS.ErrnoException) => {
				if (error.code !== "ENOENT") throw error;
				return false;
			},
		);
	}

	async get(repositoryId: string, changeId: string): Promise<JjOwnedChange> {
		return this.rpc("get", { repositoryId, changeId });
	}

	/** Keyset pagination covers all claims, including abandoned changes and collisions. */
	list(repositoryId: string, workspace: string, after = "", limit = 100): Promise<JjOwnedChange[]> {
		return this.rpc("list", { repositoryId, workspace, after, limit });
	}

	private jj(cwd: string, operation: string, args: string[]) {
		return this.runner(
			"jj",
			["--no-pager", "--color=never", "--ignore-working-copy", `--at-op=${operation}`, ...args],
			cwd,
			10_000,
			this.abort.signal,
		);
	}

	async head(cwd: string): Promise<string> {
		const id = await this.jj(cwd, "@", ["op", "log", "--no-graph", "--limit", "1", "-T", "self.id()"]);
		identifier(id, operationIdPattern);
		return id;
	}

	observe(repositoryId: string, workspace: string, cwd: string): Promise<void> {
		const key = `${repositoryId}\0${workspace}`;
		const active = this.observing.get(key);
		if (active) return active;
		if (this.closed || this.closing) return Promise.reject(new Error("Ownership store closed"));
		if (this.observing.size >= 2) return Promise.reject(new Error("Ownership observation busy"));
		const work = this.reconcile(repositoryId, workspace, cwd).finally(() => this.observing.delete(key));
		this.observing.set(key, work);
		return work;
	}

	private async reconcile(repositoryId: string, workspace: string, cwd: string): Promise<void> {
		const checkpoint = await this.binding(repositoryId, workspace);
		if (!checkpoint) return; // No retroactive enrollment or adoption.
		const scope = checkpoint.binding;
		const failure = () =>
			this.rpc<void>("apply", {
				repositoryId,
				workspace,
				expectedCursor: checkpoint.cursor,
				operationId: checkpoint.cursor,
				creations: [],
				changes: [],
				problem: "history-unknown",
				coverage: checkpoint.coverage,
			});
		try {
			if (
				(await realpath(cwd)) !== scope.path ||
				(await jjRepositoryIdentity(scope.repositoryPath)) !== repositoryId
			)
				throw new Error("Ownership workspace instance mismatch");
			// Check jj's actual repository link as well as daemon metadata.
			const linked = (await readFile(join(cwd, ".jj/repo"), "utf8")).trim();
			if ((await realpath(resolve(cwd, ".jj", linked))) !== (await realpath(join(scope.repositoryPath, ".jj/repo"))))
				throw new Error("Ownership repository binding mismatch");
			const roots = await this.jj(cwd, "@", [
				"workspace",
				"list",
				"-T",
				'name ++ "\\t" ++ root.absolute() ++ "\\n"',
			]);
			if (!roots.split("\n").some((line) => line === `${workspace}\t${scope.path}`))
				throw new Error("Ownership workspace binding mismatch");
			const head = await this.head(cwd);
			if (head === checkpoint.cursor && checkpoint.problem === null) return;
			const operations: Operation[] = [];
			let next = head;
			let coverage = checkpoint.coverage;
			// Page back to the durable cursor, without a lossy in-memory history window.
			// Any missing cursor or merge/divergent operation makes the whole scan Unknown.
			try {
				while (next !== checkpoint.cursor) {
					const output = await this.jj(cwd, next, [
						"op",
						"log",
						"--no-graph",
						"--limit",
						"128",
						"-T",
						'self.id() ++ "\\t" ++ self.parents().map(|p| p.id()).join(",") ++ "\\t" ++ json(self.workspace_name()) ++ "\\t" ++ json(self.description()) ++ "\\n"',
					]);
					if (!output) throw new Error("Missing operation history");
					for (const line of output.split("\n")) {
						const fields = line.split("\t");
						if (fields.length !== 4) throw new Error("Malformed operation history");
						const [id, rawParents, rawWorkspace, rawDescription] = fields as [string, string, string, string];
						identifier(id, operationIdPattern);
						if (id !== next) throw new Error("Nonlinear operation history");
						if (id === checkpoint.cursor) break;
						const parents = rawParents.split(",");
						if (/^0+$/.test(id)) throw new HistoryUnknown();
						if (parents.length !== 1) throw new HistoryUnknown();
						identifier(parents[0], operationIdPattern);
						const opWorkspace: unknown = JSON.parse(rawWorkspace);
						const description: unknown = JSON.parse(rawDescription);
						if (typeof opWorkspace !== "string" || typeof description !== "string")
							throw new Error("Malformed operation metadata");
						// Retain only candidate births, not every snapshot or sibling operation.
						if (
							(opWorkspace === workspace || opWorkspace === `${workspace}@`) &&
							creationDescription.test(description)
						)
							operations.push({ id, workspace: opWorkspace, description });
						next = parents[0]!;
						if (next === checkpoint.cursor) break;
					}
				}
			} catch (error) {
				if (!(error instanceof HistoryUnknown)) throw error;
				// Reconcile known identities, but claim none across an unprovable interval.
				// Persist the coverage gap permanently, then permit future proven creations.
				operations.length = 0;
				coverage = "unknown";
			}
			const creations: JjCreation[] = [];
			for (const op of operations.reverse()) {
				if (op.workspace !== workspace && op.workspace !== `${workspace}@`) continue;
				// Creation semantics, not authorship, branch membership, or a borrowed working copy.
				if (!creationDescription.test(op.description)) continue;
				const diff = await this.jj(cwd, op.id, [
					"op",
					"show",
					"--no-graph",
					"-T",
					"",
					'--config=templates.commit_summary=change_id ++ " " ++ commit_id',
					"--config=revsets.op-diff-changes-in=all()",
				]);
				const section = diff.split("Changed commits:\n")[1]?.split(/\nChanged /)[0];
				if (section === undefined) throw new Error("Missing creation diff");
				const removed = new Set<string>();
				const added: { changeId: string; commitId: string }[] = [];
				for (const line of section.trim().split("\n")) {
					const match = /^([+-]) ([k-z]{32}) ([a-f0-9]{40})$/.exec(line);
					if (!match) throw new Error("Malformed creation diff");
					if (match[1] === "-") removed.add(match[2]!);
					else added.push({ changeId: match[2]!, commitId: match[3]! });
				}
				// A creation command may also resurrect abandoned, borrowed ancestry.
				// Only its newly-created checkout target is proven fresh by these command semantics.
				const checkout = diff.split(`Changed working copy ${workspace}@:\n`)[1]?.split(/\nChanged /)[0];
				const targets = new Set<string>();
				for (const line of checkout?.trim().split("\n") ?? []) {
					const match = /^([+-]) ([k-z]{32}) ([a-f0-9]{40})$/.exec(line);
					if (!match) throw new Error("Malformed creation checkout diff");
					if (match[1] === "+") targets.add(`${match[2]} ${match[3]}`);
				}
				for (const revision of added)
					if (!removed.has(revision.changeId) && targets.has(`${revision.changeId} ${revision.commitId}`))
						creations.push({ ...revision, operationId: op.id, kind: "workspace-operation" });
			}
			const ids = new Set(creations.map((proof) => proof.changeId));
			let after = "";
			for (;;) {
				const page = await this.list(repositoryId, workspace, after);
				for (const record of page) ids.add(record.changeId);
				if (page.length < 100) break;
				after = page.at(-1)!.changeId;
			}
			const changes: { changeId: string; revisions: JjRevision[] }[] = [];
			const all = [...ids];
			for (let start = 0; start < all.length; start += 64) {
				const batch = all.slice(start, start + 64);
				const output = await this.jj(cwd, head, [
					"log",
					"--no-graph",
					"-r",
					batch.map((id) => `change_id(${id})`).join(" | "),
					"-T",
					'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ parents.map(|p| p.commit_id()).join(",") ++ "\\n"',
				]);
				const revisions = new Map(batch.map((id) => [id, [] as JjRevision[]]));
				for (const line of output ? output.split("\n") : []) {
					const [changeId, commitId, parents, extra] = line.split("\t");
					if (extra !== undefined || parents === undefined) throw new Error("Malformed observed revision");
					const revision = { changeId, commitId, parents: parents ? parents.split(",") : [] };
					revisionRecord(revision);
					if (!revisions.has(revision.changeId)) throw new Error("Unexpected observed change");
					revisions.get(revision.changeId)!.push(revision);
				}
				for (const [changeId, current] of revisions) changes.push({ changeId, revisions: current });
			}
			await this.rpc("apply", {
				repositoryId,
				workspace,
				expectedCursor: checkpoint.cursor,
				operationId: head,
				creations,
				changes,
				problem: null,
				coverage,
			});
		} catch (error) {
			await failure();
			throw error;
		}
	}

	close(): Promise<void> {
		if (this.drain) return this.drain;
		this.closing = true;
		this.abort.abort();
		this.drain = (async () => {
			await Promise.allSettled(this.observing.values());
			try {
				if (this.worker && !this.fault) await this.rpc("close", {});
			} finally {
				this.closed = true;
				await this.worker?.terminate();
			}
		})();
		return this.drain;
	}
}

class HistoryUnknown extends Error {
	constructor() {
		super("Unprovable operation interval");
	}
}
