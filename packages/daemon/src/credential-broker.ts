/** Canonical, same-host auth authority. Never exchanges tokens, executes helpers, or handles file paths from clients. */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rename, rm, stat } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AUTH_FRAME_LIMIT,
	type CredentialEndpoint,
	type CredentialNamespace,
	type CredentialRequest,
	type CredentialStatus,
} from "@pilot/kernel/credential-rpc";
import lockfile from "proper-lockfile";
import { SharedCatalogService } from "./shared-model-catalog.ts";

type ObjectValue = Record<string, unknown>;
type Fence = { generation: number; fingerprint: string; pending?: string; revoked?: boolean; revoking?: boolean };
type Journal = Record<string, Fence>;
type Scope = { namespace: CredentialNamespace; key: string };
type Actor = { admin: boolean; scope?: Scope; sockets: Set<Socket>; revoked?: boolean; loginGeneration?: number };
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
function credentialStatus(namespace: CredentialNamespace, fence: Fence | undefined, value: unknown): CredentialStatus {
	const fenced =
		fence?.revoking ||
		(fence?.fingerprint === fingerprint(value) && (fence.pending || (fence.revoked && value !== undefined)));
	return {
		state:
			fenced || (value !== undefined && !validValue(namespace, value))
				? "reauthentication_required"
				: value === undefined
					? "missing"
					: "configured",
	};
}
async function readObject(path: string, limit = 4 * 1024 * 1024): Promise<ObjectValue> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
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
	readonly catalog: SharedCatalogService;
	private catalogClient?: import("@pilot/kernel/credential-client").CredentialClient;
	constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.paths = { pi: join(agentDir, "auth.json"), mcp: join(agentDir, "mcp-auth.json") };
		this.journal = join(agentDir, ".pilot-credential-journal.json");
		this.catalog = new SharedCatalogService(agentDir, async () => {
			const { CredentialClient } = await import("@pilot/kernel/credential-client");
			const { createDiscoveryRuntime, installCredentialBrokerHooks } = await import(
				"@pilot/kernel/credential-hooks"
			);
			await installCredentialBrokerHooks();
			this.catalogClient ??= new CredentialClient(this.grant());
			const client = this.catalogClient;
			return createDiscoveryRuntime({
				credentials: client.pi,
				modelsPath: join(agentDir, "models.json"),
				refreshOnCreate: false,
			});
		});
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
	grant(admin = false, scope?: Scope): CredentialEndpoint {
		if (scope && !validKey(scope.namespace, scope.key)) throw new Rejected("invalid");
		if (!this.socket) throw new Error("Credential broker unavailable");
		if (this.actors.size >= 4096) throw new Error("Credential broker capacity reached");
		const token = randomBytes(32).toString("hex");
		this.actors.set(token, { admin, ...(scope ? { scope: { ...scope } } : {}), sockets: new Set() });
		return { socket: this.socket, token, ...(!scope ? { catalogAgentDir: this.agentDir } : {}) };
	}
	revoke(endpoint: CredentialEndpoint): void {
		const actor = this.actors.get(endpoint.token);
		if (actor) actor.revoked = true;
		this.actors.delete(endpoint.token);
		for (const socket of actor?.sockets ?? []) socket.destroy();
	}
	/** Cancel one trusted setup helper. Revocation alone cannot fence a commit already awaiting I/O. */
	async cancelSetup(endpoint: CredentialEndpoint): Promise<{ reauthenticationRequired: boolean }> {
		const actor = this.actors.get(endpoint.token);
		const scope = actor?.scope;
		if (!scope) throw new Rejected("unauthorized");
		this.revoke(endpoint);
		return this.updateJournal(async (journal) => {
			const key = identity(scope.namespace, scope.key),
				old = journal[key];
			// Login claims its generation under this same lock. Cancelling before that claim stops
			// begin via actor.revoked. A newer explicit login/logout owns its own generation and is
			// never quarantined by cancellation of this older helper.
			if (actor.loginGeneration === undefined || old?.generation !== actor.loginGeneration) {
				const values = await readObject(this.paths[scope.namespace]);
				const value = Object.hasOwn(values, scope.key) ? values[scope.key] : undefined;
				return {
					reauthenticationRequired:
						credentialStatus(scope.namespace, old, value).state === "reauthentication_required",
				};
			}
			journal[key] = { generation: old.generation + 1, fingerprint: old.fingerprint, revoked: true, revoking: true };
			return { reauthenticationRequired: true };
		});
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
	private async updateJournal<T>(fn: (journal: Journal) => T | Promise<T>): Promise<T> {
		await this.regular(this.journal);
		return this.mutex(this.journal, async () => {
			const journal = (await readObject(this.journal)) as Journal;
			if (Object.keys(journal).length > 4096) throw new Rejected("busy");
			const result = await fn(journal);
			await atomic(this.journal, journal);
			return result;
		});
	}
	private async fence(namespace: CredentialNamespace, key: string, actor?: Actor): Promise<number> {
		return this.updateJournal((journal) => {
			if (actor?.revoked || (actor?.scope && actor.loginGeneration !== undefined))
				throw new Rejected("unauthorized");
			const old = journal[identity(namespace, key)];
			journal[identity(namespace, key)] = {
				generation: (old?.generation ?? 0) + 1,
				fingerprint: old?.fingerprint ?? "",
				revoked: true,
				revoking: true,
			};
			const generation = journal[identity(namespace, key)]!.generation;
			if (actor) actor.loginGeneration = generation;
			return generation;
		});
	}
	private async begin(
		namespace: CredentialNamespace,
		key: string,
		login: boolean,
		socket: Socket,
		actor: Actor,
	): Promise<{ held: Held; value: unknown }> {
		const loginGeneration = login ? await this.fence(namespace, key, actor) : undefined;
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
			if (namespace === "mcp" && (await this.migrateLegacy(values, key))) await atomic(path, values);
			const revision = await this.revision(path);
			const value = Object.hasOwn(values, key) ? values[key] : undefined;
			const fp = fingerprint(value);
			const id = randomUUID();
			const generation = await this.updateJournal((journal) => {
				let old = journal[identity(namespace, key)];
				if (login && old?.generation !== loginGeneration) throw new Rejected("stale");
				if (!login && old?.revoking) throw new Rejected("stale");
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
	private async migrateLegacy(values: ObjectValue, key: string): Promise<boolean> {
		const legacy = key.slice(key.indexOf("|") + 1);
		const journal = (await readObject(this.journal)) as Journal;
		const fence = journal[identity("mcp", key)];
		if (Object.hasOwn(values, key) || !Object.hasOwn(values, legacy) || fence?.revoked || fence?.pending)
			return false;
		values[key] = values[legacy];
		delete values[legacy];
		return true;
	}
	private async readCredential(namespace: CredentialNamespace, key: string, peek: boolean): Promise<unknown> {
		if (peek && namespace !== "mcp") throw new Rejected("invalid");
		const journal = (await readObject(this.journal)) as Journal;
		const fence = journal[identity(namespace, key)];
		if (fence?.revoking) return undefined;
		const values = await readObject(this.paths[namespace]);
		const value = Object.hasOwn(values, key) ? values[key] : undefined;
		if (fence?.revoked && fence.fingerprint === fingerprint(value)) return undefined;
		if (namespace === "mcp" && value === undefined && !fence?.revoked && !fence?.pending) {
			const legacy = key.slice(key.indexOf("|") + 1);
			if (!Object.hasOwn(values, legacy)) return undefined;
			if (peek) return values[legacy];
			return this.mutex(this.paths.mcp, async () => {
				const latest = await readObject(this.paths.mcp);
				if (await this.migrateLegacy(latest, key)) await atomic(this.paths.mcp, latest);
				return Object.hasOwn(latest, key) ? latest[key] : undefined;
			});
		}
		return value;
	}
	private async commit(held: Held, value: unknown, changed: boolean, authorized: () => boolean): Promise<void> {
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
			if (
				!authorized() ||
				fence?.generation !== held.generation ||
				fence.pending !== held.id ||
				fence.revoked ||
				held.compromised()
			)
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
					if (req.op === "catalog" && req.namespace === "pi" && !held && !actor.scope) {
						if (
							(req.key !== undefined && (typeof req.key !== "string" || !/^[a-f0-9-]{36}$/.test(req.key))) ||
							req.mode !== undefined ||
							req.changed !== undefined ||
							!object(req.value) ||
							!Object.keys(req.value).every((key) => ["allowNetwork", "force", "providers"].includes(key)) ||
							(req.value.allowNetwork !== undefined && typeof req.value.allowNetwork !== "boolean") ||
							(req.value.force !== undefined && typeof req.value.force !== "boolean") ||
							(req.value.providers !== undefined &&
								(!Array.isArray(req.value.providers) ||
									req.value.providers.length > 256 ||
									!req.value.providers.every((id) => validKey("pi", id))))
						)
							throw new Rejected("invalid");
						const frame = await this.catalog.reply(req.value, req.key);
						if (!socket.destroyed && this.actors.has(token)) socket.write(frame);
						return;
					}
					if (req.op === "list" && req.namespace === "pi" && !held) {
						const values = await readObject(this.paths.pi);
						return send(
							Object.entries(values)
								.filter(
									([key, value]) =>
										validKey("pi", key) &&
										validValue("pi", value) &&
										(!actor!.scope || (actor!.scope.namespace === "pi" && actor!.scope.key === key)),
								)
								.map(([providerId, value]) => ({ providerId, type: (value as ObjectValue).type })),
						);
					}
					if (req.op === "statuses" && req.namespace === "pi" && !held && req.key === undefined) {
						const values = await readObject(this.paths.pi),
							journal = (await readObject(this.journal)) as Journal;
						const keys = new Set([
							...Object.keys(values),
							...Object.keys(journal)
								.filter((key) => key.startsWith("pi:"))
								.map((key) => key.slice(3)),
						]);
						const selected = [...keys].filter(
							(key) =>
								validKey("pi", key) &&
								(!actor!.scope || (actor!.scope.namespace === "pi" && actor!.scope.key === key)),
						);
						if (selected.length > 256) throw new Rejected("busy");
						return send(
							selected.map((providerId) => ({
								providerId,
								...credentialStatus(
									"pi",
									journal[identity("pi", providerId)],
									Object.hasOwn(values, providerId) ? values[providerId] : undefined,
								),
							})),
						);
					}
					if (!validKey(req.namespace, req.key)) throw new Rejected("invalid");
					const key = req.key;
					if (actor.scope && (actor.scope.namespace !== req.namespace || actor.scope.key !== key))
						throw new Rejected("unauthorized");
					if (req.op === "status" && !held) {
						const journal = (await readObject(this.journal)) as Journal;
						const fence = journal[identity(req.namespace, key)];
						const values = await readObject(this.paths[req.namespace]);
						const value = Object.hasOwn(values, key) ? values[key] : undefined;
						return send(credentialStatus(req.namespace, fence, value));
					}
					if ((req.op === "read" || req.op === "peek") && !held) {
						return send(await this.readCredential(req.namespace, key, req.op === "peek"));
					}
					if (req.op === "delete" && actor.admin && !held) {
						const generation = await this.fence(req.namespace, key);
						await this.mutex(this.paths[req.namespace], async () => {
							const values = await readObject(this.paths[req.namespace]);
							await this.updateJournal(async (journal) => {
								if (journal[identity(req.namespace, key)]?.generation !== generation)
									throw new Rejected("stale");
								delete values[key];
								if (req.namespace === "mcp") delete values[key.slice(key.indexOf("|") + 1)];
								await atomic(this.paths[req.namespace], values);
								journal[identity(req.namespace, key)] = {
									generation,
									fingerprint: fingerprint(undefined),
									revoked: true,
								};
							});
						});
						return send(true);
					}
					if (req.op === "begin" && !held && ["refresh", "login"].includes(req.mode ?? "")) {
						if (req.mode === "login" && !actor.admin) throw new Rejected("unauthorized");
						const begun = await this.begin(req.namespace, key, req.mode === "login", socket, actor);
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
						await this.commit(held, req.value, req.changed, () => this.actors.has(token!));
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
		await this.catalog.close();
		await this.catalogClient?.close();
		this.actors.clear();
		this.socket = undefined;
		if (this.root) await rm(this.root, { recursive: true, force: true });
	}
}
