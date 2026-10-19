/** Bounded read protocol, sanitization and ephemeral native courier. No addresses or filesystem selectors. */
import { randomUUID } from "node:crypto";
import type {
	DiagnosticContextRequest,
	DiagnosticContextResponse,
	DiagnosticReadDispatch,
	DiagnosticContextValue,
	OperationHost,
} from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "./errors.ts";
import { isCredentialField, redactDiagnosticText } from "./diagnostic-redaction.ts";

export function parseDiagnosticContext(value: unknown): DiagnosticContextRequest {
	const invalid = (): never => {
		throw new Conflict("Invalid diagnostic read selector");
	};
	if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
	const v = value as Record<string, unknown>;
	if (
		Object.keys(v).some(
			(k) =>
				![
					"action",
					"host",
					"sessionId",
					"projectId",
					"missionId",
					"query",
					"after",
					"before",
					"limit",
					"log",
				].includes(k),
		) ||
		!["hosts", "chats", "chat", "history", "search", "logs", "projects", "missions", "mission", "issues"].includes(
			String(v.action),
		)
	)
		return invalid();
	if (v.host !== undefined) {
		const h = v.host as Record<string, unknown>;
		if (
			!h ||
			typeof h !== "object" ||
			Object.keys(h).length !== 3 ||
			!["hostId", "daemonId", "lineageId"].every(
				(k) => typeof h[k] === "string" && h[k].length > 0 && h[k].length <= 200,
			)
		)
			return invalid();
	}
	if (v.sessionId !== undefined && (typeof v.sessionId !== "string" || !/^[0-9a-f-]{36}$/i.test(v.sessionId)))
		return invalid();
	if (["chat", "history"].includes(String(v.action)) && v.sessionId === undefined) return invalid();
	for (const key of ["projectId", "missionId"])
		if (v[key] !== undefined && (typeof v[key] !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v[key] as string)))
			return invalid();
	if ((v.action === "issues" && v.projectId === undefined) || (v.action === "mission" && v.missionId === undefined))
		return invalid();
	if (v.query !== undefined && (typeof v.query !== "string" || v.query.length > 200)) return invalid();
	if (v.after !== undefined && (typeof v.after !== "string" || !/^[0-9a-f-]{36}$/i.test(v.after))) return invalid();
	if (v.before !== undefined && (!Number.isSafeInteger(v.before) || (v.before as number) < 0)) return invalid();
	if (v.action === "issues" && ((v.before as number | undefined) ?? 0) > 10_000) return invalid();
	if (v.limit !== undefined && (!Number.isSafeInteger(v.limit) || (v.limit as number) < 1 || (v.limit as number) > 20))
		return invalid();
	if (v.action === "logs" && (!v.log || typeof v.log !== "object")) return invalid();
	return v as unknown as DiagnosticContextRequest;
}

/** Apply to non-transcript metadata too: titles/mission text are user data, not safe structured evidence. */
export function sanitizeDiagnosticContext(value: unknown): { data: DiagnosticContextValue; truncated: boolean } {
	let nodes = 2048,
		bytes = 40 * 1024,
		truncated = false;
	const clip = (v: unknown, depth: number, field?: string): DiagnosticContextValue => {
		if (--nodes < 0 || depth > 10 || bytes <= 0) {
			truncated = true;
			return null;
		}
		if (v === null || v === undefined) return null;
		if (typeof v === "number") return Number.isFinite(v) ? v : null;
		if (typeof v === "boolean") return v;
		if (typeof v === "string") {
			if (v.length > 8192) {
				truncated = true;
				return "[Oversized evidence text omitted]";
			}
			// These are server-issued continuation/provenance fields, not free-text evidence.
			const opaque =
				field !== undefined &&
				["cursor", "nextCursor", "ref"].includes(field) &&
				v.length <= 768 &&
				/^[A-Za-z0-9_:./+=-]+$/.test(v);
			const text = opaque ? v : redactDiagnosticText(v);
			const data = Buffer.from(text);
			const take = Math.min(data.length, 8192, bytes);
			bytes -= take;
			if (take < data.length || v.length > 64 * 1024) truncated = true;
			return data.subarray(0, take).toString("utf8");
		}
		if (Array.isArray(v)) {
			if (v.length > 128) truncated = true;
			return v.slice(0, 128).map((x) => clip(x, depth + 1));
		}
		if (typeof v !== "object") return null;
		const result: Record<string, DiagnosticContextValue> = {};
		const fields = Object.entries(v);
		if (fields.length > 64) truncated = true;
		for (const [key, x] of fields.slice(0, 64)) {
			if (
				(isCredentialField(key) && typeof x === "string") ||
				/^(reasoning|thinking|attachment|attachments|images|image|dataUrl|base64)$/i.test(key)
			)
				continue;
			result[key] = clip(x, depth + 1, key);
		}
		return result;
	};
	const data = clip(value, 0);
	if (Buffer.byteLength(JSON.stringify(data)) > 60 * 1024) return { data: null, truncated: true };
	return { data, truncated };
}

