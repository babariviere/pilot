/**
 * Worker-thread body for daemon subprocesses. `child_process.spawn` blocks its calling thread until the child
 * has started, which takes hundreds of milliseconds on a saturated machine. Spawning here keeps pilotd's
 * event loop (HTTP, WebSocket and kernel IPC) responsive while agents run builds.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { parentPort } from "node:worker_threads";
import type { ProcessReply, ProcessRequest, WorkerCommand } from "./subprocess.ts";

const port = parentPort;
if (!port) throw new Error("subprocess-worker must run in a worker thread");

const children = new Map<number, { child: ChildProcess; stop(signal?: NodeJS.Signals): void }>();

function start(request: ProcessRequest): void {
	const reply = (message: ProcessReply) => port!.postMessage(message);
	let child: ChildProcess;
	try {
		child = spawn(request.file, request.args, {
			...(request.cwd !== undefined ? { cwd: request.cwd } : {}),
			...(request.env !== undefined ? { env: request.env } : {}),
			detached: request.detached === true,
			stdio: [request.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
	} catch (error) {
		const failure = error as NodeJS.ErrnoException;
		reply({
			type: "error",
			id: request.id,
			message: failure.message,
			...(failure.code ? { code: failure.code } : {}),
		});
		return;
	}
	const stdout: Buffer[] = [];
	// Early child exit may close stdin before it consumes every path. The exit status reports failure.
	child.stdin?.on("error", () => {});
	if (request.stdin !== undefined) child.stdin!.end(request.stdin);
	let stdoutBytes = 0;
	let stderr = "";
	let truncated = false;
	let overflowed = false;
	let timedOut = false;
	let aborted = false;
	let childError: NodeJS.ErrnoException | undefined;
	let finished = false;
	let forceKill: ReturnType<typeof setTimeout> | undefined;
	const kill = (signal: NodeJS.Signals) => {
		try {
			// Git and gh can spawn helpers. A detached child owns its process group, so stop all of it.
			if (request.detached && child.pid) process.kill(-child.pid, signal);
			else child.kill(signal);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
		}
	};
	const stop = (signal: NodeJS.Signals = request.killSignal ?? "SIGTERM") => {
		if (forceKill) return;
		kill(signal);
		forceKill = setTimeout(() => kill("SIGKILL"), signal === "SIGKILL" ? 0 : (request.forceKillMs ?? 1_000));
	};
	const timer =
		request.timeoutMs !== undefined && request.timeoutMs > 0
			? setTimeout(() => {
					timedOut = true;
					stop();
				}, request.timeoutMs)
			: undefined;
	children.set(request.id, {
		child,
		stop: () => {
			aborted = true;
			stop();
		},
	});
	child.stdout!.on("data", (chunk: Buffer) => {
		if (truncated || overflowed) return;
		const remaining = request.maxBytes - stdoutBytes;
		if (chunk.length <= remaining) {
			stdout.push(chunk);
			stdoutBytes += chunk.length;
			return;
		}
		if (request.overflow === "truncate") {
			stdout.push(chunk.subarray(0, remaining));
			stdoutBytes += remaining;
			truncated = true;
			stop("SIGKILL");
		} else {
			overflowed = true;
			stop();
		}
	});
	const maxStderr = request.maxStderrBytes ?? 64 * 1024;
	child.stderr!.on("data", (chunk: Buffer) => {
		if (stderr.length < maxStderr) stderr += chunk.toString("utf8").slice(0, maxStderr - stderr.length);
	});
	const finish = (message: ProcessReply) => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		clearTimeout(forceKill);
		children.delete(request.id);
		reply(message);
	};
	child.on("error", (error: NodeJS.ErrnoException) => {
		childError ??= error;
		// A child that never started (ENOENT, EACCES) has no stdio to wait for.
		if (child.pid === undefined)
			finish({ type: "error", id: request.id, message: error.message, ...(error.code ? { code: error.code } : {}) });
	});
	// Close, not exit: callers rely on stdio closure before reusing or removing a working copy.
	child.once("close", (code, signal) => {
		finish({
			type: "done",
			id: request.id,
			result: {
				code,
				signal,
				stdout: Buffer.concat(stdout, stdoutBytes),
				stderr,
				truncated,
				overflowed,
				timedOut,
				aborted,
				...(childError ? { error: childError.message } : {}),
			},
		});
	});
}

port.on("message", (command: WorkerCommand) => {
	if (command.type === "run") start(command.request);
	else children.get(command.id)?.stop();
});
