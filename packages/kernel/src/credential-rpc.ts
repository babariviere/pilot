/** Private same-host auth protocol. No paths, URLs to fetch, commands, or arbitrary file operations. */
import { connect, type Socket } from "node:net";
export const AUTH_FRAME_LIMIT = 64 * 1024;
export interface CredentialEndpoint {
	socket: string;
	token: string;
}
export type CredentialNamespace = "pi" | "mcp";
export type CredentialOperation = "read" | "peek" | "list" | "status" | "statuses" | "begin" | "commit" | "delete";
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
	private pending?: { resolve(value: unknown): void; reject(error: Error): void };
	private deadline?: NodeJS.Timeout;
	private buffer = Buffer.alloc(0);
	private closed = false;
	private readonly endpoint: CredentialEndpoint;
	constructor(endpoint: CredentialEndpoint) {
		this.endpoint = endpoint;
		this.socket = connect(endpoint.socket);
		this.socket.setTimeout(310_000, () => this.close());
		this.socket.on("error", () => this.close());
		this.socket.on("close", () => this.close());
		this.socket.on("data", (bytes) => {
			this.buffer = Buffer.concat([this.buffer, bytes]);
			if (this.buffer.length > AUTH_FRAME_LIMIT) return this.close();
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
		if (this.closed || this.pending) return Promise.reject(authError());
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
		this.pending?.reject(authError());
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
