/** Daemon-owned PTYs: one shell per session, outliving app restarts, with scrollback replay on attach. */

import { randomUUID } from "node:crypto";
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { resolveLoginShell } from "@pilot/kernel/runtime-environment";
import type { IPty } from "node-pty";
import { BoundedPtyInput } from "./pty-input.ts";
import { RuntimeAdmission, type RuntimeBlocker } from "./runtime-admission.ts";
import { TerminalScrollback } from "./terminal-output.ts";

const require = createRequire(import.meta.url);
export interface TerminalListener {
	ready?(terminalId: string): void;
	data(data: string): void;
	exit(code: number): void;
}

type NodePty = typeof import("node-pty");
let pty: NodePty | undefined;

export interface ShellCommand {
	file: string;
	args: string[];
}

/** The user's login shell. */
export function loginShell(): ShellCommand {
	return { file: resolveLoginShell(), args: ["-l"] };
}

/** Installs may skip node-pty's install script, which marks the prebuilt spawn helper executable. */
export function loadPty(): NodePty {
	if (pty) return pty;
	const root = dirname(require.resolve("node-pty/package.json"));
	for (const dir of [join(root, "prebuilds", `${process.platform}-${process.arch}`), join(root, "build", "Release")]) {
		const helper = join(dir, "spawn-helper");
		if (!existsSync(helper)) continue;
		try {
			accessSync(helper, constants.X_OK);
		} catch {
			chmodSync(helper, 0o755);
		}
	}
	pty = require("node-pty") as NodePty;
	return pty;
}

class Terminal {
	readonly id = randomUUID();
	private readonly process: IPty;
	private readonly input?: BoundedPtyInput;
	readonly inputError?: Error;
	private readonly scrollback = new TerminalScrollback();
	readonly listeners = new Set<TerminalListener>();
	exitCode?: number;
	private forceKill?: ReturnType<typeof setTimeout>;
	private resolveExit?: () => void;
	readonly exited = new Promise<void>((resolve) => {
		this.resolveExit = resolve;
	});

	constructor(
		shell: ShellCommand,
		cwd: string,
		cols: number,
		rows: number,
		env: Record<string, string>,
		onExit: () => void,
	) {
		this.process = loadPty().spawn(shell.file, shell.args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...env } as Record<string, string>,
		});
		try {
			this.input = new BoundedPtyInput(this.process);
		} catch {
			this.inputError = new Error("Unsupported terminal input adapter; shell is being terminated");
		}
		this.process.onData((data) => {
			this.scrollback.append(data);
			for (const listener of this.listeners) listener.data(data);
		});
		this.process.onExit(({ exitCode }) => {
			this.exitCode = exitCode;
			this.input?.close();
			clearTimeout(this.forceKill);
			onExit();
			this.resolveExit?.();
			for (const listener of this.listeners) listener.exit(exitCode);
		});
	}

	get output(): string {
		return this.scrollback.output;
	}

	write(data: string): void {
		if (this.exitCode === undefined) this.input?.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.exitCode !== undefined) return;
		if (cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) this.process.resize(Math.floor(cols), Math.floor(rows));
	}

	kill(): void {
		if (this.exitCode !== undefined || this.forceKill) return;
		this.input?.close();
		this.process.kill("SIGHUP");
		// A shell may ignore SIGHUP. Keep it counted as live until its actual exit event.
		this.forceKill = setTimeout(() => {
			if (this.exitCode !== undefined) return;
			try {
				if (process.platform !== "win32") process.kill(-this.process.pid, "SIGKILL");
				else this.process.kill("SIGKILL");
			} catch {
				try {
					this.process.kill("SIGKILL");
				} catch {
					// Exit may already have happened while node-pty's exit notification is pending.
				}
			}
		}, 1_000);
		this.forceKill.unref();
	}
}

export class TerminalManager {
	readonly bootId = randomUUID();
	private readonly admission = new RuntimeAdmission();
	private readonly listeners = new Set<() => void>();
	private readonly requests = new Map<string, { sessionId: string; terminalId: string }>();
	private stopped = false;
	private readonly terminals = new Map<string, Terminal>();
	/** Includes retired shells during close/restart, until node-pty confirms that they exited. */
	private readonly processes = new Map<string, Set<Terminal>>();

	private readonly shell: () => ShellCommand;

	constructor(shell: () => ShellCommand = loginShell) {
		this.shell = shell;
	}

