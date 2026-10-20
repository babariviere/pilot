/** Fixed host-owned Pilot user-service journal adapter. Not a general command/unit interface. */
import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sanitizeDiagnosticLogLine } from "./diagnostic-logs.ts";

export const JOURNAL_BYTES = 192 * 1024;
export const JOURNAL_RECORDS = 256;
export const JOURNAL_TIMEOUT_MS = 1500;
export const JOURNAL_CACHE_BYTES = 128 * 1024;
export interface ServiceJournalResult {
	available: boolean;
	text: string;
	truncated: boolean;
	reason?: "journal_unavailable" | "inaccessible" | "unsafe_source";
}
const unavailable = (reason: ServiceJournalResult["reason"] = "journal_unavailable"): ServiceJournalResult => ({
	available: false,
	text: "",
	truncated: false,
	reason,
});

/** Must stay byte-identical to the installed renderer; a fixture test detects drift. */
export function expectedPilotService(root: string, home: string): string {
	if (root.includes(":") || home.includes(":")) throw new Error("Unsafe service identity");
	const safe = (value: string) => {
		if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Unsafe service identity");
		return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
	};
	const quote = (value: string) => `"${safe(value)}"`;
	const exec = (value: string) => quote(value.replaceAll("$", () => "$$"));
	return `# Managed by Pilot Linux runtime v1\n[Unit]\nDescription=Pilot background agents\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%h\nExecStartPre=-${exec(join(root, "node/bin/node"))} ${exec(join(root, "packages/daemon/src/linux-coordinator-probe.ts"))} --output ${exec(join(root, "coordinator-preflight.json"))}\nExecStart=${exec(join(root, "node/bin/node"))} ${exec(join(root, "packages/daemon/src/main.ts"))}\nEnvironment=${quote(`HOME=${home}`)}\nEnvironment=${quote(`PILOT_HOME=${join(home, ".local/share/pilot")}`)}\nEnvironment=${quote(`PATH=${join(root, "bin")}:${join(root, "node/bin")}:${join(home, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`)}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGTERM\nKillMode=mixed\nTimeoutStopSec=120\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

async function smallOwnedFile(path: string, uid: number, max: number): Promise<string> {
	const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const stat = await file.stat();
		if (!stat.isFile() || stat.uid !== uid || stat.mode & 0o022 || stat.size > max) throw new Error("Unsafe source");
		const bytes = Buffer.alloc(max + 1);
		const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
		if (bytesRead > max) throw new Error("Oversized source");
		return bytes.subarray(0, bytesRead).toString("utf8");
	} finally {
		await file.close();
	}
}

export async function ownsPilotService(home: string, dataHome: string, root: string, uid: number): Promise<boolean> {
	if (!uid || dataHome !== join(home, ".local/share/pilot") || process.execPath !== join(root, "node/bin/node"))
		return false;
	const unit = join(home, ".config/systemd/user/pilotd.service");
	if ((await realpath(dirname(unit))) !== dirname(unit)) return false;
	const [contents, cgroup] = await Promise.all([
		smallOwnedFile(unit, uid, 16 * 1024),
		smallOwnedFile("/proc/self/cgroup", uid, 4096),
	]);
	return matchesPilotService(contents, cgroup, root, home, uid);
}

export function matchesPilotService(
	contents: string,
	cgroup: string,
	root: string,
	home: string,
	uid: number,
): boolean {
	return (
		uid > 0 &&
		contents === expectedPilotService(root, home) &&
		cgroup
			.split("\n")
			.some(
				(line) =>
					/^\d+:[^:]*:/.test(line) &&
					line
						.slice(line.indexOf(":", line.indexOf(":") + 1) + 1)
						.startsWith(`/user.slice/user-${uid}.slice/user@${uid}.service/`) &&
					line.endsWith("/pilotd.service"),
			)
	);
}

/** Only fixed args, a minimal host-derived environment, and bounded pipe reads. No shell or stdin. */
export async function runPilotJournal(
	uid: number,
	home: string,
	signal?: AbortSignal,
	launch = spawn,
): Promise<ServiceJournalResult> {
	if (signal?.aborted) throw new Error("Diagnostic read cancelled");
	const args = [
		"--user",
		"--no-pager",
		"--output=json",
		"--output-fields=MESSAGE,_UID,_SYSTEMD_USER_UNIT,__REALTIME_TIMESTAMP",
		"--reverse",
		`--lines=${JOURNAL_RECORDS}`,
		"--since=-7days",
		`_UID=${uid}`,
		"_SYSTEMD_USER_UNIT=pilotd.service",
	];
	return new Promise((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = launch("/usr/bin/journalctl", args, {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
				env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", XDG_RUNTIME_DIR: `/run/user/${uid}` },
			});
		} catch {
			resolve(unavailable());
			return;
		}
		let bytes = 0,
			stderr = "",
			exceeded = false,
			timedOut = false,
			cancelled = false;
		const output: Buffer[] = [];
		const cancel = () => {
			cancelled = true;
			child.kill("SIGKILL");
		};
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, JOURNAL_TIMEOUT_MS);
		const dispose = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
		};
		signal?.addEventListener("abort", cancel, { once: true });
		if (signal?.aborted) cancel();
		child.stdout?.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > JOURNAL_BYTES) {
				exceeded = true;
				child.kill("SIGKILL");
				return;
			}
			output.push(chunk);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (stderr.length < 4096) stderr += chunk.toString("utf8").slice(0, 4096 - stderr.length);
		});
		child.once("error", () => {
			dispose();
			resolve(unavailable());
		});
		child.once("close", (code) => {
			dispose();
			if (cancelled) {
				reject(new Error("Diagnostic read cancelled"));
				return;
			}
			if (exceeded || timedOut || code !== 0) {
				resolve(unavailable(/permission|access denied/i.test(stderr) ? "inaccessible" : "journal_unavailable"));
				return;
			}
			const lines: string[] = [];
			let retained = 0;
			let truncated = false;
			for (const raw of Buffer.concat(output).toString("utf8").split("\n")) {
				if (!raw) continue;
				try {
					const row = JSON.parse(raw);
					if (
						row._UID !== String(uid) ||
						row._SYSTEMD_USER_UNIT !== "pilotd.service" ||
						typeof row.MESSAGE !== "string"
					) {
						truncated = true;
						continue;
					}
					const at = Number(row.__REALTIME_TIMESTAMP) / 1000;
					if (!Number.isFinite(at) || at < 0 || row.MESSAGE.length > 64 * 1024) {
						truncated = true;
						continue;
					}
					const safe = sanitizeDiagnosticLogLine(row.MESSAGE);
					const clipped = Buffer.from(safe)
						.subarray(0, 8 * 1024)
						.toString("utf8");
					truncated ||= clipped !== safe;
					const line = JSON.stringify({ at: new Date(at).toISOString(), line: clipped });
					if (retained + Buffer.byteLength(line) + 1 > JOURNAL_CACHE_BYTES) {
						truncated = true;
						break;
					}
					retained += Buffer.byteLength(line) + 1;
					lines.push(line);
					if (lines.length >= JOURNAL_RECORDS) {
						truncated = true;
						break;
					}
				} catch {
					truncated = true;
				}
			}
			resolve({ available: true, text: `${lines.reverse().join("\n")}\n`, truncated });
		});
	});
}

export class PilotServiceJournal {
	private cached?: { at: number; value: ServiceJournalResult };
	private busy = false;
	private readonly options: {
		home: string;
		dataHome: string;
		root: string;
		platform?: NodeJS.Platform;
		uid?: number;
		now?: () => number;
		owns?: () => Promise<boolean>;
		run?: (signal?: AbortSignal) => Promise<ServiceJournalResult>;
	};
	constructor(options: PilotServiceJournal["options"]) {
		this.options = options;
	}
	async read(signal?: AbortSignal): Promise<ServiceJournalResult> {
		if (signal?.aborted) throw new Error("Diagnostic read cancelled");
		if ((this.options.platform ?? process.platform) !== "linux") return unavailable();
		const now = this.options.now?.() ?? Date.now();
		if (this.cached && now - this.cached.at < 60_000) return this.cached.value;
		if (this.busy) return unavailable();
		this.busy = true;
		try {
			const { home, dataHome, root } = this.options;
			const uid = this.options.uid ?? process.getuid?.() ?? 0;
			if (!uid || !(await (this.options.owns?.() ?? ownsPilotService(home, dataHome, root, uid))))
				return unavailable("unsafe_source");
			if (!this.options.run) {
				const path = await realpath("/usr/bin/journalctl");
				const stat = await lstat(path);
				if (!stat.isFile() || stat.uid !== 0 || stat.mode & 0o022) return unavailable("unsafe_source");
			}
			const value = await (this.options.run?.(signal) ?? runPilotJournal(uid, home, signal));
			this.cached = { at: now, value };
			return value;
		} catch (error) {
			if (signal?.aborted) throw error;
			return unavailable(
				(error as NodeJS.ErrnoException).code === "EACCES" ? "inaccessible" : "journal_unavailable",
			);
		} finally {
			this.busy = false;
		}
	}
}
