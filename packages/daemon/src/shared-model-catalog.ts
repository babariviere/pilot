/** One discovery owner per same-host credential broker and agent directory. No model runs enter this lane. */

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { AnyModel } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
	CATALOG_FRAME_LIMIT,
	type CatalogOptions,
	catalogMetadata,
	catalogTransport,
	modelKey,
	type SharedModelCatalog,
	withCatalogSignal,
} from "@pilot/kernel/shared-model-catalog";

const TTL_MS = 5 * 60_000;
const MAX_PENDING = 8;
type DiscoveryRuntime = Pick<
	ModelRuntime,
	"refresh" | "getAllAvailable" | "getProviders" | "getAllModels" | "checkAuth"
>;

export class SharedCatalogService {
	private runtime?: Promise<DiscoveryRuntime>;
	private tail = Promise.resolve();
	private readonly pending = new Map<string, Promise<string>>();
	private cache?: { signature: string; policy: string; at: number; frame: string; revision: string };
	private closed = false;
	private readonly agentDir: string;
	private readonly create: () => Promise<DiscoveryRuntime>;
	private discoveries = 0;
	private generation = 0;
	private runtimeConfig?: string;
	private templates = new Map<string, readonly AnyModel[]>();
	get stats() {
		return {
			discoveries: this.discoveries,
			pending: this.pending.size,
			snapshotBytes: Buffer.byteLength(this.cache?.frame ?? ""),
		};
	}
	constructor(agentDir: string, create: () => Promise<DiscoveryRuntime>) {
		this.agentDir = agentDir;
		this.create = create;
	}

	async read(options: CatalogOptions = {}, signal?: AbortSignal): Promise<string> {
		signal?.throwIfAborted();
		if (this.closed) throw new Error("Model catalog closed");
		const signature = await this.signature();
		const policy = JSON.stringify([
			options.allowNetwork === true,
			options.providers ? [...new Set(options.providers)].sort() : null,
		]);
		const cached = this.cache;
		if (
			!options.force &&
			cached?.signature === signature &&
			cached.policy === policy &&
			Date.now() - cached.at < TTL_MS
		)
			return cached.frame;
		const key = `${signature}:${policy}:${options.force === true}`;
		let operation = this.pending.get(key);
		if (!operation) {
			if (this.pending.size >= MAX_PENDING) throw new Error("Model catalog busy");
			operation = this.tail.then(() => this.load(options, policy));
			this.tail = operation.then(
				() => {},
				() => {},
			);
			this.pending.set(key, operation);
			const clear = () => this.pending.delete(key);
			void operation.then(clear, clear);
		}
		return withCatalogSignal(operation, signal);
	}
	async reply(options: CatalogOptions, knownRevision?: string): Promise<string> {
		const frame = await this.read(options);
		return this.cache?.frame === frame && this.cache.revision === knownRevision
			? `${JSON.stringify({ ok: true, value: { unchanged: true } })}\n`
			: frame;
	}

	private async load(options: CatalogOptions, policy: string): Promise<string> {
		for (let attempt = 0; attempt < 3; attempt++) {
			if (this.closed) throw new Error("Model catalog closed");
			const before = await this.signature();
			if (
				attempt === 0 &&
				!options.force &&
				this.cache?.signature === before &&
				this.cache.policy === policy &&
				Date.now() - this.cache.at < TTL_MS
			)
				return this.cache.frame;
			const config = before.split("|")[0];
			if (this.runtime && this.runtimeConfig !== config) this.runtime = undefined;
			this.runtimeConfig = config;
			if (!this.runtime) {
				this.runtime = this.create().then((runtime) => {
					// Static builtins + models.json, before restoring remote metadata. Workers have these exact
					// transport templates too. Endpoint/headers/compatibility/sampling never enter the snapshot.
					this.templates = new Map(runtime.getProviders().map(({ id }) => [id, runtime.getAllModels(id)]));
					return runtime;
				});
			}
			const runtimePromise = this.runtime;
			let runtime: DiscoveryRuntime;
			try {
				runtime = await runtimePromise;
			} catch (error) {
				if (this.runtime === runtimePromise) this.runtime = undefined;
				throw error;
			}
			this.discoveries++;
			// A network publication changes models-store.json itself. Stabilize that generation offline,
			// rather than repeating a forced network refresh and its writes on every retry.
			const signal = AbortSignal.timeout(30_000);
			const result = await runtime.refresh({
				...options,
				allowNetwork: attempt === 0 && options.allowNetwork === true,
				signal,
			});
			if (result.aborted) throw new Error("Model catalog refresh aborted");
			// Use the SDK's complete auth checks and filters, not stored credential presence.
			const [available, checks] = await Promise.all([
				runtime.getAllAvailable(undefined, { signal }),
				Promise.all(
					runtime.getProviders().map(async ({ id }) => [id, await runtime.checkAuth(id, { signal })] as const),
				),
			]);
			const auth = new Map(checks);
			const snapshot: SharedModelCatalog = {
				revision: randomUUID(),
				generation: ++this.generation,
				...(result.errors.size ? { errors: [...result.errors.keys()] } : {}),
				providers: runtime.getProviders().map(({ id }) => {
					const original = runtime.getAllModels(id);
					const templates = this.templates.get(id) ?? [];
					const check = auth.get(id);
					const base = {
						id,
						available: available.filter((model) => model.provider === id).map(modelKey),
						...(check ? { auth: { type: check.type } } : {}),
					};
					// Do not send or allocate another copy of the SDK's already-loaded static catalog per worker.
					if (
						original.length === templates.length &&
						original.every((model, i) => JSON.stringify(model) === JSON.stringify(templates[i]))
					)
						return { ...base, models: [], static: true };
					const transports = new Map(templates.map((model) => [catalogTransport(model), modelKey(model)]));
					const models = original.map((model) => {
						const transport = transports.get(catalogTransport(model));
						return transport ? { model: catalogMetadata(model), transport } : undefined;
					});
					if (models.some((model) => !model)) return { ...base, models: [], local: true };
					return {
						...base,
						models: models as NonNullable<(typeof models)[number]>[],
					};
				}),
			};
			// File edits and login/logout during discovery cannot publish a stale generation.
			if (before !== (await this.signature())) continue;
			const frame = `${JSON.stringify({ ok: true, value: snapshot })}\n`;
			if (Buffer.byteLength(frame) > CATALOG_FRAME_LIMIT) throw new Error("Model catalog too large");
			// SDK refresh errors keep last-known models usable, but a later request must retry discovery.
			if (!result.errors.size)
				this.cache = { signature: before, policy, at: Date.now(), frame, revision: snapshot.revision };
			return frame;
		}
		throw new Error("Model catalog changed during discovery");
	}

	private async signature(): Promise<string> {
		return (
			await Promise.all(
				["models.json", "models-store.json", "auth.json", ".pilot-credential-journal.json"].map(async (name) => {
					try {
						const info = await stat(join(this.agentDir, name), { bigint: true });
						return `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code === "ENOENT") return "-";
						throw error;
					}
				}),
			)
		).join("|");
	}

	async close(): Promise<void> {
		this.closed = true;
		this.cache = undefined;
		await this.tail;
	}
}
