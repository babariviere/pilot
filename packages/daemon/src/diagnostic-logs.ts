/** Bounded, fixed-catalogue Pilot log reads for diagnostics specialists. No arbitrary paths or subprocesses. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
	DiagnosticLogExcerpt,
	DiagnosticLogPage,
	DiagnosticLogRecord,
	DiagnosticLogRequest,
	DiagnosticLogResult,
	DiagnosticLogSourceId,
	DiagnosticLogSourceInventory,
} from "@pilot/kernel";
import type { OperationHost } from "@pilot/protocol";
import { redactDiagnosticText } from "./diagnostic-redaction.ts";
import { operations } from "./event-loop-watchdog.ts";
import { nativeAppLogLine } from "./native-app-log.ts";

export const DIAGNOSTIC_LOG_SCAN_BYTES = 128 * 1024;
export const DIAGNOSTIC_LOG_OUTPUT_BYTES = 64 * 1024;
export const DIAGNOSTIC_LOG_RECORD_BYTES = 8 * 1024;
const READ_CHUNK_BYTES = 32 * 1024;
const CONTEXT_BYTES = 32 * 1024;
const CONTEXT_RECORD_BYTES = 2 * 1024;
const MAX_RAW_RECORD_BYTES = 64 * 1024;
const MAX_PENDING = 4;
const MAX_REPORT_DIRECTORY_ENTRIES = 256;
const MAX_REPORT_FILES = 32;
const SOURCE_IDS = new Set<DiagnosticLogSourceId>([
	"app",
	"daemon",
	"kernel_worker",
	"native_report",
	"lifecycle",
	"request_timing",
	"tool_activity",
]);
const REPORT_NAME = /^Pilot(?:_|-)[^/]{1,160}\.(?:ips|crash|hang|diag|spin)$/i;
const CURSOR_PREFIX = "diagnostic-log-cursor:v1:";
const REF_PREFIX = "diagnostic-log:v1:";

interface FileCandidate {
	token: string;
	path?: string;
	virtual?: Buffer;
	rotated: boolean;
	fallbackAt?: string;
	privateApp?: boolean;
}

interface InspectedCandidate extends FileCandidate {
	dev: string;
	ino: string;
	size: number;
	mtimeMs: number;
}

interface SourceDescriptor extends DiagnosticLogSourceInventory {
	files: InspectedCandidate[];
	line?: (raw: string) => string | undefined;
}

interface CursorPayload {
	s: DiagnosticLogSourceId;
	f: string;
	x: string;
	p: number;
	h: string;
}

interface RefPayload {
	s: DiagnosticLogSourceId;
	f: string;
	x: string;
	o: number;
	l: number;
}

export interface DiagnosticLogReaderOptions {
	home: string;
	daemonLog?: string;
	/** Host-owned fixed native producer path, never a diagnostic tool argument. */
	appLog?: string;
	/** Current-process daemon console ring. It does not contain inherited kernel stdout/stderr. */
	daemonTail?: () => { text: string; available: boolean; truncated: boolean };
	diagnosticReports?: string;
	platform?: NodeJS.Platform;
	maxScanBytes?: number;
	maxOutputBytes?: number;
	now?: () => Date;
}

function opaque(prefix: string, value: object, secret: Buffer): string {
	const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
	const signature = createHmac("sha256", secret)
		.update(prefix)
		.update(encoded)
		.digest()
		.subarray(0, 16)
		.toString("base64url");
	return `${prefix}${encoded}.${signature}`;
}

function parseOpaque<T extends object>(prefix: string, value: unknown, secret: Buffer): T | undefined {
	if (typeof value !== "string" || value.length > 768 || !value.startsWith(prefix)) return undefined;
	const [encoded, signature, ...extra] = value.slice(prefix.length).split(".");
	if (!encoded || !signature || extra.length) return undefined;
	if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
	try {
		const supplied = Buffer.from(signature, "base64url");
		const expected = createHmac("sha256", secret).update(prefix).update(encoded).digest().subarray(0, 16);
		if (
			supplied.toString("base64url") !== signature ||
			supplied.length !== expected.length ||
			!timingSafeEqual(supplied, expected)
		)
			return undefined;
		const decoded = Buffer.from(encoded, "base64url");
		if (decoded.toString("base64url") !== encoded) return undefined;
		const parsed = JSON.parse(decoded.toString("utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as T) : undefined;
	} catch {
		return undefined;
	}
}

function filterHash(source: string, query: string | undefined, since: number | undefined): string {
	return createHash("sha256")
		.update(JSON.stringify([source, query ?? null, since ?? null]))
		.digest("hex")
		.slice(0, 24);
}

function logTimestamp(text: string, fallback?: string): string | undefined {
	try {
		const value = JSON.parse(text) as { at?: unknown };
		const parsed =
			typeof value.at === "number" ? value.at : typeof value.at === "string" ? Date.parse(value.at) : NaN;
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	} catch {}
	const prefix = text.match(/^\[([^\]]{1,80})\]/)?.[1];
	if (prefix) {
		const parsed = Date.parse(prefix);
		if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
	}
	return fallback;
}

/** Preserve useful errors/stacks while dropping fields known to carry model, transcript or integration payloads. */
export function sanitizeDiagnosticLogLine(text: string): string {
	const credentialSafe = timedRedaction(text);
	if (credentialSafe !== text) return credentialSafe;
	if (
		/(?<![\w-])(?:prompt|messages?|conversation|transcript|reasoning|thinking|tool[_-]?(?:arguments?|results?|output)|request[_-]?body|response[_-]?body|attachments?|input[_-]?text|output[_-]?text|content|payload|blocks?|body|data|text|(?:slack|linear|github|integration)[_-]?(?:event|payload|body|data))["' \t]*[:=]/i.test(
			text,
		) ||
		/(?:^|\]\s+)(?:user|assistant|system|tool)(?:\s+message)?\s*:/i.test(text) ||
		/<\/?(?:user|assistant|tool_result|thinking)>/i.test(text) ||
		/"type"\s*:\s*"text"\s*,\s*"text"\s*:/i.test(text)
	)
		return "[WITHHELD conversation-bearing log record]";
	return text;
}

