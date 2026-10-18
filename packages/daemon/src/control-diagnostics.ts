/** Control-only, read-only diagnostics. No shell, worker starts, configuration writes or arbitrary paths. */
import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionDiagnostics } from "@pilot/protocol";
import release from "../../../package.json" with { type: "json" };
import { isCredentialField, redactDiagnosticText } from "./diagnostic-redaction.ts";

export const CONTROL_DIAGNOSTIC_BYTES = 24_000;
export const CONTROL_LOG_SCAN_BYTES = 64 * 1024;
const MAX_LIMIT = 40;
const MAX_PENDING = 4;
const runtimeRoot = fileURLToPath(new URL("../../../", import.meta.url));

interface FileTail {
	text: string;
	available: boolean;
	truncated: boolean;
}

/** Nonblocking open also refuses FIFOs/devices; no raw filesystem errors reach the model. */
async function tail(path: string, bytes = CONTROL_LOG_SCAN_BYTES, records = false): Promise<FileTail> {
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const stat = await handle.stat();
		if (!stat.isFile()) return { text: "", available: false, truncated: false };
		const length = Math.min(stat.size, bytes);
		const buffer = Buffer.alloc(length);
		const start = stat.size - length;
		const { bytesRead } = await handle.read(buffer, 0, length, start);
		let text = buffer.subarray(0, bytesRead).toString("utf8");
		// Never expose a partial first record (including a fragment of a credential).
		if (start) text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
		// A concurrently appended, unfinished record is not safe to return either.
		const unfinished = records && !!text && !text.endsWith("\n");
		if (unfinished) text = text.slice(0, text.lastIndexOf("\n") + 1);
		return { text, available: true, truncated: start > 0 || bytesRead < length || unfinished };
	} catch {
		return { text: "", available: false, truncated: false };
	} finally {
		await handle?.close().catch(() => undefined);
	}
}

function limitArg(value: unknown): number {
	if (value === undefined) return 20;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT)
		throw new Error("limit must be 1..40");
	return value;
}

function quote(source: string, value: unknown) {
	// All strings, including future health fields, pass the same redaction boundary.
	const quotedContent = JSON.parse(
		JSON.stringify(value, (key, v) =>
			isCredentialField(key) ? "[REDACTED]" : typeof v === "string" ? redactDiagnosticText(v) : v,
		),
	);
	const result = {
		untrusted: true,
		source,
		quotedContent,
		truncated: quotedContent.truncated === true || quotedContent.truncation?.truncated === true,
	};
	const rows = Array.isArray(quotedContent.records) ? quotedContent.records : quotedContent.evidence;
	if (quotedContent.truncation) quotedContent.truncation.maxBytes = CONTROL_DIAGNOSTIC_BYTES;
	const encodedBytes = () => {
		if (quotedContent.truncation) {
			for (let pass = 0; pass < 3; pass++)
				quotedContent.truncation.encodedBytes = Buffer.byteLength(JSON.stringify(result));
		}
		return Buffer.byteLength(JSON.stringify(result));
	};
	while (encodedBytes() > CONTROL_DIAGNOSTIC_BYTES) {
		result.truncated = true;
		if (Array.isArray(rows) && rows.length) {
			if (quotedContent.records) rows.shift();
			else rows.pop();
			if (quotedContent.truncation) {
				quotedContent.truncation.returned = rows.length;
				quotedContent.truncation.truncated = true;
			}
		} else {
			result.quotedContent = { available: false, reason: "Evidence exceeded the response byte limit" };
			break;
		}
	}
	return result;
}

export interface ControlDiagnosticsOptions {
	home: string;
	daemonLog?: string;
	/** Current-process ring for journal-only hosts. Already redacted and byte bounded. */
	daemonTail?: () => FileTail;
	runtimeRoot?: string;
	daemonId: string;
	lineageId?: string;
	localDiagnostics: () => boolean;
	health: () => unknown;
	/** Resolves only a registered session, never a caller-supplied filesystem path. */
	sessionDirectory: (sessionId: string) => string;
	evidence: (sessionId: string, limit: number) => Promise<SessionDiagnostics>;
	evidenceSummary: () => unknown;
}

