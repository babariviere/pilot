/** Private same-host auth protocol. No paths, URLs to fetch, commands, or arbitrary file operations. */
import { connect, type Socket } from "node:net";
import { CATALOG_FRAME_LIMIT } from "./shared-model-catalog.ts";
export const AUTH_FRAME_LIMIT = 64 * 1024;
export interface CredentialEndpoint {
	socket: string;
	token: string;
	/** Canonical same-host agent directory whose discovery this capability can read. */
	catalogAgentDir?: string;
}
export type CredentialNamespace = "pi" | "mcp";
export type CredentialOperation =
	| "read"
	| "peek"
	| "list"
	| "status"
	| "statuses"
	| "begin"
	| "commit"
	| "delete"
	| "catalog";
/** Metadata only. Configured does not prove provider acceptance or include ambient/config auth. */
export interface CredentialStatus {
	state: "missing" | "configured" | "reauthentication_required";
}
export type CredentialStatuses = Array<CredentialStatus & { providerId: string }>;
export interface CredentialRequest {
	op: CredentialOperation;
	namespace: CredentialNamespace;
	key?: string;
	mode?: "refresh" | "login";
	value?: unknown;
	changed?: boolean;
}
export class CredentialBrokerError extends Error {
	readonly code: string;
	constructor(code: string) {
		const safe = ["invalid", "unauthorized", "uncertain", "stale", "busy"].includes(code) ? code : "unavailable";
		super(`Credential broker ${safe}. Sign in again if a refresh outcome is uncertain.`);
		this.code = safe;
	}
}
export function authError(code = "unavailable"): CredentialBrokerError {
	return new CredentialBrokerError(code);
}
export class CredentialChannel {
	private socket: Socket;
	/** Why the channel closed. A stale endpoint needs a fresh one, a broken broker does not. */
	private code?: string;
	private pending?: { resolve(value: unknown): void; reject(error: Error): void };
	private deadline?: NodeJS.Timeout;
	private buffer = Buffer.alloc(0);
	private closed = false;
	private responseLimit = AUTH_FRAME_LIMIT;
	private readonly endpoint: CredentialEndpoint;
	constructor(endpoint: CredentialEndpoint) {
		this.endpoint = endpoint;
		this.socket = connect(endpoint.socket);
		this.socket.setTimeout(310_000, () => this.close());
		this.socket.on("error", (error) => {
			// A missing or refused socket means the daemon that issued this endpoint is gone or
			// restarting. The endpoint is stale, not a broken broker: a fresh one is needed.
			const code = (error as NodeJS.ErrnoException).code;
			this.code = code === "ENOENT" || code === "ECONNREFUSED" ? "stale" : undefined;
			this.close();
		});
		this.socket.on("close", () => this.close());
		this.socket.on("data", (bytes) => {
			this.buffer = Buffer.concat([this.buffer, bytes]);
			if (this.buffer.length > this.responseLimit) return this.close();
			const end = this.buffer.indexOf(10);
			if (end < 0) return;
			const waiter = this.pending;
			clearTimeout(this.deadline);
			this.pending = undefined;
			try {
				const reply = JSON.parse(this.buffer.subarray(0, end).toString()) as {
					ok?: boolean;
					value?: unknown;
					code?: string;
				};
				this.buffer = this.buffer.subarray(end + 1);
				if (reply.ok === true) waiter?.resolve(reply.value);
				else waiter?.reject(authError(reply.code));
			} catch {
				waiter?.reject(authError());
				this.close();
			}
		});
	}
	request(request: CredentialRequest): Promise<unknown> {
		if (this.closed || this.pending) return Promise.reject(authError(this.code));
		this.responseLimit = request.op === "catalog" ? CATALOG_FRAME_LIMIT : AUTH_FRAME_LIMIT;
		const frame = JSON.stringify({ ...request, token: this.endpoint.token }) + "\n";
		if (Buffer.byteLength(frame) > AUTH_FRAME_LIMIT) return Promise.reject(authError("invalid"));
		return new Promise((resolve, reject) => {
			this.pending = { resolve, reject };
			this.deadline = setTimeout(() => this.close(), 35_000);
			this.socket.write(frame, (error) => {
				if (error) this.close();
			});
		});
	}
	close(): void {
		if (this.closed) return;
		this.closed = true;
		clearTimeout(this.deadline);
		this.pending?.reject(authError(this.code));
		this.pending = undefined;
		this.socket.destroy();
	}
}
export async function credentialRequest(endpoint: CredentialEndpoint, request: CredentialRequest): Promise<unknown> {
	const channel = new CredentialChannel(endpoint);
	try {
		return await channel.request(request);
	} finally {
		channel.close();
	}
}
