/** Host-owned telemetry consent and exporter configuration. No credentials or arbitrary headers are stored here. */
import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AIUsageBudget, DaemonHello, TelemetrySettings, TelemetrySettingsPatch } from "@pilot/protocol";
import { type NodeTelemetryOptions, validateOtlpEndpoint } from "@pilot/telemetry";
import { FeatureUsageStore } from "./feature-usage.ts";

const FILE = "telemetry.json";
const SCHEMA = 1;

interface StoredTelemetrySettings {
	schemaVersion: 1;
	localDiagnostics: boolean;
	nextDiagnosticsEpoch?: number;
	localFeatureUsage?: boolean;
	remoteOperational: boolean;
	productAnalytics: boolean;
	endpoint?: string;
	aiUsageBudget?: AIUsageBudget;
	updatedAt?: string;
	hostKey: string;
	analyticsId: string;
}

export interface KernelTelemetrySettings {
	enabled: boolean;
	endpoint?: string;
	serviceVersion: string;
	environment: "release" | "development" | "test";
	hostKind: "local" | "devbox";
	hostId: string;
	localDiagnostics: boolean;
}

function environment(): KernelTelemetrySettings["environment"] {
	return process.env.NODE_ENV === "test" ? "test" : process.env.NODE_ENV === "production" ? "release" : "development";
}

function randomIdentifier(): string {
	return randomBytes(16).toString("base64url").toLowerCase();
}

function nextEpoch(): number {
	return randomBytes(6).readUIntBE(0, 6);
}

function defaults(): StoredTelemetrySettings {
	return {
		schemaVersion: SCHEMA,
		localDiagnostics: true,
		nextDiagnosticsEpoch: nextEpoch(),
		remoteOperational: false,
		productAnalytics: false,
		hostKey: randomBytes(32).toString("base64url"),
		analyticsId: randomIdentifier(),
	};
}

function usageBudget(value: unknown): AIUsageBudget | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some((key) => !["basis", "limitUsdMicros", "window"].includes(key)) ||
		(input.basis !== "catalog_estimate" && input.basis !== "billed") ||
		!Number.isSafeInteger(input.limitUsdMicros) ||
		(input.limitUsdMicros as number) <= 0 ||
		input.window !== "retained_chat"
	)
		return;
	return {
		basis: input.basis,
		limitUsdMicros: input.limitUsdMicros as number,
		window: input.window,
	};
}

function stored(value: unknown): StoredTelemetrySettings | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return;
	const input = value as Record<string, unknown>;
	if (
		input.schemaVersion !== SCHEMA ||
		(input.localFeatureUsage !== undefined && typeof input.localFeatureUsage !== "boolean") ||
		(input.nextDiagnosticsEpoch !== undefined &&
			(!Number.isSafeInteger(input.nextDiagnosticsEpoch) ||
				(input.nextDiagnosticsEpoch as number) < 0 ||
				(input.nextDiagnosticsEpoch as number) > 281474976710655)) ||
		typeof input.localDiagnostics !== "boolean" ||
		typeof input.remoteOperational !== "boolean" ||
		typeof input.productAnalytics !== "boolean" ||
		typeof input.hostKey !== "string" ||
		!/^[A-Za-z0-9_-]{43}$/.test(input.hostKey) ||
		typeof input.analyticsId !== "string" ||
		!/^[a-z0-9_-]{22}$/.test(input.analyticsId) ||
		(input.updatedAt !== undefined &&
			(typeof input.updatedAt !== "string" || !Number.isFinite(Date.parse(input.updatedAt))))
	)
		return;
	let endpoint: string | undefined;
	if (input.endpoint !== undefined) {
		if (typeof input.endpoint !== "string") return;
		try {
			endpoint = validateOtlpEndpoint(input.endpoint);
		} catch {
			return;
		}
	}
	if (input.remoteOperational && !endpoint) return;
	const aiUsageBudget = input.aiUsageBudget === undefined ? undefined : usageBudget(input.aiUsageBudget);
	if (input.aiUsageBudget !== undefined && !aiUsageBudget) return;
	return {
		schemaVersion: SCHEMA,
		localDiagnostics: input.localDiagnostics,
		nextDiagnosticsEpoch: (input.nextDiagnosticsEpoch as number | undefined) ?? 0,
		localFeatureUsage: input.localFeatureUsage === true,
		remoteOperational: input.remoteOperational,
		productAnalytics: input.productAnalytics,
		...(endpoint ? { endpoint } : {}),
		...(aiUsageBudget ? { aiUsageBudget } : {}),
		...(input.updatedAt ? { updatedAt: input.updatedAt } : {}),
		hostKey: input.hostKey,
		analyticsId: input.analyticsId,
	};
}

