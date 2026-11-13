/** Fixed trusted helper transport. No authored code is evaluated and no host environment is inherited. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ArtifactRevision } from "@pilot/protocol";

const INSTALLED_HOST = fileURLToPath(new URL("../native/pilot-artifact-host", import.meta.url));
const MAX_RESPONSE = 4 * 1024 * 1024;
let active = 0;
let verified: { key: string; identity: Record<string, unknown> } | undefined;

/** Fixed sealed-runtime binding, not a caller-selected executable or signature verifier. */
export async function readArtifactHostBinding(executable = INSTALLED_HOST): Promise<Record<string, unknown>> {
	const read = async (path: string) => {
		const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const info = await file.stat();
			if (
				!info.isFile() ||
				info.nlink !== 1 ||
				info.size > 4096 ||
				(info.mode & 0o6022) !== 0 ||
				(info.uid !== 0 && info.uid !== process.geteuid?.())
			)
				throw new Error("Unsafe artifact host binding");
			const bytes = Buffer.alloc(4097);
			const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
			const after = await file.stat();
			if (
				bytesRead !== info.size ||
				after.size !== info.size ||
				after.mtimeMs !== info.mtimeMs ||
				after.ctimeMs !== info.ctimeMs
			)
				throw new Error("Artifact host binding changed");
			return JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
		} finally {
			await file.close();
		}
	};
	const directory = dirname(executable);
	const descriptor = await read(join(directory, "artifact-host.json"));
	const runtime = await read(resolve(directory, "../../..", "runtime-build.json"));
	const identity = descriptor?.identity;
	if (
		descriptor?.schema !== 1 ||
		runtime?.schema !== 1 ||
		runtime.platform !== "darwin" ||
		runtime.arch !== "arm64" ||
		identity?.schema !== 1 ||
		identity.kind !== "nsh-source-host" ||
		identity.runtime !== "nsh 0.5.0" ||
		typeof identity.source !== "string" ||
		!/^[a-f0-9]{40}$/.test(identity.source) ||
		identity.source !== runtime.source ||
		typeof identity.recipe !== "string" ||
		!/^[a-f0-9]{64}$/.test(identity.recipe) ||
		Object.keys(identity).length !== 5 ||
		typeof descriptor.sha256 !== "string" ||
		!/^[a-f0-9]{64}$/.test(descriptor.sha256) ||
		!Number.isSafeInteger(descriptor.bytes) ||
		descriptor.bytes < 1 ||
		descriptor.bytes > 256 * 1024 * 1024
	)
		throw new Error("Artifact host source binding mismatch");
	const file = await open(executable, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await file.stat();
		if (
			!before.isFile() ||
			before.nlink !== 1 ||
			before.size !== descriptor.bytes ||
			(before.mode & 0o111) === 0 ||
			(before.mode & 0o6022) !== 0 ||
			(before.uid !== 0 && before.uid !== process.geteuid?.())
		)
			throw new Error("Unsafe artifact host executable");
		const key = [
			executable,
			before.dev,
			before.ino,
			before.mtimeMs,
			before.ctimeMs,
			before.size,
			descriptor.sha256,
			identity.source,
			identity.recipe,
		].join(":");
		if (verified?.key === key) return verified.identity;
		const hash = createHash("sha256");
		// Read/hash in small chunks; do not allocate a whole helper image or block on filesystem I/O.
		for await (const chunk of file.createReadStream({
			autoClose: false,
			highWaterMark: 64 * 1024,
			end: before.size - 1,
		}))
			hash.update(chunk);
		const after = await file.stat();
		if (
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			before.ctimeMs !== after.ctimeMs ||
			hash.digest("hex") !== descriptor.sha256
		)
			throw new Error("Artifact host bytes changed or mismatch");
		const frozen = Object.freeze({ ...identity });
		verified = { key, identity: frozen };
		return frozen;
	} finally {
		await file.close();
	}
}

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
		await readArtifactHostBinding();
		// Establish compiled identity before even Ensure can touch session storage.
		// This is a fixed source-only compilation, never authored JS execution.
		const source = "export default function Artifact() { return null; }";
		const value = (await callArtifactHost({
			action: "compile",
			captured: {
				artifactId: "11111111-1111-1111-1111-111111111111",
				sourceSessionId: "availability",
				revision: 1,
				entry: "Artifact.tsx",
				source,
				sourceBytes: Buffer.byteLength(source),
				sourceSha256: createHash("sha256").update(source).digest("hex"),
			},
		})) as { rendering?: unknown };
		return value?.rendering === "unsupported";
	} catch {
		return false;
	}
}

/** Host-only executable override supports isolated tests. Never take it from a tool request or saved artifact. */
export async function callArtifactHost(
	input: object,
	signal?: AbortSignal,
	executable = INSTALLED_HOST,
	expectedIdentity?: Record<string, unknown>,
	responseBytes = MAX_RESPONSE,
): Promise<unknown> {
	signal?.throwIfAborted();
	if (!Number.isSafeInteger(responseBytes) || responseBytes < 1 || responseBytes > MAX_RESPONSE)
		throw new Error("Invalid artifact host response limit");
	// Installed bytes are already subject to the verified app/runtime closure. Also bind
	// this exact helper to that runtime's source and its compiled response identity.
	const binding = executable === INSTALLED_HOST ? await readArtifactHostBinding() : expectedIdentity;
	signal?.throwIfAborted();
	const request = JSON.stringify(input);
	if (Buffer.byteLength(request) > MAX_RESPONSE) throw new Error("Artifact host input exceeds limit");
	if (active >= 2) throw new Error("Artifact source host is busy");
	active++;
	// The slot, deadline and abort listener are released only on "close": the owned helper has
	// exited, Node has reaped it and its stdio pipes have closed. This proves the direct child
	// is joined, not that a descendant subtree exited; the fixed helper never spawns one.
	// Callers keep their inputs and cleanup held until this promise settles.
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
		// Node leaves stdio null when spawn fails early (EMFILE/ENFILE). "error" and "close"
		// still follow, so the failure settles through the same join path.
		child.stdout?.on("data", (part: Buffer) => {
			length += part.length;
			if (length > responseBytes) stop(new Error("Artifact host output exceeds limit"));
			else chunks.push(part);
		});
		// Diagnostics return in the bounded JSON response, not an unbounded stderr buffer.
		child.stderr?.resume();
		child.stdin?.on("error", () => {});
		child.on("error", () => {
			failure ??= new Error("Artifact host unavailable");
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", aborted);
			if (failure) return reject(failure);
			if (code !== 0) return reject(new Error("Artifact host failed"));
			try {
				const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
					value?: unknown;
					error?: unknown;
					identity?: Record<string, unknown>;
				};
				if (
					!reply ||
					typeof reply !== "object" ||
					Array.isArray(reply) ||
					Object.keys(reply).some((key) => !["value", "error", "identity"].includes(key)) ||
					"value" in reply === "error" in reply ||
					(binding &&
						(!reply.identity ||
							Object.keys(reply.identity).length !== 5 ||
							Object.entries(binding).some(([key, value]) => reply.identity?.[key] !== value)))
				)
					throw new Error("Invalid artifact host response");
				if (typeof reply.error === "string") return reject(new Error(reply.error.slice(0, 4096)));
				if (!("value" in reply)) return reject(new Error("Invalid artifact host response"));
				resolve(reply.value);
			} catch {
				reject(new Error("Invalid artifact host response"));
			}
		});
		if (signal?.aborted) aborted();
		else if (!child.stdin) failure ??= new Error("Artifact host unavailable");
		else child.stdin.end(request);
	}).finally(() => {
		active--;
	});
}