function clipped(text: string, bytes: number): { text: string; truncated: boolean } {
	const buffer = Buffer.from(text);
	if (buffer.length <= bytes) return { text, truncated: false };
	const suffix = " [clipped]";
	let end = Math.max(0, bytes - Buffer.byteLength(suffix));
	while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
	return { text: `${buffer.subarray(0, end).toString("utf8")}${suffix}`, truncated: true };
}

function wholeWindowRedaction(buffer: Buffer, start = 0, end = buffer.length): string | undefined {
	const redacted = timedRedaction(buffer.subarray(start, end).toString("utf8"));
	return redacted === "[REDACTED multiline credential record]" || redacted === "[REDACTED private-key material]"
		? redacted
		: undefined;
}

function timedRedaction(text: string): string {
	// Fixed, content-free label. The shared tracker retains only bounded slow-section timings, not log text.
	return operations.time("diagnostics.redact", () => redactDiagnosticText(text));
}

function inventory(descriptor: SourceDescriptor): DiagnosticLogSourceInventory {
	const { files: _files, line: _line, ...result } = descriptor;
	return result;
}

function unavailablePage(
	source: DiagnosticLogSourceId,
	descriptor: SourceDescriptor,
	maxScanBytes: number,
): DiagnosticLogPage {
	return {
		source,
		status: descriptor.availability === "disabled" ? "disabled" : "unavailable",
		records: [],
		scannedBytes: 0,
		maxScanBytes,
		encodedBytes: 0,
		maxBytes: DIAGNOSTIC_LOG_OUTPUT_BYTES,
		oversizedRecords: 0,
		truncated: descriptor.catalogTruncated,
		reason: descriptor.reason ?? "No safely readable retained source is available",
	};
}

export class DiagnosticLogReader {
	private pending = 0;
	private readonly opaqueSecret = randomBytes(32);
	private readonly options: DiagnosticLogReaderOptions;
	private readonly maxScanBytes: number;
	private readonly maxOutputBytes: number;

	constructor(options: DiagnosticLogReaderOptions) {
		this.options = options;
		this.maxScanBytes = options.maxScanBytes ?? DIAGNOSTIC_LOG_SCAN_BYTES;
		this.maxOutputBytes = options.maxOutputBytes ?? DIAGNOSTIC_LOG_OUTPUT_BYTES;
	}

	async call(
		host: OperationHost,
		target: { sessionId: string; directory: string } | undefined,
		localDiagnostics: boolean,
		request: DiagnosticLogRequest,
	): Promise<DiagnosticLogResult> {
		if (this.pending >= MAX_PENDING)
			throw new Error("Diagnostic log reads are busy; retry after pending reads finish");
		this.pending++;
		try {
			const parsed = this.request(request);
			const base = {
				schemaVersion: 1 as const,
				host: { ...host },
				scope: target ? ("chat" as const) : ("app" as const),
				...(target ? { targetSessionId: target.sessionId } : {}),
				collectedAt: (this.options.now?.() ?? new Date()).toISOString(),
				untrusted: true as const,
				action: parsed.action,
			};
			if (parsed.action === "inventory") {
				const sources = await this.sources(host, target, localDiagnostics);
				return { ...base, sources: [...sources.values()].map(inventory) };
			}
			if (parsed.action === "search") {
				const sources = await this.sources(host, target, localDiagnostics, new Set([parsed.source]));
				const descriptor = sources.get(parsed.source)!;
				return { ...base, page: await this.search(descriptor, parsed) };
			}
			const ref = parseOpaque<RefPayload>(REF_PREFIX, parsed.ref, this.opaqueSecret);
			const sources = await this.sources(
				host,
				target,
				localDiagnostics,
				new Set(ref && SOURCE_IDS.has(ref.s) ? [ref.s] : []),
			);
			return { ...base, excerpt: await this.excerpt(sources, parsed) };
		} finally {
			this.pending--;
		}
	}