function patch(value: unknown): TelemetrySettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid telemetry settings");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).some(
			(key) =>
				![
					"localDiagnostics",
					"localFeatureUsage",
					"remoteOperational",
					"productAnalytics",
					"endpoint",
					"aiUsageBudget",
				].includes(key),
		) ||
		typeof input.localDiagnostics !== "boolean" ||
		typeof input.remoteOperational !== "boolean" ||
		typeof input.productAnalytics !== "boolean" ||
		(input.endpoint !== undefined && typeof input.endpoint !== "string")
	)
		throw new Error("Invalid telemetry settings");
	if (input.localFeatureUsage !== undefined && typeof input.localFeatureUsage !== "boolean")
		throw new Error("Invalid local feature collection setting");
	let endpoint: string | undefined;
	if (typeof input.endpoint === "string" && input.endpoint.trim())
		endpoint = validateOtlpEndpoint(input.endpoint.trim());
	if (input.remoteOperational && !endpoint) throw new Error("An OTLP endpoint is required for remote reporting");
	const hasBudget = Object.hasOwn(input, "aiUsageBudget");
	const aiUsageBudget = input.aiUsageBudget === null || !hasBudget ? undefined : usageBudget(input.aiUsageBudget);
	if (hasBudget && input.aiUsageBudget !== null && !aiUsageBudget) throw new Error("Invalid AI usage budget");
	return {
		localDiagnostics: input.localDiagnostics,
		...(input.localFeatureUsage === undefined ? {} : { localFeatureUsage: input.localFeatureUsage as boolean }),
		remoteOperational: input.remoteOperational,
		productAnalytics: input.productAnalytics,
		...(endpoint ? { endpoint } : {}),
		...(hasBudget ? { aiUsageBudget: aiUsageBudget ?? null } : {}),
	};
}

export class TelemetrySettingsService {
	readonly featureUsage: FeatureUsageStore;
	private value: StoredTelemetrySettings;
	private readonly file: string;
	private readonly hostKind: TelemetrySettings["hostKind"];
	private readonly hello: DaemonHello;
	private readonly listeners = new Set<(settings: TelemetrySettings) => void>();
	private saving = Promise.resolve();
	private nextControlKnown = true;

	private constructor(home: string, hello: DaemonHello, value: StoredTelemetrySettings) {
		this.featureUsage = new FeatureUsageStore(home);
		this.file = join(home, FILE);
		this.hello = hello;
		this.value = value;
		this.hostKind = process.platform === "linux" ? "devbox" : "local";
	}

	static async open(home: string, hello: DaemonHello): Promise<TelemetrySettingsService> {
		let value: StoredTelemetrySettings | undefined;
		let missing = false;
		try {
			value = stored(JSON.parse(await readFile(join(home, FILE), "utf8")));
		} catch (error) {
			missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		}
		const service = new TelemetrySettingsService(home, hello, value ?? defaults());
		service.nextControlKnown = !!value || missing;
		if (!value) await service.persist();
		else await chmod(service.file, 0o600);
		await service.featureUsage.load(value?.localFeatureUsage === true);
		return service;
	}

