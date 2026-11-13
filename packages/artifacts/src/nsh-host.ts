/** Fixed trusted helper transport. No authored code is evaluated and no host environment is inherited. */
import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { ArtifactRevision } from "@pilot/protocol";

const INSTALLED_HOST = fileURLToPath(new URL("../native/pilot-artifact-host", import.meta.url));
const MAX_RESPONSE = 4 * 1024 * 1024;
let active = 0;

export interface NshPreparation {
	artifactId: string;
	sourceSessionId: string;
	revision: number;
	sourceSha256: string;
	code: string;
	rendering: "unsupported";
	reason: string;
}

/** Explicit host preparation of one saved revision, never a live file or a rendering permit. */
export async function prepareNshRevision(
	artifact: ArtifactRevision,
	signal?: AbortSignal,
	executable?: string,
): Promise<NshPreparation> {
	if (
		artifact.kind !== "nsh" ||
		artifact.nsh?.api !== 1 ||
		artifact.nsh.runtime !== "nsh 0.5.0" ||
		artifact.nsh.rendering !== "unsupported"
	)
		throw new Error("Unsupported saved NSH revision");
	const captured = {
		artifactId: artifact.id,
		sourceSessionId: artifact.sessionId,
		revision: artifact.revision,
		entry: artifact.nsh.entry,
		source: artifact.source,
		sourceSha256: artifact.nsh.sourceSha256,
		sourceBytes: artifact.nsh.sourceBytes,
	};
	const value = (await callArtifactHost({ action: "compile", captured }, signal, executable)) as NshPreparation;
	if (
		!value ||
		value.artifactId !== artifact.id ||
		value.sourceSessionId !== artifact.sessionId ||
		value.revision !== artifact.revision ||
		value.sourceSha256 !== artifact.nsh.sourceSha256 ||
		value.rendering !== "unsupported" ||
		typeof value.code !== "string" ||
		Buffer.byteLength(value.code) > 2 * 1024 * 1024 ||
		typeof value.reason !== "string"
	)
		throw new Error("Invalid prepared NSH revision identity or result");
	return value;
}

/** The build/package owns this executable location; tools and artifacts cannot select it. */
export async function artifactHostAvailable(): Promise<boolean> {
	try {
		const info = await lstat(INSTALLED_HOST);
		return info.isFile() && !info.isSymbolicLink() && (info.mode & 0o111) !== 0;
	} catch {
		return false;
	}
}

/** Host-only executable override supports isolated tests. Never take it from a tool request or saved artifact. */
export async function callArtifactHost(
	input: object,
	signal?: AbortSignal,
	executable = INSTALLED_HOST,
): Promise<unknown> {
	signal?.throwIfAborted();
	const request = JSON.stringify(input);
	if (Buffer.byteLength(request) > MAX_RESPONSE) throw new Error("Artifact host input exceeds limit");
	if (active >= 2) throw new Error("Artifact source host is busy");
	active++;
	return new Promise((resolve, reject) => {
		const child = spawn(executable, [], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
		const chunks: Buffer[] = [];
		let length = 0;
		let failure: Error | undefined;
		const stop = (error: Error) => {
			failure ??= error;
			child.kill("SIGKILL");
		};
		const aborted = () => stop(new Error("Artifact host canceled"));
		const timer = setTimeout(() => stop(new Error("Artifact host exceeded 5 second deadline")), 5000);
		signal?.addEventListener("abort", aborted, { once: true });
		child.stdout.on("data", (part: Buffer) => {
			length += part.length;
			if (length > MAX_RESPONSE) stop(new Error("Artifact host output exceeds limit"));
			else chunks.push(part);
		});
		// Diagnostics return in the bounded JSON response, not an unbounded stderr buffer.
		child.stderr.resume();
		child.stdin.on("error", () => {});
		child.on("error", () => {
			failure ??= new Error("Artifact host unavailable");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			if (failure) return reject(failure);
			if (code !== 0) return reject(new Error("Artifact host failed"));
			try {
				const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { value?: unknown; error?: unknown };
				if (typeof reply.error === "string") return reject(new Error(reply.error.slice(0, 4096)));
				if (!("value" in reply)) return reject(new Error("Invalid artifact host response"));
				resolve(reply.value);
			} catch {
				reject(new Error("Invalid artifact host response"));
			}
		});
		if (signal?.aborted) aborted();
		else child.stdin.end(request);
	}).finally(() => {
		active--;
	});
}