export function diagnosticContextResponse(
	host: OperationHost,
	data: unknown,
	page: Partial<DiagnosticContextResponse["page"]> = {},
): DiagnosticContextResponse {
	const safe = sanitizeDiagnosticContext(data);
	return {
		schemaVersion: 1,
		host,
		collectedAt: new Date().toISOString(),
		status: safe.truncated ? "partial" : "available",
		data: safe.data,
		page: {
			more: false,
			scanned: 0,
			maxScan: 200,
			maxBytes: 65536,
			...page,
			truncated: safe.truncated || page.truncated === true,
		},
	};
}

/** A cancelled cold read may settle in its bounded reader pool, but cannot keep the caller waiting. */
export function awaitDiagnosticRead<T>(read: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return read;
	if (signal.aborted) {
		void read.catch(() => undefined);
		return Promise.reject(new Error("Diagnostic read cancelled"));
	}
	return new Promise((resolve, reject) => {
		const cancel = () => {
			signal.removeEventListener("abort", cancel);
			reject(new Error("Diagnostic read cancelled"));
		};
		signal.addEventListener("abort", cancel, { once: true });
		read.then(
			(value) => {
				signal.removeEventListener("abort", cancel);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", cancel);
				reject(error);
			},
		);
	});
}

export class DiagnosticReadBroker {
	private listeners = new Set<(dispatch: DiagnosticReadDispatch) => void>();
	private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; dispose(): void }>();
	onRead(listener: (dispatch: DiagnosticReadDispatch) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	read(request: DiagnosticContextRequest, signal?: AbortSignal): Promise<unknown> {
		if (!this.listeners.size)
			return Promise.reject(new ServiceUnavailable("Native diagnostic routing is unavailable"));
		if (this.pending.size >= 8) return Promise.reject(new ServiceUnavailable("Diagnostic reads are busy"));
		if (signal?.aborted) return Promise.reject(new Error("Diagnostic read cancelled"));
		return new Promise((resolve, reject) => {
			const id = randomUUID();
			const cancel = () => {
				this.pending.delete(id);
				dispose();
				reject(new Error("Diagnostic read cancelled"));
			};
			const timer = setTimeout(() => {
				this.pending.delete(id);
				dispose();
				reject(new ServiceUnavailable("Native diagnostic routing did not answer"));
			}, 10_000);
			const dispose = () => {
				clearTimeout(timer);
				signal?.removeEventListener("abort", cancel);
			};
			this.pending.set(id, { resolve, reject, dispose });
			signal?.addEventListener("abort", cancel, { once: true });
			for (const listener of this.listeners) listener({ id, request });
		});
	}
	respond(id: string, value: unknown): void {
		const pending = this.pending.get(id);
		if (!pending) throw new Conflict("Diagnostic read expired");
		this.pending.delete(id);
		pending.dispose();
		pending.resolve(value);
	}
	close(): void {
		for (const p of this.pending.values()) {
			p.dispose();
			p.reject(new Error("Diagnostic routing closed"));
		}
		this.pending.clear();
		this.listeners.clear();
	}
}