	settings(): TelemetrySettings {
		return {
			schemaVersion: SCHEMA,
			hostKind: this.hostKind,
			hostId: this.hostId(),
			localDiagnostics: this.value.localDiagnostics,
			...(this.nextControlKnown
				? { nextDiagnostics: { schemaVersion: 1 as const, epoch: this.value.nextDiagnosticsEpoch ?? 0 } }
				: {}),
			localFeatureUsage: this.value.localFeatureUsage === true,
			...(this.featureUsage.collectionEpoch ? { featureUsageEpoch: this.featureUsage.collectionEpoch } : {}),
			remoteOperational: this.value.remoteOperational,
			productAnalytics: this.value.productAnalytics,
			...(this.hostKind === "local" && this.value.productAnalytics ? { analyticsId: this.value.analyticsId } : {}),
			...(this.value.endpoint ? { endpoint: this.value.endpoint } : {}),
			...(this.value.aiUsageBudget ? { aiUsageBudget: this.value.aiUsageBudget } : {}),
			...(this.value.updatedAt ? { updatedAt: this.value.updatedAt } : {}),
		};
	}

	async update(input: unknown): Promise<TelemetrySettings> {
		const next = patch(input);
		const revokedAnalytics = this.value.productAnalytics && !next.productAnalytics;
		const aiUsageBudget = Object.hasOwn(next, "aiUsageBudget")
			? (next.aiUsageBudget ?? undefined)
			: this.value.aiUsageBudget;
		this.value = {
			...this.value,
			...next,
			...(!next.localDiagnostics || !this.nextControlKnown ? { nextDiagnosticsEpoch: nextEpoch() } : {}),
			endpoint: next.endpoint,
			aiUsageBudget,
			updatedAt: new Date().toISOString(),
			...(revokedAnalytics ? { analyticsId: randomIdentifier() } : {}),
		};
		await this.persist();
		this.nextControlKnown = true;
		await this.featureUsage.configure(this.value.localFeatureUsage === true);
		const settings = this.settings();
		for (const listener of this.listeners) {
			try {
				listener(settings);
			} catch {}
		}
		return settings;
	}

	/** Persist a privacy epoch; only the native writer drains and clears its own slots. */
	async clearNextDiagnostics(): Promise<void> {
		this.value = { ...this.value, nextDiagnosticsEpoch: nextEpoch() };
		await this.persist();
		for (const listener of this.listeners) listener(this.settings());
	}

	onChange(listener: (settings: TelemetrySettings) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	nodeOptions(serviceName: "pilot.daemon" | "pilot.kernel"): NodeTelemetryOptions {
		return {
			enabled: this.value.remoteOperational,
			serviceName,
			serviceVersion: this.hello.daemonVersion,
			environment: environment(),
			hostKind: this.hostKind,
			hostId: this.hostId(),
			...(this.value.endpoint ? { endpoint: this.value.endpoint } : {}),
		};
	}

	kernelSettings(): KernelTelemetrySettings {
		const options = this.nodeOptions("pilot.kernel");
		return {
			enabled: options.enabled,
			serviceVersion: options.serviceVersion,
			environment: options.environment,
			hostKind: options.hostKind,
			hostId: options.hostId!,
			localDiagnostics: this.value.localDiagnostics,
			...(options.endpoint ? { endpoint: options.endpoint } : {}),
		};
	}

	private hostId(): string {
		const key = Buffer.from(this.value.hostKey, "base64url");
		return createHmac("sha256", key)
			.update(`${this.hello.daemonId}\0${this.hello.lineageId ?? ""}`)
			.digest()
			.subarray(0, 16)
			.toString("base64url")
			.toLowerCase();
	}

	private async persist(): Promise<void> {
		const value = `${JSON.stringify(this.value)}\n`;
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
				const temporary = `${this.file}.tmp`;
				await writeFile(temporary, value, { mode: 0o600 });
				await chmod(temporary, 0o600);
				await rename(temporary, this.file);
				await chmod(this.file, 0o600);
			});
		await this.saving;
	}
}
