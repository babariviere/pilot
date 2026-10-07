/** Daemon-owned PTYs: one shell per session, outliving app restarts, with scrollback replay on attach. */
import { accessSync, chmodSync, constants, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { IPty } from "node-pty";

const require = createRequire(import.meta.url);
/** Raw output kept per terminal and replayed to clients that (re)attach. */
const SCROLLBACK_BYTES = 2 * 1024 * 1024;

export interface TerminalListener {
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
	return { file: process.env.SHELL || "/bin/zsh", args: ["-l"] };
}

/** npm may skip node-pty's install script, which marks the prebuilt spawn helper executable. */
function loadPty(): NodePty {
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
	private readonly process: IPty;
	private scrollback: string[] = [];
	private size = 0;
	readonly listeners = new Set<TerminalListener>();
	exitCode?: number;

	constructor(shell: ShellCommand, cwd: string, cols: number, rows: number, env: Record<string, string>) {
		this.process = loadPty().spawn(shell.file, shell.args, {
			name: "xterm-256color",
			cols,
			rows,
			cwd,
			env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...env } as Record<string, string>,
		});
		this.process.onData((data) => {
			this.remember(data);
			for (const listener of this.listeners) listener.data(data);
		});
		this.process.onExit(({ exitCode }) => {
			this.exitCode = exitCode;
			for (const listener of this.listeners) listener.exit(exitCode);
		});
	}

	get output(): string {
		return this.scrollback.join("");
	}

	write(data: string): void {
		if (this.exitCode === undefined) this.process.write(data);
	}

	resize(cols: number, rows: number): void {
		if (this.exitCode !== undefined) return;
		if (cols > 0 && rows > 0 && cols <= 1000 && rows <= 1000) this.process.resize(Math.floor(cols), Math.floor(rows));
	}

	kill(): void {
		if (this.exitCode === undefined) this.process.kill("SIGHUP");
	}

	private remember(data: string): void {
		this.scrollback.push(data);
		this.size += data.length;
		while (this.size > SCROLLBACK_BYTES && this.scrollback.length > 1) this.size -= this.scrollback.shift()!.length;
	}
}

export class TerminalManager {
	private readonly terminals = new Map<string, Terminal>();

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
	): () => void {
		let terminal = this.terminals.get(sessionId);
		if (terminal && (restart || terminal.exitCode !== undefined)) {
			if (restart || terminal.listeners.size === 0) {
				terminal.kill();
				this.terminals.delete(sessionId);
				terminal = undefined;
			}
		}
		if (!terminal) {
			terminal = new Terminal(this.shell(), cwd, cols, rows, { PILOT_SESSION_ID: sessionId });
			this.terminals.set(sessionId, terminal);
		} else {
			terminal.resize(cols, rows);
		}
		const output = terminal.output;
		if (output) listener.data(output);
		if (terminal.exitCode !== undefined) listener.exit(terminal.exitCode);
		terminal.listeners.add(listener);
		const attached = terminal;
		return () => attached.listeners.delete(listener);
	}

	write(sessionId: string, data: string): void {
		this.terminals.get(sessionId)?.write(data);
	}

	resize(sessionId: string, cols: number, rows: number): void {
		this.terminals.get(sessionId)?.resize(cols, rows);
	}

	close(sessionId: string): void {
		this.terminals.get(sessionId)?.kill();
		this.terminals.delete(sessionId);
	}

	shutdown(): void {
		for (const terminal of this.terminals.values()) terminal.kill();
		this.terminals.clear();
	}
}
