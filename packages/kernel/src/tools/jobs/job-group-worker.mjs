/** Private jobs launch adapter. No replay, discovery, or persistent PID signalling. */
import { spawn } from "node:child_process";
import { connect } from "node:net";

const [mode, socket, token] = process.argv.slice(2);
if (mode === "client") {
	// The provider owns this client. The anchor is a separate, pinned process group,
	// so leader close / inherited-pipe disposal cannot cancel its escalation.
	const anchor = spawn(process.execPath, [import.meta.filename, "anchor", socket, token], {
		detached: true,
		stdio: ["ignore", "inherit", "inherit", "ipc"],
	});
	let completed = false;
	const stop = () => {
		if (anchor.connected) anchor.send({ type: "stop" });
	};
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	anchor.on("error", () => process.exit(1));
	anchor.on("message", (message) => {
		if (message?.type !== "shell-exit") return;
		completed = true;
		anchor.disconnect();
		process.exit(Number.isInteger(message.code) ? message.code : 1);
	});
	anchor.on("exit", () => {
		if (!completed) process.exit(1);
	});
} else if (mode === "anchor") {
	const channel = connect(socket);
	let buffer = "";
	let launched = false;
	let natural = false;
	let draining = false;
	let killing = false;
	let timer;
	const send = (message) => channel.write(`${JSON.stringify(message)}\n`);
	// Only this live group leader signals the group. A disconnected/reopened kernel
	// never sends signals to a saved numeric PID/PGID that may have been reused.
	const killGroup = () => {
		killing = true;
		process.kill(-process.pid, "SIGKILL");
	};
	const drain = () => {
		if (draining) return;
		draining = true;
		send({ type: "draining" });
		process.kill(-process.pid, "SIGTERM");
		timer = setTimeout(() => send({ type: "kill-ready" }), 3000);
	};
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
	process.on("message", (message) => {
		if (message?.type === "stop") drain();
	});
	process.on("disconnect", () => {
		if (!natural) drain();
	});
	channel.on("connect", () => send({ type: "hello", token, pgid: process.pid }));
	channel.on("data", (chunk) => {
		buffer += chunk.toString();
		if (buffer.length > 1024 * 1024) killGroup();
		for (;;) {
			const end = buffer.indexOf("\n");
			if (end < 0) break;
			let message;
			try {
				message = JSON.parse(buffer.slice(0, end));
			} catch {
				killGroup();
			}
			if (!message || typeof message !== "object" || Array.isArray(message)) killGroup();
			buffer = buffer.slice(end + 1);
			if (message.type === "drain") drain();
			if (message.type === "kill") killGroup();
			if (message.type !== "run" || launched || draining) continue;
			launched = true;
			const shell = spawn("bash", ["-c", message.command], { stdio: "inherit" });
			shell.on("error", () => drain());
			shell.on("exit", (code) => {
				natural = true;
				send({ type: "shell-exit", code });
				if (process.connected) process.send({ type: "shell-exit", code });
				// Keep the anchor until lifecycle drain. The provider can finish/prune its
				// ordinary shell result without releasing this group's ownership.
				process.stdout.destroy();
				process.stderr.destroy();
			});
		}
	});
	// If the kernel disappears, self-clean only the group we still lead. No receipt
	// is inferred from this best-effort cleanup after an interrupted owner.
	channel.on("error", killGroup);
	channel.on("close", () => {
		clearTimeout(timer);
		if (!killing) killGroup();
	});
} else {
	throw new Error("Invalid job-group worker mode");
}