	private request(value: DiagnosticLogRequest): DiagnosticLogRequest {
		if (!value || typeof value !== "object" || Array.isArray(value))
			throw new Error("Invalid diagnostic log request");
		if (value.action === "inventory") {
			if (Object.keys(value).join(",") !== "action") throw new Error("Invalid log inventory request");
			return value;
		}
		if (value.action === "search") {
			if (!SOURCE_IDS.has(value.source)) throw new Error("Unknown diagnostic log source");
			if (value.q !== undefined && (typeof value.q !== "string" || value.q.length > 200))
				throw new Error("q must be at most 200 characters of literal text");
			if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 768))
				throw new Error("Invalid diagnostic log cursor");
			if (value.limit !== undefined && (!Number.isInteger(value.limit) || value.limit < 1 || value.limit > 40))
				throw new Error("limit must be between 1 and 40");
			if (value.since !== undefined) this.since(value.since);
			if (Object.keys(value).some((key) => !["action", "source", "q", "since", "cursor", "limit"].includes(key)))
				throw new Error("Invalid log search request");
			return value;
		}
		if (value.action === "excerpt") {
			if (typeof value.ref !== "string" || value.ref.length > 768) throw new Error("Invalid diagnostic log ref");
			for (const count of [value.before, value.after])
				if (count !== undefined && (!Number.isInteger(count) || count < 0 || count > 10))
					throw new Error("excerpt context must be between 0 and 10 lines");
			if (Object.keys(value).some((key) => !["action", "ref", "before", "after"].includes(key)))
				throw new Error("Invalid log excerpt request");
			return value;
		}
		throw new Error("Unknown diagnostic log action");
	}

	private since(value: string): number {
		if (
			value.length > 64 ||
			!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) ||
			!Number.isFinite(Date.parse(value))
		)
			throw new Error("since must be an ISO timestamp with timezone");
		return Date.parse(value);
	}

	private async sources(
		host: OperationHost,
		target: { sessionId: string; directory: string } | undefined,
		localDiagnostics: boolean,
		selected: ReadonlySet<DiagnosticLogSourceId> = SOURCE_IDS,
	): Promise<Map<DiagnosticLogSourceId, SourceDescriptor>> {
		const result = new Map<DiagnosticLogSourceId, SourceDescriptor>();
		if (selected.has("app")) {
			const path = this.options.appLog;
			const supported = (this.options.platform ?? process.platform) === "darwin" && !!path;
			const files =
				supported && localDiagnostics
					? await this.fixedFiles([
							{ token: "app-current", path, rotated: false, privateApp: true },
							{ token: "app-rotated", path: `${path}.1`, rotated: true, privateApp: true },
						])
					: { files: [], reason: "not_recorded" as const };
			result.set("app", {
				id: "app",
				scope: "host",
				availability: !localDiagnostics ? "disabled" : files.files.length ? "available" : "unavailable",
				coverage:
					"Private native app lifecycle, transport and repair event/error codes on this Mac only; retained history does not establish app liveness. No payloads or comprehensive crash capture. Expired, invalid and other-identity records are excluded.",
				retention: "bounded_local",
				availableFiles: files.files.length,
				rotatedFiles: files.files.filter((file) => file.rotated).length,
				catalogTruncated: false,
				reason: !localDiagnostics ? "disabled" : files.reason,
				files: files.files,
				line: (raw) => nativeAppLogLine(raw, host, (this.options.now?.() ?? new Date()).getTime()),
			});
		}

		const needsDaemon = selected.has("daemon") || selected.has("kernel_worker");
		const daemonFiles = needsDaemon
			? await this.fixedFiles(
					this.options.daemonLog
						? [
								{ token: "current", path: this.options.daemonLog, rotated: false },
								{ token: "rotated", path: `${this.options.daemonLog}.1`, rotated: true },
							]
						: [],
				)
			: { files: [] as InspectedCandidate[], reason: undefined };
		let daemonReason = daemonFiles.reason;
		let daemonCandidates = daemonFiles.files;
		let daemonRetention: DiagnosticLogSourceInventory["retention"] = "current_and_rotated";
		let daemonCatalogTruncated = false;
		if (needsDaemon && !daemonCandidates.length && this.options.daemonTail) {
			const tail = this.options.daemonTail();
			if (tail.available) {
				const buffer = Buffer.from(tail.text);
				daemonCandidates = [this.virtual("process-ring", buffer, false)];
				daemonRetention = "current_process";
				daemonReason = "journal_unavailable";
				daemonCatalogTruncated = tail.truncated;
			}
		}
		if (selected.has("daemon"))
			result.set("daemon", {
				id: "daemon",
				scope: "host",
				availability: daemonCandidates.length ? "available" : "unavailable",
				coverage:
					daemonRetention === "current_process"
						? "Current pilotd process console ring only; system journal history is not read without a shell."
						: "pilotd log plus its retained rotation; inherited kernel/worker output may be interleaved.",
				retention: daemonRetention,
				availableFiles: daemonCandidates.length,
				rotatedFiles: daemonCandidates.filter((file) => file.rotated).length,
				catalogTruncated: daemonCatalogTruncated,
				...(daemonReason ? { reason: daemonReason } : {}),
				files: daemonCandidates,
			});
		const persistentWorkerFiles = daemonFiles.files;
		if (selected.has("kernel_worker"))
			result.set("kernel_worker", {
				id: "kernel_worker",
				scope: "host",
				availability: persistentWorkerFiles.length ? "available" : "unavailable",
				coverage: persistentWorkerFiles.length
					? "Kernel/worker stdout and stderr inherited by pilotd; records are combined with daemon output and are not attributed by process."
					: "Kernel/worker output is inherited by the host service, but no safe persistent file source is available to this reader.",
				retention: persistentWorkerFiles.length ? "current_and_rotated" : "none",
				availableFiles: persistentWorkerFiles.length,
				rotatedFiles: persistentWorkerFiles.filter((file) => file.rotated).length,
				catalogTruncated: false,
				...(daemonFiles.reason ? { reason: daemonFiles.reason } : {}),
				files: persistentWorkerFiles,
			});

		if (selected.has("native_report")) result.set("native_report", await this.nativeReports());
		const needsTarget = ["lifecycle", "request_timing", "tool_activity"].some((id) =>
			selected.has(id as DiagnosticLogSourceId),
		);
		const sessionRoots =
			needsTarget && localDiagnostics && target
				? await this.sessionRoots(target.sessionId, target.directory)
				: {
						target: target ? ("missing" as const) : ("no_target" as const),
						durable: target ? ("missing" as const) : ("no_target" as const),
					};
		const targetSources: Array<{
			id: "lifecycle" | "request_timing" | "tool_activity";
			file: string;
			coverage: string;
		}> = [
			{
				id: "lifecycle",
				file: "lifecycle.jsonl",
				coverage: "Content-free admitted-target lifecycle events retained by pilotd.",
			},
			{
				id: "request_timing",
				file: "durable/performance.jsonl",
				coverage: "Content-free admitted-target model request timing records; no prompts or responses.",
			},
			{
				id: "tool_activity",
				file: "durable/tool-activity.jsonl",
				coverage: "Sanitized admitted-target tool lifecycle records; no names, arguments, output or commands.",
			},
		];
		for (const source of targetSources) {
			if (!selected.has(source.id)) continue;
			const rootProblem = source.id === "lifecycle" ? sessionRoots.target : sessionRoots.durable;
			if (!localDiagnostics || rootProblem) {
				result.set(source.id, {
					id: source.id,
					scope: "target",
					availability: localDiagnostics ? "unavailable" : "disabled",
					coverage: source.coverage,
					retention: "bounded_local",
					availableFiles: 0,
					rotatedFiles: 0,
					catalogTruncated: false,
					reason: localDiagnostics ? rootProblem : "disabled",
					files: [],
				});
				continue;
			}
			const current = join(target!.directory, source.file);
			const files = await this.fixedFiles([
				{ token: "current", path: current, rotated: false },
				{ token: "rotated", path: `${current}.1`, rotated: true },
			]);
			result.set(source.id, {
				id: source.id,
				scope: "target",
				availability: files.files.length ? "available" : "unavailable",
				coverage: source.coverage,
				retention: "bounded_local",
				availableFiles: files.files.length,
				rotatedFiles: files.files.filter((file) => file.rotated).length,
				catalogTruncated: false,
				...(files.reason ? { reason: files.reason } : {}),
				files: files.files,
			});
		}
		return result;
	}

	private async sessionRoots(
		sessionId: string,
		directory: string,
	): Promise<{
		target?: DiagnosticLogSourceInventory["reason"];
		durable?: DiagnosticLogSourceInventory["reason"];
	}> {
		try {
			const home = await realpath(this.options.home);
			const expected = join(home, "sessions", sessionId);
			const rootStat = await lstat(directory);
			if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || (await realpath(directory)) !== expected)
				return { target: "unsafe_source", durable: "unsafe_source" };
			const durable = join(directory, "durable");
			const durableProblem = await this.rootProblem(durable);
			if (durableProblem) return { durable: durableProblem };
			if ((await realpath(durable)) !== join(expected, "durable")) return { durable: "unsafe_source" };
			return {};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			const reason = code === "ENOENT" ? "missing" : code === "EACCES" ? "inaccessible" : "unsafe_source";
			return { target: reason, durable: reason };
		}
	}

	private async rootProblem(path: string): Promise<DiagnosticLogSourceInventory["reason"] | undefined> {
		try {
			const stat = await lstat(path);
			return stat.isSymbolicLink() || !stat.isDirectory() ? "unsafe_source" : undefined;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return code === "ENOENT" ? "missing" : "inaccessible";
		}
	}

	private async fixedFiles(
		candidates: FileCandidate[],
	): Promise<{ files: InspectedCandidate[]; reason?: DiagnosticLogSourceInventory["reason"] }> {
		if (!candidates.length) return { files: [], reason: "journal_unavailable" };
		const parent = dirname(candidates[0]!.path!);
		const rootProblem = await this.rootProblem(parent);
		if (rootProblem) return { files: [], reason: rootProblem };
		if (candidates[0]?.privateApp) {
			const stat = await lstat(parent);
			if (stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || (await realpath(parent)) !== parent)
				return { files: [], reason: "unsafe_source" };
		}
		const files: InspectedCandidate[] = [];
		let reason: DiagnosticLogSourceInventory["reason"] = "missing";
		for (const candidate of candidates) {
			const inspected = await this.inspect(candidate);
			if (inspected.file) files.push(inspected.file);
			else if (inspected.reason !== "missing") reason = inspected.reason;
		}
		return { files, ...(files.length < candidates.length ? { reason } : {}) };
	}

	private async nativeReports(): Promise<SourceDescriptor> {
		const root = this.options.diagnosticReports;
		if ((this.options.platform ?? process.platform) !== "darwin" || !root)
			return {
				id: "native_report",
				scope: "host",
				availability: "unavailable",
				coverage:
					"Pilot-only user DiagnosticReports are available only on macOS when the OS directory is readable.",
				retention: "os_managed",
				availableFiles: 0,
				rotatedFiles: 0,
				catalogTruncated: false,
				reason: "missing",
				files: [],
			};
		const rootProblem = await this.rootProblem(root);
		if (rootProblem)
			return {
				id: "native_report",
				scope: "host",
				availability: "unavailable",
				coverage: "Pilot-only reports in the user's macOS DiagnosticReports directory; no system-wide reports.",
				retention: "os_managed",
				availableFiles: 0,
				rotatedFiles: 0,
				catalogTruncated: false,
				reason: rootProblem,
				files: [],
			};
		const files: InspectedCandidate[] = [];
		let scanned = 0;
		let catalogTruncated = false;
		let inaccessible = false;
		let directory: Awaited<ReturnType<typeof opendir>>;
		try {
			directory = await opendir(root);
		} catch {
			return {
				id: "native_report",
				scope: "host",
				availability: "unavailable",
				coverage: "Pilot-only reports in the user's macOS DiagnosticReports directory; no system-wide reports.",
				retention: "os_managed",
				availableFiles: 0,
				rotatedFiles: 0,
				catalogTruncated: false,
				reason: "inaccessible",
				files: [],
			};
		}
		try {
			for await (const entry of directory) {
				scanned++;
				if (scanned > MAX_REPORT_DIRECTORY_ENTRIES) {
					catalogTruncated = true;
					break;
				}
				if (!entry.isFile() || !REPORT_NAME.test(entry.name)) continue;
				const inspected = await this.inspect({
					token: `report:${createHash("sha256").update(entry.name).digest("hex").slice(0, 24)}`,
					path: join(root, entry.name),
					rotated: false,
				});
				if (inspected.file) files.push(inspected.file);
				else inaccessible = true;
			}
		} catch {
			inaccessible = true;
		} finally {
			await directory.close().catch(() => undefined);
		}
		files.sort((a, b) => b.mtimeMs - a.mtimeMs);
		if (files.length > MAX_REPORT_FILES) {
			files.length = MAX_REPORT_FILES;
			catalogTruncated = true;
		}
		return {
			id: "native_report",
			scope: "host",
			availability: files.length ? "available" : "unavailable",
			coverage:
				"Pilot-named crash/hang reports already retained by macOS for this user. Empty coverage does not prove no crash or hang; ambiguous node reports are excluded.",
			retention: "os_managed",
			availableFiles: files.length,
			rotatedFiles: 0,
			catalogTruncated,
			...(!files.length || inaccessible ? { reason: inaccessible ? "inaccessible" : ("missing" as const) } : {}),
			files,
		};
	}

	private virtual(token: string, buffer: Buffer, rotated: boolean): InspectedCandidate {
		const identity = createHash("sha256").update(buffer).digest("hex").slice(0, 24);
		return { token, virtual: buffer, rotated, dev: "virtual", ino: identity, size: buffer.length, mtimeMs: 0 };
	}

	private async inspect(
		candidate: FileCandidate,
	): Promise<{ file?: InspectedCandidate; reason: DiagnosticLogSourceInventory["reason"] }> {
		if (candidate.virtual)
			return { file: this.virtual(candidate.token, candidate.virtual, candidate.rotated), reason: "missing" };
		let handle: FileHandle | undefined;
		try {
			handle = await open(candidate.path!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const stat = await handle.stat({ bigint: true });
			if (!stat.isFile() || stat.size > BigInt(Number.MAX_SAFE_INTEGER)) return { reason: "unsafe_source" };
			if (
				candidate.privateApp &&
				(stat.uid !== BigInt(process.getuid?.() ?? -1) || (stat.mode & 0o077n) !== 0n || stat.size > 256n * 1024n)
			)
				return { reason: "unsafe_source" };
			return {
				file: {
					...candidate,
					dev: String(stat.dev),
					ino: String(stat.ino),
					size: Number(stat.size),
					mtimeMs: Number(stat.mtimeMs),
					fallbackAt: candidate.fallbackAt ?? new Date(Number(stat.mtimeMs)).toISOString(),
				},
				reason: "missing",
			};
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			return { reason: code === "ENOENT" ? "missing" : code === "ELOOP" ? "unsafe_source" : "inaccessible" };
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	private async bytes(
		candidate: InspectedCandidate,
		start: number,
		length: number,
	): Promise<{ buffer: Buffer; changed: boolean }> {
		if (candidate.virtual) {
			const current = this.virtual(candidate.token, candidate.virtual, candidate.rotated);
			return {
				buffer: candidate.virtual.subarray(start, start + length),
				changed: current.ino !== candidate.ino || candidate.virtual.length < start + length,
			};
		}
		let handle: FileHandle | undefined;
		try {
			handle = await open(candidate.path!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			const before = await handle.stat({ bigint: true });
			if (
				String(before.dev) !== candidate.dev ||
				String(before.ino) !== candidate.ino ||
				Number(before.size) < start + length
			)
				return { buffer: Buffer.alloc(0), changed: true };
			const buffer = Buffer.alloc(length);
			const { bytesRead } = await handle.read(buffer, 0, length, start);
			const after = await handle.stat({ bigint: true });
			return {
				buffer: buffer.subarray(0, bytesRead),
				changed:
					bytesRead !== length ||
					String(after.dev) !== candidate.dev ||
					String(after.ino) !== candidate.ino ||
					Number(after.size) < start + bytesRead,
			};
		} catch {
			return { buffer: Buffer.alloc(0), changed: true };
		} finally {
			await handle?.close().catch(() => undefined);
		}
	}

	private cursor(source: DiagnosticLogSourceId, file: InspectedCandidate, position: number, hash: string): string {
		return opaque(
			CURSOR_PREFIX,
			{ s: source, f: file.token, x: this.identity(file), p: position, h: hash },
			this.opaqueSecret,
		);
	}

	private ref(source: DiagnosticLogSourceId, file: InspectedCandidate, offset: number, length: number): string {
		return opaque(
			REF_PREFIX,
			{ s: source, f: file.token, x: this.identity(file), o: offset, l: length },
			this.opaqueSecret,
		);
	}

	private identity(file: InspectedCandidate): string {
		return createHash("sha256").update(file.dev).update("\0").update(file.ino).digest("hex").slice(0, 24);
	}

	private locate(files: InspectedCandidate[], identity: string): number {
		return files.findIndex((file) => this.identity(file) === identity);
	}

	private pointer(
		files: InspectedCandidate[],
		index: number,
		position: number,
	): { index: number; position: number } | undefined {
		if (position > 0) return { index, position };
		for (let next = index + 1; next < files.length; next++)
			if (files[next]!.size > 0) return { index: next, position: files[next]!.size };
		return undefined;
	}

	private lineRanges(buffer: Buffer, start: number, end: number): Array<{ start: number; end: number }> {
		const ranges: Array<{ start: number; end: number }> = [];
		let line = start;
		for (let index = start; index < end; index++) {
			if (buffer[index] !== 0x0a) continue;
			ranges.push({ start: line, end: index > line && buffer[index - 1] === 0x0d ? index - 1 : index });
			line = index + 1;
		}
		if (line < end) ranges.push({ start: line, end });
		return ranges.filter((range) => range.end > range.start);
	}

	private async search(
		descriptor: SourceDescriptor,
		request: Extract<DiagnosticLogRequest, { action: "search" }>,
	): Promise<DiagnosticLogPage> {
		if (descriptor.availability !== "available") return unavailablePage(descriptor.id, descriptor, this.maxScanBytes);
		const query = request.q?.trim().toLowerCase() || undefined;
		const since = request.since === undefined ? undefined : this.since(request.since);
		const hash = filterHash(descriptor.id, query, since);
		let index = 0;
		let position = descriptor.files[0]?.size ?? 0;
		if (request.cursor !== undefined) {
			const cursor = parseOpaque<CursorPayload>(CURSOR_PREFIX, request.cursor, this.opaqueSecret);
			if (
				!cursor ||
				Object.keys(cursor).sort().join(",") !== "f,h,p,s,x" ||
				cursor.s !== descriptor.id ||
				cursor.h !== hash ||
				!Number.isSafeInteger(cursor.p) ||
				cursor.p < 0
			)
				return this.stalePage(descriptor.id, "Cursor does not match this source and filter");
			index = this.locate(descriptor.files, cursor.x);
			if (index < 0 || cursor.p > descriptor.files[index]!.size)
				return this.stalePage(descriptor.id, "The retained file rotated, shrank or expired");
			position = cursor.p;
		}
		let pointer = this.pointer(descriptor.files, index, position);
		const records: DiagnosticLogRecord[] = [];
		let scannedBytes = 0;
		let textBytes = 0;
		let oversizedRecords = 0;
		let outputTruncated = false;
		const limit = request.limit ?? 12;
		while (pointer && scannedBytes < this.maxScanBytes && records.length < limit) {
			const file = descriptor.files[pointer.index]!;
			const length = Math.min(pointer.position, READ_CHUNK_BYTES, this.maxScanBytes - scannedBytes);
			if (length <= 0) break;
			const start = pointer.position - length;
			const read = await this.bytes(file, start, length);
			scannedBytes += length;
			if (read.changed) return this.changedPage(descriptor.id, scannedBytes);
			const buffer = read.buffer;
			let left = 0;
			let right = buffer.length;
			if (start > 0) {
				const newline = buffer.indexOf(0x0a);
				if (newline < 0 || start + newline + 1 >= pointer.position) {
					oversizedRecords++;
					pointer = this.pointer(descriptor.files, pointer.index, start);
					continue;
				}
				left = newline + 1;
			}
			if (buffer.length && buffer[buffer.length - 1] !== 0x0a) {
				outputTruncated = true;
				const newline = buffer.lastIndexOf(0x0a);
				if (newline < left) {
					oversizedRecords++;
					pointer = this.pointer(descriptor.files, pointer.index, start);
					continue;
				}
				right = newline + 1;
			}
			const ranges = this.lineRanges(buffer, left, right).reverse();
			const windowRedaction = wholeWindowRedaction(buffer, left, right);
			let resume = start + left;
			for (const range of ranges) {
				const rawLength = range.end - range.start;
				const absolute = start + range.start;
				if (rawLength > MAX_RAW_RECORD_BYTES) {
					oversizedRecords++;
					continue;
				}
				const raw = buffer.subarray(range.start, range.end).toString("utf8");
				const safe = descriptor.line ? descriptor.line(raw) : (windowRedaction ?? sanitizeDiagnosticLogLine(raw));
				if (safe === undefined) continue;
				const at = logTimestamp(safe, file.fallbackAt);
				if (since !== undefined && (at === undefined || Date.parse(at) < since)) continue;
				if (query && !safe.toLowerCase().includes(query)) continue;
				const excerpt = clipped(safe, DIAGNOSTIC_LOG_RECORD_BYTES);
				const recordBytes = Buffer.byteLength(excerpt.text);
				if (records.length && textBytes + recordBytes > this.maxOutputBytes - 8_000) {
					outputTruncated = true;
					resume = absolute;
					break;
				}
				records.push({
					ref: this.ref(descriptor.id, file, absolute, rawLength),
					...(at ? { at } : {}),
					text: excerpt.text,
					truncated: excerpt.truncated,
				});
				textBytes += recordBytes;
				resume = absolute;
				if (records.length >= limit) break;
			}
			pointer = this.pointer(descriptor.files, pointer.index, resume);
			if (outputTruncated || records.length >= limit) break;
		}
		const nextCursor = pointer
			? this.cursor(descriptor.id, descriptor.files[pointer.index]!, pointer.position, hash)
			: undefined;
		const page: DiagnosticLogPage = {
			source: descriptor.id,
			status: "ok",
			records,
			scannedBytes,
			maxScanBytes: this.maxScanBytes,
			encodedBytes: 0,
			maxBytes: this.maxOutputBytes,
			oversizedRecords,
			truncated:
				descriptor.catalogTruncated ||
				outputTruncated ||
				oversizedRecords > 0 ||
				!!nextCursor ||
				records.some((row) => row.truncated),
			...(nextCursor ? { nextCursor } : {}),
			...(descriptor.reason ? { reason: descriptor.coverage } : {}),
		};
		page.encodedBytes = Buffer.byteLength(JSON.stringify(page));
		while (page.encodedBytes > Math.max(1_024, this.maxOutputBytes - 1_024) && page.records.length) {
			const removed = page.records.pop()!;
			const ref = parseOpaque<RefPayload>(REF_PREFIX, removed.ref, this.opaqueSecret)!;
			const fileIndex = this.locate(descriptor.files, ref.x);
			if (fileIndex >= 0) page.nextCursor = this.cursor(descriptor.id, descriptor.files[fileIndex]!, ref.o, hash);
			page.truncated = true;
			page.encodedBytes = Buffer.byteLength(JSON.stringify(page));
		}
		return page;
	}

	private stalePage(source: DiagnosticLogSourceId, reason: string): DiagnosticLogPage {
		return {
			source,
			status: "stale_cursor",
			records: [],
			scannedBytes: 0,
			maxScanBytes: this.maxScanBytes,
			encodedBytes: 0,
			maxBytes: this.maxOutputBytes,
			oversizedRecords: 0,
			truncated: true,
			reason,
		};
	}

	private changedPage(source: DiagnosticLogSourceId, scannedBytes: number): DiagnosticLogPage {
		return {
			source,
			status: "source_changed",
			records: [],
			scannedBytes,
			maxScanBytes: this.maxScanBytes,
			encodedBytes: 0,
			maxBytes: this.maxOutputBytes,
			oversizedRecords: 0,
			truncated: true,
			reason: "The source changed during the bounded read; start a fresh search",
		};
	}

	private async excerpt(
		sources: Map<DiagnosticLogSourceId, SourceDescriptor>,
		request: Extract<DiagnosticLogRequest, { action: "excerpt" }>,
	): Promise<DiagnosticLogExcerpt> {
		const ref = parseOpaque<RefPayload>(REF_PREFIX, request.ref, this.opaqueSecret);
		if (
			!ref ||
			Object.keys(ref).sort().join(",") !== "f,l,o,s,x" ||
			!SOURCE_IDS.has(ref.s) ||
			!Number.isSafeInteger(ref.o) ||
			ref.o < 0 ||
			!Number.isSafeInteger(ref.l) ||
			ref.l < 1 ||
			ref.l > MAX_RAW_RECORD_BYTES
		)
			throw new Error("Invalid diagnostic log ref");
		const descriptor = sources.get(ref.s)!;
		if (descriptor.availability !== "available")
			return {
				source: ref.s,
				status: "unavailable",
				before: [],
				after: [],
				scannedBytes: 0,
				maxScanBytes: this.maxScanBytes,
				truncated: descriptor.catalogTruncated,
				reason: "The catalogued source is no longer available",
			};
		const index = this.locate(descriptor.files, ref.x);
		if (index < 0 || ref.o + ref.l > descriptor.files[index]!.size)
			return {
				source: ref.s,
				status: "stale_ref",
				before: [],
				after: [],
				scannedBytes: 0,
				maxScanBytes: this.maxScanBytes,
				truncated: true,
				reason: "The referenced file rotated, shrank or expired",
			};
		const file = descriptor.files[index]!;
		const targetRead = await this.bytes(file, ref.o, ref.l);
		if (targetRead.changed) return this.changedExcerpt(ref.s, ref.l);
		let scannedBytes = ref.l;
		const raw = targetRead.buffer.toString("utf8");
		const safe = descriptor.line ? descriptor.line(raw) : sanitizeDiagnosticLogLine(raw);
		if (safe === undefined)
			return {
				source: ref.s,
				status: "stale_ref",
				before: [],
				after: [],
				scannedBytes,
				maxScanBytes: this.maxScanBytes,
				truncated: true,
				reason: "Record expired or no longer matches this host and closed schema",
			};
		const targetSafe = clipped(safe, DIAGNOSTIC_LOG_RECORD_BYTES);
		const record: DiagnosticLogRecord = {
			ref: request.ref,
			...(logTimestamp(targetSafe.text, file.fallbackAt)
				? { at: logTimestamp(targetSafe.text, file.fallbackAt) }
				: {}),
			text: targetSafe.text,
			truncated: targetSafe.truncated,
		};
		const beforeCount = request.before ?? 3;
		const afterCount = request.after ?? 3;
		const beforeStart = Math.max(0, ref.o - CONTEXT_BYTES);
		const beforeRead = await this.bytes(file, beforeStart, ref.o - beforeStart);
		scannedBytes += ref.o - beforeStart;
		if (beforeRead.changed) return this.changedExcerpt(ref.s, scannedBytes);
		const afterStart = ref.o + ref.l;
		const afterLength = Math.min(CONTEXT_BYTES, file.size - afterStart);
		const afterRead = await this.bytes(file, afterStart, afterLength);
		scannedBytes += afterLength;
		if (afterRead.changed) return this.changedExcerpt(ref.s, scannedBytes);
		const windowRedaction = wholeWindowRedaction(
			Buffer.concat([beforeRead.buffer, targetRead.buffer, afterRead.buffer]),
		);
		if (windowRedaction) {
			record.text = windowRedaction;
			record.truncated = true;
			return {
				source: ref.s,
				status: "ok",
				record,
				before: [],
				after: [],
				scannedBytes,
				maxScanBytes: this.maxScanBytes,
				truncated: true,
				reason: "Context was withheld because the bounded window contained credential material",
			};
		}
		const before = this.contextRecords(ref.s, file, beforeRead.buffer, beforeStart, true, descriptor.line)
			.slice(-beforeCount)
			.map((item) => item.record);
		const after = this.contextRecords(ref.s, file, afterRead.buffer, afterStart, false, descriptor.line)
			.slice(0, afterCount)
			.map((item) => item.record);
		return {
			source: ref.s,
			status: "ok",
			record,
			before,
			after,
			scannedBytes,
			maxScanBytes: this.maxScanBytes,
			truncated:
				targetSafe.truncated ||
				(beforeRead.buffer.length > 0 && beforeStart > 0) ||
				(afterRead.buffer.length > 0 && afterRead.buffer[afterRead.buffer.length - 1] !== 0x0a) ||
				(beforeCount > 0 && before.length < beforeCount && beforeStart > 0) ||
				(afterCount > 0 && after.length < afterCount && afterStart + afterLength < file.size),
		};
	}

	private contextRecords(
		source: DiagnosticLogSourceId,
		file: InspectedCandidate,
		buffer: Buffer,
		absoluteStart: number,
		dropFirstPartial: boolean,
		line?: (raw: string) => string | undefined,
	): Array<{ record: DiagnosticLogRecord }> {
		let left = 0;
		let right = buffer.length;
		if (dropFirstPartial && absoluteStart > 0) {
			const newline = buffer.indexOf(0x0a);
			left = newline < 0 ? buffer.length : newline + 1;
		}
		if (right && buffer[right - 1] !== 0x0a) {
			const newline = buffer.lastIndexOf(0x0a);
			right = newline < left ? left : newline + 1;
		}
		return this.lineRanges(buffer, left, right).flatMap((range) => {
			const length = range.end - range.start;
			if (length <= 0 || length > MAX_RAW_RECORD_BYTES) return [];
			const raw = buffer.subarray(range.start, range.end).toString("utf8");
			const sanitized = line ? line(raw) : sanitizeDiagnosticLogLine(raw);
			if (sanitized === undefined) return [];
			const safe = clipped(sanitized, CONTEXT_RECORD_BYTES);
			const offset = absoluteStart + range.start;
			const at = logTimestamp(safe.text, file.fallbackAt);
			return [
				{
					record: {
						ref: this.ref(source, file, offset, length),
						...(at ? { at } : {}),
						text: safe.text,
						truncated: safe.truncated,
					},
				},
			];
		});
	}

	private changedExcerpt(source: DiagnosticLogSourceId, scannedBytes: number): DiagnosticLogExcerpt {
		return {
			source,
			status: "source_changed",
			before: [],
			after: [],
			scannedBytes,
			maxScanBytes: this.maxScanBytes,
			truncated: true,
			reason: "The source changed during the bounded read; run a fresh search",
		};
	}
}
