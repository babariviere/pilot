/** Bounded terminal handshake for the disposable package/update fixture, not product transport. */
import { randomUUID } from "node:crypto";

export function openUpdateFixtureTerminal(base, sessionId, { Socket = globalThis.WebSocket, timeoutMs = 10_000 } = {}) {
	const url = new URL(`/api/sessions/${encodeURIComponent(sessionId)}/terminal/ws`, base);
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
	// Size belongs in the route query, not terminal.open. Without it the server refuses before hello.
	url.search = new URLSearchParams({ protocol: "2", cols: "80", rows: "24" }).toString();
	const socket = new Socket(url.href);
	const history = [];
	let ready = false;
	let terminalId;
	let exited = false;
	let finishClose;
	const record = (value) => {
		history.push(String(value).slice(0, 240));
		if (history.length > 8) history.shift();
	};
	const diagnostic = (reason) => new Error(`Update fixture terminal ${reason}; events=${JSON.stringify(history)}`);
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => fail("open deadline reached"), timeoutMs);
		const fail = (reason) => {
			clearTimeout(timer);
			const error = diagnostic(reason);
			if (!ready) reject(error);
			finishClose?.(error);
			if (socket.readyState === 0 || socket.readyState === 1) socket.close();
		};
		socket.addEventListener("error", (event) => {
			record(`error:${event.message ?? "WebSocket transport error"}`);
			fail("transport failed");
		});
		socket.addEventListener("close", (event) => {
			record(`close:${event.code}:${event.reason ?? ""}`);
			if (!ready || !exited) fail("closed before the expected handshake or exit");
		});
		socket.addEventListener("message", (event) => {
			let message;
			try {
				message = JSON.parse(String(event.data));
			} catch {
				fail("received invalid JSON");
				return;
			}
			// Never retain shell output. Bounded control summaries are sufficient for fixture failures.
			if (message.type === "terminal.data") return;
			record(`${message.type}:${message.type === "error" ? String(message.message).slice(0, 200) : ""}`);
			if (message.type === "error") {
				fail("was refused");
				return;
			}
			if (message.type === "terminal.hello") {
				socket.send(JSON.stringify({ type: "terminal.open", bootId: message.bootId, requestId: randomUUID() }));
			} else if (message.type === "terminal.ready") {
				if (ready) {
					fail("received duplicate readiness");
					return;
				}
				clearTimeout(timer);
				ready = true;
				terminalId = message.terminalId;
				resolve({
					socket,
					terminalId,
					closeShell: () => {
						if (exited) {
							socket.close();
							return Promise.resolve();
						}
						return new Promise((resolveExit, rejectExit) => {
							const closeTimer = setTimeout(() => finishClose(diagnostic("exit deadline reached")), timeoutMs);
							finishClose = (error) => {
								clearTimeout(closeTimer);
								finishClose = undefined;
								if (error) rejectExit(error);
								else resolveExit();
								socket.close();
							};
							socket.send(JSON.stringify({ type: "terminal.close", terminalId }));
						});
					},
				});
			} else if (message.type === "terminal.exit") {
				exited = true;
				if (!ready) fail("exited before readiness");
				finishClose?.();
			}
		});
	});
}
