/** Managed user service. No sudo, package installation, global tools or implicit restart. */
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const unitName = "pilotd.service";
const marker = "# Managed by Pilot Linux runtime v1";
export const run = (command, args = [], timeout = 15000) => {
	const result = spawnSync(command, args, { encoding: "utf8", timeout, maxBuffer: 128 * 1024 });
	return {
		ok: result.status === 0,
		output: (result.stdout ?? "").trim(),
		error: (result.stderr ?? result.error?.message ?? "").trim(),
	};
};

export function packagePlan(check = run) {
	const manager = ["dnf", "apt-get", "yum"].find((command) => check(command, ["--version"]).ok);
	const packages =
		manager === "dnf" || manager === "yum"
			? ["git", "bash", "systemd", "dbus-daemon", "util-linux", "libstdc++"]
			: ["git", "bash", "systemd", "dbus-user-session", "util-linux", "libstdc++6"];
	return {
		manager: manager ?? null,
		requiresPrivilege: true,
		command: manager ? ["sudo", manager, "install", "-y", ...packages] : null,
	};
}

export function probe({
	check = run,
	platform = process.platform,
	arch = process.arch,
	user = userInfo().username,
	uid = process.getuid?.(),
} = {}) {
	const requirements = [
		{ id: "platform", ok: platform === "linux" && arch === "x64", detail: "Linux x86-64 required" },
		{ id: "user", ok: uid !== 0, detail: "A dedicated non-root user is required" },
		{ id: "git", ok: check("git", ["--version"]).ok, detail: "Install git using the host package manager" },
		{ id: "bash", ok: check("bash", ["--version"]).ok, detail: "Install bash using the host package manager" },
		{
			id: "userManager",
			ok: check("systemctl", ["--user", "show-environment"]).ok,
			detail: "A reachable systemd user manager and user D-Bus session are required",
		},
		{
			id: "linger",
			ok: check("loginctl", ["show-user", user, "--property=Linger", "--value"]).output === "yes",
			detail: "An explicit administrator-approved linger grant is required for logout/reboot survival",
		},
	];
	return {
		schemaVersion: 1,
		ok: requirements.every((item) => item.ok),
		requirements,
		packagePlan: packagePlan(check),
		lingerSetup: { requiresPrivilege: true, command: ["sudo", "loginctl", "enable-linger", user] },
	};
}

function safe(value) {
	if (/[\x00-\x1f\x7f]/.test(value)) throw new Error("Control characters are not allowed in service paths");
	return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
}

export function serviceUnit(root, home) {
	if (root.includes(":") || home.includes(":")) throw new Error("Service paths cannot contain PATH separators");
	const quote = (value) => `"${safe(value)}"`;
	const execQuote = (value) => quote(value.replaceAll("$", () => "$$"));
	return `${marker}\n[Unit]\nDescription=Pilot background agents\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=%h\nExecStart=${execQuote(join(root, "node/bin/node"))} ${execQuote(join(root, "packages/daemon/src/main.ts"))}\nEnvironment=${quote(`HOME=${home}`)}\nEnvironment=${quote(`PILOT_HOME=${join(home, ".local/share/pilot")}`)}\nEnvironment=${quote(`PATH=${join(root, "bin")}:${join(root, "node/bin")}:${join(home, ".local/bin")}:/usr/local/bin:/usr/bin:/bin`)}\nUMask=0077\nRestart=on-failure\nRestartSec=5\nKillSignal=SIGTERM\nKillMode=mixed\nTimeoutStopSec=120\nStandardOutput=journal\nStandardError=journal\n\n[Install]\nWantedBy=default.target\n`;
}

function requireCommand(command, args, timeout) {
	const result = run(command, args, timeout);
	if (!result.ok) throw new Error(`${command} failed: ${result.error || result.output}`);
	return result.output;
}

export function publishUnit(file, expected) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const temp = `${file}.${process.pid}.tmp`;
	writeFileSync(temp, expected, { mode: 0o600, flag: "wx" });
	try {
		try {
			// Atomic create, never a rename-overwrite. Concurrent different-runtime setup must lose.
			linkSync(temp, file);
		} catch (error) {
			if (error.code !== "EEXIST" || readFileSync(file, "utf8") !== expected) throw error;
		}
	} finally {
		unlinkSync(temp);
	}
}

export async function main(action) {
	const root = realpathSync(dirname(fileURLToPath(import.meta.url)));
	const home = realpathSync(homedir());
	const file = join(home, ".config/systemd/user", unitName);
	const expected = serviceUnit(root, home);
	if (action === "probe") {
		const result = probe();
		console.log(JSON.stringify(result));
		if (!result.ok) process.exitCode = 2;
		return;
	}
	if (!["install", "start", "status", "stop"].includes(action))
		throw new Error("Usage: bin/pilot-runtime probe|install|start|status|stop");
	if (action === "install") {
		const capabilities = probe();
		if (!capabilities.ok) throw new Error(`Service prerequisites not met: ${JSON.stringify(capabilities)}`);
		// First setup only. Updates need a separate drain/blocker transaction, never an implicit restart.
		if (existsSync(file) && readFileSync(file, "utf8") !== expected)
			throw new Error(
				"Existing pilotd.service differs. Refusing to overwrite a service or switch runtimes; use the safe update flow",
			);
		const loaded = run("systemctl", ["--user", "show", unitName, "--property=FragmentPath", "--value"]).output;
		if (loaded && loaded !== file) throw new Error("pilotd.service is owned elsewhere; refusing to shadow it");
		requireCommand(join(root, "node/bin/node"), [join(root, "check-runtime.mjs")], 60000);
		publishUnit(file, expected);
		requireCommand("systemctl", ["--user", "daemon-reload"]);
		requireCommand("systemctl", ["--user", "enable", unitName]);
		console.log(JSON.stringify({ installed: true, started: false, unit: file }));
		return;
	}
	if (!existsSync(file) || readFileSync(file, "utf8") !== expected)
		throw new Error("This runtime does not own the installed pilotd.service");
	if (requireCommand("systemctl", ["--user", "show", unitName, "--property=FragmentPath", "--value"]) !== file)
		throw new Error("The user manager loaded a different pilotd.service; refusing to control it");
	if (action === "start") {
		if (!probe().ok) throw new Error("Persistent-service prerequisites no longer met; run probe");
		requireCommand("systemctl", ["--user", "start", unitName]);
	} else if (action === "stop") {
		// Explicit user action. SIGTERM drains durable sessions; live jobs/PTYs do not survive stop.
		requireCommand("systemctl", ["--user", "stop", unitName], 130000);
	}
	const result = requireCommand("systemctl", [
		"--user",
		"show",
		unitName,
		"--property=ActiveState,SubState,MainPID,ExecMainStatus,Result",
	]);
	console.log(
		JSON.stringify(
			Object.fromEntries(
				result.split("\n").map((line) => {
					const at = line.indexOf("=");
					return [line.slice(0, at), line.slice(at + 1)];
				}),
			),
		),
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
	main(process.argv[2]).catch((error) => {
		console.error(JSON.stringify({ error: String(error.message ?? error) }));
		process.exitCode = 1;
	});
}
