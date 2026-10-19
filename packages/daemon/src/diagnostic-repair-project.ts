import { randomUUID } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type {
	DiagnosticRepairProjectBinding,
	DiagnosticRepairProjectSetup,
	DiagnosticRepairProjectStatus,
	OperationHost,
} from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";
import { Conflict } from "./errors.ts";
import { durableJSON } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";

/** Navigation identity from local Git config, not a claim of cryptographic repository ownership. */
export const PILOT_REPAIR_ORIGIN = '["github.com","babariviere/pilot"]';
const MAX_BYTES = 8192;
const SINGLE_LINE_CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function diagnosticRepairTitle(value: unknown, findings: string): string {
	if (value !== undefined) {
		if (typeof value !== "string" || SINGLE_LINE_CONTROL.test(value))
			throw new Conflict("Repair title must be single-line plain text");
		const title = value.trim();
		if (!title || title.length > 160 || Buffer.byteLength(title) > 480 || redactDiagnosticText(title) !== title)
			throw new Conflict("Repair title must be bounded plain text without credentials");
		return title;
	}
	// Compatibility for existing proposals. No model request, chat name, raw log or destination supplies the title.
	const line = redactDiagnosticText(findings)
		.split(/[\r\n]/u)
		.find((item) => item.trim());
	const plain = (line ?? "")
		.replace(/^[#>*\s-]+/u, "")
		.replace(new RegExp(SINGLE_LINE_CONTROL.source, "gu"), "")
		.trim();
	let title = "";
	for (const part of plain || "Investigate reported application issue") {
		if (title.length + part.length > 150) break;
		title += part;
	}
	return title;
}

export function repairHost(value: unknown): OperationHost {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Conflict("Invalid repair host");
	const host = value as Record<string, unknown>;
	if (
		Object.keys(host).sort().join(",") !== "daemonId,hostId,lineageId" ||
		[host.hostId, host.daemonId, host.lineageId].some(
			(part) => typeof part !== "string" || !/^[a-zA-Z0-9._-]{1,128}$/u.test(part),
		)
	)
		throw new Conflict("Invalid repair host");
	return host as unknown as OperationHost;
}

function binding(value: unknown): DiagnosticRepairProjectBinding {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Conflict("Invalid repair binding");
	const item = value as DiagnosticRepairProjectBinding;
	if (
		Object.keys(item).sort().join(",") !== "configuredAt,host,id,origin,path,projectId,revision,schemaVersion" ||
		item.schemaVersion !== 1 ||
		!/^[-0-9a-f]{36}$/u.test(item.id) ||
		!Number.isSafeInteger(item.revision) ||
		item.revision < 1 ||
		typeof item.projectId !== "string" ||
		!/^[a-zA-Z0-9._-]{1,128}$/u.test(item.projectId) ||
		typeof item.path !== "string" ||
		item.path.length > 2048 ||
		SINGLE_LINE_CONTROL.test(item.path) ||
		resolve(item.path) !== item.path ||
		item.origin !== PILOT_REPAIR_ORIGIN ||
		typeof item.configuredAt !== "string" ||
		!Number.isFinite(Date.parse(item.configuredAt))
	)
		throw new Conflict("Invalid repair binding");
	repairHost(item.host);
	return structuredClone(item);
}

/** Purpose-specific private configuration. All writes and repair admissions share one serialization fence. */
export class DiagnosticRepairProjectStore {
	readonly file: string;
	private loaded = false;
	private invalid = false;
	private current?: DiagnosticRepairProjectBinding;
	private pending: Promise<unknown> = Promise.resolve();
	private closed = false;
	private queued = 0;
	private readonly projects: ProjectStore;
	private readonly host?: OperationHost;

	constructor(home: string, projects: ProjectStore, host?: OperationHost) {
		this.file = join(home, "diagnostic-repair-project.json");
		this.projects = projects;
		this.host = host;
	}

	private exclusive<T>(work: () => Promise<T>): Promise<T> {
		if (this.closed) return Promise.reject(new Conflict("Repair configuration is closing"));
		if (this.queued >= 32) return Promise.reject(new Conflict("Repair configuration is busy; try again later"));
		this.queued++;
		const result = this.pending
			.then(async () => {
				if (this.closed) throw new Conflict("Repair configuration is closing");
				await this.load();
				return work();
			})
			.finally(() => {
				this.queued--;
			});
		this.pending = result.catch(() => undefined);
		return result;
	}

	async close(): Promise<void> {
		this.closed = true;
		await this.pending;
	}

	private async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const file = await open(this.file, "r");
			try {
				const size = (await file.stat()).size;
				if (size > MAX_BYTES || size < 2) throw new Error("Invalid size");
				const bytes = Buffer.alloc(MAX_BYTES + 1);
				const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
				if (bytesRead > MAX_BYTES) throw new Error("Too large");
				this.current = binding(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")));
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") this.invalid = true;
		}
	}

	private async problem(item: DiagnosticRepairProjectBinding): Promise<DiagnosticRepairProjectStatus["reason"]> {
		if (!this.host || item.host.daemonId !== this.host.daemonId || item.host.lineageId !== this.host.lineageId)
			return "identity_changed";
		const project = this.projects.get(item.projectId);
		if (!project) return "project_missing";
		try {
			if (project.path !== item.path || (await realpath(project.path)) !== item.path) return "path_changed";
			if ((await this.projects.origin(item.projectId)).identity !== item.origin) return "origin_changed";
			if (this.projects.get(item.projectId)?.path !== item.path) return "path_changed";
		} catch {
			return "project_missing";
		}
		return undefined;
	}

	status(): Promise<DiagnosticRepairProjectStatus> {
		return this.exclusive(async () => {
			if (this.invalid) return { state: "invalid", revision: 0, reason: "storage" };
			if (!this.current) return { state: "missing", revision: 0 };
			const reason = await this.problem(this.current);
			return {
				state: reason ? "unavailable" : "available",
				revision: this.current.revision,
				binding: structuredClone(this.current),
				...(reason ? { reason } : {}),
			};
		});
	}

	configure(value: DiagnosticRepairProjectSetup): Promise<DiagnosticRepairProjectStatus> {
		return this.exclusive(async () => {
			if (this.invalid) throw new Conflict("Repair configuration is unreadable; it has been preserved, not reset");
			if (
				!value ||
				Object.keys(value).sort().join(",") !== "expectedRevision,host,origin,path,projectId" ||
				value.expectedRevision !== (this.current?.revision ?? 0)
			)
				throw new Conflict("Repair project configuration changed; review it again");
			const candidate = binding({
				schemaVersion: 1,
				id: randomUUID(),
				revision: value.expectedRevision + 1,
				host: repairHost(value.host),
				projectId: value.projectId,
				path: value.path,
				origin: value.origin,
				configuredAt: new Date().toISOString(),
			});
			if (await this.problem(candidate))
				throw new Conflict("Select a registered, verified Pilot source checkout on this host");
			await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
			try {
				await durableJSON(this.file, candidate);
			} catch (error) {
				this.invalid = true;
				throw error;
			}
			this.current = candidate;
			return { state: "available", revision: candidate.revision, binding: structuredClone(candidate) };
		});
	}

	assertCurrent(value: unknown): DiagnosticRepairProjectBinding {
		if (this.invalid)
			throw new Conflict("Repair project configuration is unavailable; its original data was preserved");
		const item = binding(value);
		if (!this.current || JSON.stringify(item) !== JSON.stringify(this.current)) {
			// Key order is not identity. Compare normalized fields instead.
			if (
				!this.current ||
				Object.keys(this.current).some((key) => {
					const field = key as keyof DiagnosticRepairProjectBinding;
					return field === "host"
						? Object.keys(this.current!.host).some(
								(part) =>
									item.host[part as keyof OperationHost] !== this.current!.host[part as keyof OperationHost],
							)
						: item[field] !== this.current![field];
				})
			)
				throw new Conflict("Repair project binding changed; review the configured destination again");
		}
		return item;
	}

	/** Held through committed session admission, not workspace creation or model execution. */
	withBinding<T>(value: unknown, work: (item: DiagnosticRepairProjectBinding) => Promise<T>): Promise<T> {
		return this.exclusive(async () => {
			const item = this.assertCurrent(value);
			if (await this.problem(item))
				throw new Conflict("Configured Pilot repair project is unavailable; explicit setup is required");
			this.assertCurrent(value);
			return work(item);
		});
	}

	/** Final recheck after asynchronous admission preparation, while the caller holds withBinding. */
	async validateCurrent(value: unknown): Promise<void> {
		const item = this.assertCurrent(value);
		if (await this.problem(item)) throw new Conflict("Configured Pilot repair project changed during preparation");
		this.assertCurrent(value);
	}
}