export class ControlDiagnostics {
	private pending = 0;
	private readonly options: ControlDiagnosticsOptions;
	constructor(options: ControlDiagnosticsOptions) {
		this.options = options;
	}
	async call(action: string, args: Record<string, unknown>) {
		if (this.pending >= MAX_PENDING) throw new Error("Diagnostics busy; retry after pending reads finish");
		this.pending++;
		try {
			if (action === "health") return quote("health", await this.health());
			const limit = limitArg(args.limit);
			if (action === "logs") return await this.logs(args, limit);
			if (action !== "telemetry") throw new Error("Unknown diagnostics action");
			if (!this.options.localDiagnostics())
				return quote("telemetry", { enabled: false, reason: "Local diagnostics are disabled; no evidence read" });
			const evidence =
				args.sessionId === undefined
					? { summary: this.options.evidenceSummary() }
					: await this.options.evidence(this.sessionId(args), limit);
			// Consent may have changed while asynchronous evidence reads were pending.
			if (!this.options.localDiagnostics())
				return quote("telemetry", { enabled: false, reason: "Local diagnostics are disabled; evidence withheld" });
			return quote("telemetry", { enabled: true, collectedAt: new Date().toISOString(), ...evidence });
		} finally {
			this.pending--;
		}
	}
	private sessionId(args: Record<string, unknown>): string {
		if (typeof args.sessionId !== "string" || !/^[a-f0-9-]{36}$/i.test(args.sessionId))
			throw new Error("A registered sessionId is required");
		return args.sessionId;
	}
	private async health() {
		const root = this.options.runtimeRoot ?? runtimeRoot;
		const info = root.replace(/\/$/, "").endsWith(".app/Contents/Resources/runtime")
			? await tail(join(root, "../../Info.plist"))
			: { text: "", available: false, truncated: false };
		const plistString = (key: string) =>
			!info.truncated
				? info.text.match(new RegExp(`<key>${key}</key>\\s*<string>([0-9.]{1,80})</string>`))?.[1]
				: undefined;
		const installedVersion = plistString("CFBundleShortVersionString"),
			installedBuild = plistString("CFBundleVersion");
		const updateFile = await tail(join(this.options.home, "runtime-update/current.json"), 128 * 1024);
		let update: unknown = {
			available: false,
			reason: "No runtime update journal; native app updater is not observable",
		};
		if (updateFile.available) {
			try {
				if (updateFile.truncated) throw new Error();
				const value = JSON.parse(updateFile.text);
				if (
					value.schema !== 1 ||
					!Number.isSafeInteger(value.revision) ||
					value.revision < 1 ||
					typeof value.version !== "string" ||
					!/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(value.version) ||
					value.version.length > 80 ||
					value.daemonId !== this.options.daemonId ||
					value.lineageId !== this.options.lineageId ||
					![
						"staged",
						"requested",
						"waiting",
						"draining",
						"ready",
						"stopping",
						"switching",
						"validating",
						"needs-repair",
						"completed",
						"cancelled",
					].includes(value.phase)
				)
					throw new Error();
				update = { available: true, phase: value.phase, version: value.version, revision: value.revision };
			} catch {
				update = { available: false, reason: "Runtime update journal is invalid or belongs to another host" };
			}
		}
		return {
			collectedAt: new Date().toISOString(),
			daemon: { version: release.version, uptimeMs: Math.floor(process.uptime() * 1000) },
			runtime: {
				version: release.version,
				node: process.versions.node,
				platform: process.platform,
				arch: process.arch,
			},
			app: {
				runningVersion: "unavailable",
				...(installedVersion && installedBuild
					? {
							installedVersion,
							installedBuild,
							source: "runtime-adjacent bundle metadata, not running app identity",
						}
					: { installedVersion: "unavailable", installedBuild: "unavailable" }),
			},
			localDiagnostics: this.options.localDiagnostics(),
			sessions: this.options.health(),
			update,
		};
	}
	private async logs(args: Record<string, unknown>, limit: number) {
		if (!["daemon", "lifecycle", "session"].includes(String(args.source)))
			throw new Error("source must be daemon, lifecycle or session");
		if (args.q !== undefined && (typeof args.q !== "string" || args.q.length > 200))
			throw new Error("q must be at most 200 characters (literal case-insensitive text)");
		let since: number | undefined;
		if (args.since !== undefined) {
			if (
				typeof args.since !== "string" ||
				args.since.length > 64 ||
				!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(args.since) ||
				!Number.isFinite(Date.parse(args.since))
			)
				throw new Error("since must be an ISO timestamp with timezone");
			since = Date.parse(args.since);
		}
		const source = args.source as string;
		const directory = source === "daemon" ? undefined : this.options.sessionDirectory(this.sessionId(args));
		if (source !== "daemon" && !this.options.localDiagnostics())
			return quote("logs", {
				source,
				enabled: false,
				reason: "Local diagnostics are disabled; no logs read",
				records: [],
			});
		if (directory) {
			// Refuse redirected session/durable directories as well as leaf symlinks.
			const expected = join(await realpath(this.options.home), "sessions", args.sessionId as string);
			if (
				(await realpath(directory).catch(() => "")) !== expected ||
				(source === "session" && (await lstat(join(directory, "durable")).catch(() => undefined))?.isSymbolicLink())
			)
				return quote("logs", { source, available: false, reason: "Diagnostic directory unavailable", records: [] });
		}
		const paths =
			source === "daemon"
				? this.options.daemonLog
					? [this.options.daemonLog]
					: []
				: source === "lifecycle"
					? [join(directory!, "lifecycle.jsonl")]
					: [join(directory!, "durable/performance.jsonl"), join(directory!, "durable/tool-activity.jsonl")];
		const reads = await Promise.all(
			paths.flatMap((path) => [`${path}.1`, path]).map((path) => tail(path, CONTROL_LOG_SCAN_BYTES, true)),
		);
		if (source === "daemon" && !paths.length && this.options.daemonTail) reads.push(this.options.daemonTail());
		const query = (args.q as string | undefined)?.toLowerCase();
		const records = reads
			.flatMap((read) => {
				// Redact the whole window before splitting, including multiline private-key blocks.
				return redactDiagnosticText(read.text)
					.split("\n")
					.filter(Boolean)
					.flatMap((text) => {
						let at: number | undefined;
						try {
							const value = JSON.parse(text);
							at = typeof value.at === "number" ? value.at : Date.parse(value.at);
						} catch {
							const stamp = text.match(/^\[([^\]]+)\]/)?.[1];
							if (stamp) at = Date.parse(stamp);
						}
						if (since !== undefined && (at === undefined || !Number.isFinite(at) || at < since)) return [];
						if (query && !text.toLowerCase().includes(query)) return [];
						return [
							{
								...(Number.isFinite(at) ? { at } : {}),
								text: text.length > 3000 ? `${text.slice(0, 3000)} [clipped]` : text,
							},
						];
					});
			})
			.sort((a, b) => (a.at ?? 0) - (b.at ?? 0));
		if (source !== "daemon" && !this.options.localDiagnostics())
			return quote("logs", {
				source,
				enabled: false,
				reason: "Local diagnostics are disabled; evidence withheld",
				records: [],
			});
		return quote("logs", {
			source,
			available: reads.some((read) => read.available),
			...(source !== "daemon" ? { sessionId: args.sessionId } : {}),
			reason: source === "session" ? "Operational timing/tool records only, not conversation history" : undefined,
			...(source === "daemon" && !paths.length
				? { reason: "Current-process log ring only; historical journal access is unavailable (no shell)" }
				: {}),
			scanBytes: paths.length * 2 * CONTROL_LOG_SCAN_BYTES,
			truncated:
				reads.some((read) => read.truncated) ||
				records.length > limit ||
				records.some((row) => row.text.endsWith(" [clipped]")),
			records: records.slice(-limit),
		});
	}
}
