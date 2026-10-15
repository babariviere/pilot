/** Canonical, same-host auth authority. Never exchanges tokens, executes helpers, or handles file paths from clients. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTH_FRAME_LIMIT,
	type CredentialEndpoint,
	type CredentialNamespace,
	type CredentialRequest,
} from "@pilot/kernel/credential-rpc";
import lockfile from "proper-lockfile";

type ObjectValue = Record<string, unknown>;
type Fence = { generation: number; fingerprint: string; pending?: string; revoked?: boolean };
type Journal = Record<string, Fence>;
type Actor = { admin: boolean; sockets: Set<Socket> };
type Held = {
	namespace: CredentialNamespace;
	key: string;
	generation: number;
	fingerprint: string;
	revision: string;
	login: boolean;
	id: string;
	release(): Promise<void>;
	compromised(): boolean;
};
class Rejected extends Error {
	readonly code: string;
	constructor(code: string) {
		super(code);
		this.code = code;
	}
}
function object(value: unknown): value is ObjectValue {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function fingerprint(value: unknown): string {
	return createHash("sha256")
		.update(JSON.stringify(value) ?? "missing")
		.digest("hex");
}
function identity(namespace: string, key: string): string {
	return `${namespace}:${key}`;
}
function validKey(namespace: CredentialNamespace, key: unknown): key is string {
	if (typeof key !== "string" || Buffer.byteLength(key) > 2048) return false;
	if (namespace === "pi") return /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(key);
	const at = key.indexOf("|");
	if (!/^mcp__[A-Za-z0-9_]+$/.test(key.slice(0, at))) return false;
	try {
		const url = new URL(key.slice(at + 1));
		return (
			["https:", "http:"].includes(url.protocol) && !url.username && !url.password && url.href === key.slice(at + 1)
		);
	} catch {
		return false;
	}
}
function validValue(namespace: CredentialNamespace, value: unknown): boolean {
	if (!object(value) || Buffer.byteLength(JSON.stringify(value)) > 48 * 1024) return false;
	if (namespace === "pi")
		return value.type === "api_key"
			? (value.key === undefined || typeof value.key === "string") &&
					(value.env === undefined ||
						(object(value.env) && Object.values(value.env).every((v) => typeof v === "string")))
			: value.type === "oauth" &&
					typeof value.refresh === "string" &&
					typeof value.access === "string" &&
					typeof value.expires === "number" &&
					Number.isFinite(value.expires);
	// MCP state is the SDK's OAuth state, not arbitrary config. Provider metadata is retained verbatim.
	return (
		typeof value.serverUrl === "string" &&
		Object.keys(value).every((key) =>
			[
				"serverUrl",
				"tokens",
				"tokensExpireAt",
				"clientInformation",
				"codeVerifier",
				"oauthState",
				"discovery",
			].includes(key),
		)
	);
}
async function readObject(path: string, limit = 4 * 1024 * 1024): Promise<ObjectValue> {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > limit) throw new Rejected("invalid");
		const value: unknown = JSON.parse(await file.readFile("utf8"));
		if (!object(value)) throw new Rejected("invalid");
		return value;
	} finally {
		await file.close();
	}
}
async function atomic(path: string, value: unknown): Promise<void> {
	const serialized = JSON.stringify(value);
	if (Buffer.byteLength(serialized) > 4 * 1024 * 1024) throw new Rejected("invalid");
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		const file = await open(temp, "wx", 0o600);
		try {
			await file.writeFile(serialized);
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temp, path);
		const parent = await open(join(path, ".."), "r");
		try {
			await parent.sync();
		} finally {
			await parent.close();
		}
	} finally {
		await rm(temp, { force: true });
	}
}

export class CredentialBroker {
	private server?: Server;
	private root?: string;
	private socket?: string;
	private readonly actors = new Map<string, Actor>();
	private readonly active = new Set<Socket>();
	private readonly locks = new Set<Promise<void>>();
	private readonly paths: Record<CredentialNamespace, string>;
	private readonly journal: string;
	readonly agentDir: string;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.paths = { pi: join(agentDir, "auth.json"), mcp: join(agentDir, "mcp-auth.json") };
		this.journal = join(agentDir, ".pilot-credential-journal.json");
	}
	async start(): Promise<void> {
		await mkdir(this.agentDir, { recursive: true, mode: 0o700 });
		if ((await realpath(this.agentDir)) !== this.agentDir)
			throw new Error("Credential agent directory must be canonical");
		for (const path of [...Object.values(this.paths), this.journal]) {
			try {
				const file = await open(path, "wx", 0o600);
				await file.writeFile("{}");
				await file.close();
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
			await this.regular(path);
		}
		this.root = await realpath(await mkdtemp(join(tmpdir(), "pilot-auth-")));
		this.socket = join(this.root, "auth.sock");
		this.server = createServer((socket) => this.accept(socket));
		await new Promise<void>((resolve, reject) => {
			this.server!.once("error", reject);
			this.server!.listen(this.socket!, resolve);
		});
		await chmod(this.socket, 0o600);
	}
	grant(admin = false): CredentialEndpoint {
		if (!this.socket) throw new Error("Credential broker unavailable");
		if (this.actors.size >= 4096) throw new Error("Credential broker capacity reached");
		const token = randomBytes(32).toString("hex");
		this.actors.set(token, { admin, sockets: new Set() });
		return { socket: this.socket, token };
	}
	revoke(endpoint: CredentialEndpoint): void {
		const actor = this.actors.get(endpoint.token);
		this.actors.delete(endpoint.token);
		for (const socket of actor?.sockets ?? []) socket.destroy();
	}
	private async regular(path: string): Promise<void> {
		const info = await lstat(path);
		if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid!() || info.mode & 0o077)
			throw new Rejected("invalid");
	}
	private async mutex<T>(path: string, fn: () => Promise<T>): Promise<T> {
		const release = await lockfile.lock(path, {
			realpath: false,
			retries: { retries: 300, minTimeout: 100, maxTimeout: 100 },
			onCompromised: () => {},
		});
		try {
			return await fn();
		} finally {
			await release().catch(() => {});
		}
	}
	private async updateJournal<T>(fn: (journal: Journal) => T): Promise<T> {
		await this.regular(this.journal);
		return this.mutex(this.journal, async () => {
			const journal = (await readObject(this.journal)) as Journal;
			if (Object.keys(journal).length > 4096) throw new Rejected("busy");
			const result = fn(journal);
			await atomic(this.journal, journal);
			return result;
		});
	}
	private async fence(namespace: CredentialNamespace, key: string): Promise<number> {
		return this.updateJournal((journal) => {
			const old = journal[identity(namespace, key)];
			journal[identity(namespace, key)] = {
				generation: (old?.generation ?? 0) + 1,
				fingerprint: old?.fingerprint ?? "",
				revoked: true,
			};
			return journal[identity(namespace, key)]!.generation;
		});
	}
	private async begin(
		namespace: CredentialNamespace,
		key: string,
		login: boolean,
		socket: Socket,
	): Promise<{ held: Held; value: unknown }> {
		const loginGeneration = login ? await this.fence(namespace, key) : undefined;
		const path = this.paths[namespace];
		await this.regular(path);
		let compromised = false;
		let external: (() => Promise<void>) | undefined;
		if (namespace === "mcp") {
			const hash = createHash("sha256").update(key).digest("hex").slice(0, 16);
			external = await lockfile.lock(join(this.agentDir, `mcp-auth-refresh-${hash}`), {
				realpath: false,
				stale: 20_000,
				retries: { retries: 250, minTimeout: 100, maxTimeout: 100 },
				onCompromised: () => {
					compromised = true;
				},
			});
		}
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				stale: 30_000,
				retries: { retries: 300, minTimeout: 100, maxTimeout: 100 },
				onCompromised: () => {
					compromised = true;
				},
			});
			if (socket.destroyed || compromised) throw new Rejected("unavailable");
			const values = await readObject(path);
			const revision = await this.revision(path);
			const value = Object.hasOwn(values, key) ? values[key] : undefined;
			const fp = fingerprint(value);
			const id = randomUUID();
			const generation = await this.updateJournal((journal) => {
				let old = journal[identity(namespace, key)];
				if (login && old?.generation !== loginGeneration) throw new Rejected("stale");
				if (old?.fingerprint !== fp && !login) old = { generation: (old?.generation ?? 0) + 1, fingerprint: fp };
				if (!login && old?.pending) throw new Rejected("uncertain");
				if (!login && old?.revoked) throw new Rejected("stale");
				const generation = old?.generation ?? 0;
				journal[identity(namespace, key)] = { generation, fingerprint: fp, pending: id };
				return generation;
			});
			return {
				value,
				held: {
					namespace,
					key,
					id,
					generation,
					fingerprint: fp,
					revision,
					login,
					compromised: () => compromised,
					release: async () => {
						await release?.().catch(() => {});
						await external?.().catch(() => {});
					},
				},
			};
		} catch (error) {
			await release?.().catch(() => {});
			await external?.().catch(() => {});
			throw error;
		}
	}
	private async revision(path: string): Promise<string> {
		const info = await stat(path, { bigint: true });
		return `${info.ino}:${info.mtimeNs}:${info.ctimeNs}:${info.size}`;
	}
	private async commit(held: Held, value: unknown, changed: boolean): Promise<void> {
		if (held.compromised()) throw new Rejected("stale");
		if (changed && !validValue(held.namespace, value)) throw new Rejected("invalid");
		if (
			changed &&
			held.namespace === "mcp" &&
			(value as ObjectValue).serverUrl !== held.key.slice(held.key.indexOf("|") + 1)
		)
			throw new Rejected("invalid");
		const path = this.paths[held.namespace];
		await this.regular(path);
		const values = await readObject(path);
		if (fingerprint(values[held.key]) !== held.fingerprint || (await this.revision(path)) !== held.revision)
			throw new Rejected("stale");
		if (
			changed &&
			!held.login &&
			(values[held.key] === undefined ||
				(held.namespace === "pi" &&
					((values[held.key] as ObjectValue).type !== "oauth" || (value as ObjectValue).type !== "oauth")))
		)
			throw new Rejected("unauthorized");
		// Keep the short journal lock through persistence: a concurrent login/logout fences this commit
		// either before it validates, or strictly after the canonical credential is committed.
		await this.regular(this.journal);
		await this.mutex(this.journal, async () => {
			const journal = (await readObject(this.journal)) as Journal;
			const fence = journal[identity(held.namespace, held.key)];
			if (fence?.generation !== held.generation || fence.pending !== held.id || fence.revoked || held.compromised())
				throw new Rejected("stale");
			if (changed) {
				values[held.key] = value;
				await atomic(path, values);
			}
			journal[identity(held.namespace, held.key)] = {
				generation: held.generation,
				fingerprint: fingerprint(changed ? value : values[held.key]),
			};
			await atomic(this.journal, journal);
		});
	}
	private accept(socket: Socket): void {
		if (this.active.size >= 128) {
			socket.destroy();
			return;
		}
		this.active.add(socket);
		let actor: Actor | undefined, token: string | undefined, held: Held | undefined;
		let buffer = Buffer.alloc(0),
			busy = false;
		let expired = false;
		const deadline = setTimeout(() => {
			expired = true;
			socket.destroy();
		}, 300_000);
		socket.on("error", () => {});
		const releaseHeld = async () => {
			const old = held;
			held = undefined;
			if (old) await old.release();
		};
		socket.on("close", () => {
			clearTimeout(deadline);
			this.active.delete(socket);
			actor?.sockets.delete(socket);
			if (!busy) {
				const released = releaseHeld();
				this.locks.add(released);
				void released.finally(() => this.locks.delete(released));
			}
		});
		const send = (value: unknown, code?: string): void => {
			const frame = JSON.stringify(code ? { ok: false, code } : { ok: true, value }) + "\n";
			if (Buffer.byteLength(frame) > AUTH_FRAME_LIMIT) {
				socket.destroy();
				return;
			}
			socket.write(frame);
		};
		socket.on("data", (bytes) => {
			if (busy) return socket.destroy();
			buffer = Buffer.concat([buffer, bytes]);
			if (buffer.length > AUTH_FRAME_LIMIT) return socket.destroy();
			const end = buffer.indexOf(10);
			if (end < 0) return;
			if (end !== buffer.length - 1) return socket.destroy();
			const frame = buffer.subarray(0, end);
			buffer = Buffer.alloc(0);
			busy = true;
			const work = (async () => {
				try {
					const req = JSON.parse(frame.toString()) as CredentialRequest & { token?: unknown };
					if (
						!object(req) ||
						typeof req.token !== "string" ||
						!this.actors.has(req.token) ||
						(token && token !== req.token)
					)
						throw new Rejected("unauthorized");
					token = req.token;
					actor = this.actors.get(token)!;
					actor.sockets.add(socket);
					if (actor.sockets.size > 64) throw new Rejected("busy");
					if (
						!Object.keys(req).every((key) =>
							["op", "namespace", "key", "mode", "changed", "value", "token"].includes(key),
						) ||
						!["pi", "mcp"].includes(req.namespace)
					)
						throw new Rejected("invalid");
					if (req.op === "list" && req.namespace === "pi" && !held) {
						const values = await readObject(this.paths.pi);
						return send(
							Object.entries(values)
								.filter(([key, value]) => validKey("pi", key) && validValue("pi", value))
								.map(([providerId, value]) => ({ providerId, type: (value as ObjectValue).type })),
						);
					}
					if (!validKey(req.namespace, req.key)) throw new Rejected("invalid");
					const key = req.key;
					if (req.op === "read" && !held) {
						const journal = (await readObject(this.journal)) as Journal;
						const values = await readObject(this.paths[req.namespace]);
						const value = Object.hasOwn(values, key) ? values[key] : undefined;
						if (
							journal[identity(req.namespace, key)]?.revoked &&
							journal[identity(req.namespace, key)]?.fingerprint === fingerprint(value)
						)
							return send(undefined);
						return send(value);
					}
					if (req.op === "delete" && actor.admin && !held) {
						await this.fence(req.namespace, key);
						await this.mutex(this.paths[req.namespace], async () => {
							const values = await readObject(this.paths[req.namespace]);
							delete values[key];
							await atomic(this.paths[req.namespace], values);
						});
						return send(true);
					}
					if (req.op === "begin" && !held && ["refresh", "login"].includes(req.mode ?? "")) {
						if (req.mode === "login" && !actor.admin) throw new Rejected("unauthorized");
						const begun = await this.begin(req.namespace, key, req.mode === "login", socket);
						held = begun.held;
						if (expired || socket.destroyed || !this.actors.has(token)) {
							await held.release();
							held = undefined;
							return;
						}
						return send(begun.value);
					}
					if (
						req.op === "commit" &&
						held &&
						held.key === key &&
						held.namespace === req.namespace &&
						typeof req.changed === "boolean"
					) {
						await this.commit(held, req.value, req.changed);
						await held.release();
						held = undefined;
						return send(true);
					}
					throw new Rejected("unauthorized");
				} catch (error) {
					send(undefined, error instanceof Rejected ? error.code : "unavailable");
				} finally {
					busy = false;
					if (socket.destroyed) await releaseHeld();
				}
			})();
			this.locks.add(work);
			void work.finally(() => this.locks.delete(work));
		});
	}
	async close(): Promise<void> {
		for (const socket of this.active) socket.destroy();
		await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
		await Promise.allSettled([...this.locks]);
		this.actors.clear();
		this.socket = undefined;
		if (this.root) await rm(this.root, { recursive: true, force: true });
	}
}