	/**
	 * Attach to the session's shell, starting one if needed (or if `restart`). The listener first
	 * receives the retained scrollback, then live output.
	 */
	attach(
		sessionId: string,
		cwd: string,
		cols: number,
		rows: number,
		listener: TerminalListener,
		restart = false,
		request?: { bootId: string; requestId: string; terminalId?: string },
	): () => void {
		if (this.stopped) throw new Error("Terminals are shutting down");
		if (request && request.bootId !== this.bootId)
			throw new Error("Terminal daemon restarted; explicitly open a new shell");
		let terminal = this.terminals.get(sessionId);
		const known = request && this.requests.get(request.requestId);
		if (known) {
			if (known.sessionId !== sessionId) throw new Error("Terminal request belongs to another session");
			if (terminal?.id !== known.terminalId)
				throw new Error("Terminal was replaced or closed; explicitly open a new shell");
			restart = false;
		}
		if (!known && request?.terminalId && terminal?.id !== request.terminalId)
			throw new Error("Terminal was replaced or closed");
		const needsReceipt = request && !known && (restart || !request.terminalId);
		if (needsReceipt && this.requests.size >= 512)
			throw new Error("Terminal request capacity reached; no shell was changed");
		if (request && !known && restart && terminal && !request.terminalId)
			throw new Error("Terminal changed since the open handshake; reattach explicitly");
		if ((!terminal || restart) && [...this.processes.values()].reduce((n, entries) => n + entries.size, 0) >= 16)
			throw new Error("Live terminal capacity reached");
		if (!terminal || restart) {
			const victim =
				this.terminals.size >= 32 && !this.terminals.has(sessionId)
					? [...this.terminals].find(
							([, entry]) => entry.exitCode !== undefined && entry.listeners.size === 0,
						)?.[0]
					: undefined;
			if (this.terminals.size >= 32 && !this.terminals.has(sessionId) && !victim)
				throw new Error("Terminal retention capacity reached; explicitly close an old shell");
			const end = this.admission.begin({ kind: "terminal-admission", id: sessionId });
			try {
				if (victim) this.terminals.delete(victim);
				// Reserve before any side effect, including startup failure. An ambiguous failed open
				// never repeats under the same key; an explicit new action gets a new key.
				if (needsReceipt) this.requests.set(request.requestId, { sessionId, terminalId: randomUUID() });
				if (terminal) {
					terminal.kill();
					this.terminals.delete(sessionId);
				}
				const created = new Terminal(this.shell(), cwd, cols, rows, { PILOT_SESSION_ID: sessionId }, () => {
					const processes = this.processes.get(sessionId);
					processes?.delete(created);
					if (!processes?.size) this.processes.delete(sessionId);
					this.emit();
				});
				terminal = created;
				let processes = this.processes.get(sessionId);
				if (!processes) {
					processes = new Set();
					this.processes.set(sessionId, processes);
				}
				processes.add(terminal);
				this.terminals.set(sessionId, terminal);
				if (needsReceipt) this.requests.set(request.requestId, { sessionId, terminalId: terminal.id });
				if (created.inputError) {
					created.kill();
					throw created.inputError;
				}
			} finally {
				end();
			}
		} else {
			terminal.resize(cols, rows);
		}
		if (terminal.inputError) throw terminal.inputError;
		if (terminal.listeners.size >= 4) throw new Error("Terminal attachment capacity reached");
		if (needsReceipt) {
			this.requests.set(request.requestId, { sessionId, terminalId: terminal.id });
		}
		listener.ready?.(terminal.id);
		const output = terminal.output;
		if (output) listener.data(output);
		if (terminal.exitCode !== undefined) listener.exit(terminal.exitCode);
		terminal.listeners.add(listener);
		this.emit();
		const attached = terminal;
		return () => attached.listeners.delete(listener);
	}

	write(sessionId: string, data: string, terminalId?: string): void {
		this.target(sessionId, terminalId)?.write(data);
	}

	resize(sessionId: string, cols: number, rows: number, terminalId?: string): void {
		this.target(sessionId, terminalId)?.resize(cols, rows);
	}

	close(sessionId: string, terminalId?: string): void {
		this.target(sessionId, terminalId)?.kill();
		// Instance-qualified clients can reattach during close and wait for real exit proof.
		if (!terminalId) this.terminals.delete(sessionId);
		this.emit();
	}
	private target(sessionId: string, id?: string): Terminal | undefined {
		const terminal = this.terminals.get(sessionId);
		if (id && terminal?.id !== id) throw new Error("Terminal was replaced or closed");
		return terminal;
	}
	currentId(sessionId: string): string | undefined {
		return this.terminals.get(sessionId)?.id;
	}
	freezeAdmissions(): () => void {
		return this.admission.freezeAdmissions();
	}
	blockers(): RuntimeBlocker[] {
		return [
			...this.admission.blockers(),
			...[...this.processes].flatMap(([sessionId, entries]) =>
				[...entries].map((terminal) => ({ kind: "terminal", id: terminal.id, sessionId })),
			),
		];
	}
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	private emit(): void {
		for (const listener of this.listeners) listener();
	}

	/** Detached shells can still write into their cwd, so they also block workspace reclamation. */
	isRunning(sessionId: string): boolean {
		return [...(this.processes.get(sessionId) ?? [])].some((terminal) => terminal.exitCode === undefined);
	}

	async shutdown(): Promise<void> {
		this.stopped = true;
		const terminals = [...this.processes.values()].flatMap((processes) => [...processes]);
		for (const terminal of terminals) terminal.kill();
		this.terminals.clear();
		this.requests.clear();
		await Promise.all(terminals.map((terminal) => terminal.exited));
	}
}
