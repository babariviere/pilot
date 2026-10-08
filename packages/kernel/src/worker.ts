/** Kernel worker entry: one process per session, driven over Node IPC by pilotd. */
import type { KernelCommand, KernelPacket } from "./protocol.ts";
import { ConversationBusy } from "@earendil-works/pi-durable";
import { KernelSession } from "./session.ts";

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

function send(packet: KernelPacket): Promise<void> {
	return new Promise((resolve) => {
		if (!process.send || !process.connected) return resolve();
		process.send(packet, () => resolve());
	});
}

let session: KernelSession | undefined;
let initialization: Promise<void> | undefined;
let commands: Promise<void> = Promise.resolve();
let exiting = false;

async function shutdown(code = 0): Promise<void> {
	if (exiting) return;
	exiting = true;
	// Bound teardown; durable state is already committed, so a forced exit only loses in-memory work.
	const watchdog = setTimeout(() => process.exit(1), 5_000);
	watchdog.unref();
	try {
		await initialization?.catch(() => undefined);
		await commands;
		await session?.close();
	} catch (error) {
		await send({ type: "error", message: `Shutdown failed: ${errorText(error)}` });
		code = 1;
	}
	process.exit(code);
}

async function execute(command: Exclude<KernelCommand, { type: "start" | "shutdown" }>): Promise<void> {
	await initialization;
	if (!session) throw new Error("Kernel has not started");
	switch (command.type) {
		case "input":
			await session.submit(command.requestId, command.content, command.mode);
			await send({ type: "accepted", requestId: command.requestId });
			break;
		case "abort":
			await session.abort();
			await send({ type: "aborted", requestId: command.requestId });
			break;
		case "editQueuedMessage":
			await session.editQueuedMessage(command.submissionId, command.content);
			await send({ type: "accepted", requestId: command.requestId });
			break;
		case "changeModel":
			await session.changeModel(command.model, command.thinking);
			await send({
				type: "modelChanged",
				requestId: command.requestId,
				model: session.model,
				thinking: session.thinkingLevel,
				usage: session.usage,
			});
			break;
		case "removeQueuedMessage":
			await session.removeQueuedMessage(command.submissionId);
			await send({ type: "accepted", requestId: command.requestId });
			break;
		case "watch":
			await session.watch(
				command.watchId,
				(events) => {
					void send({ type: "events", watchId: command.watchId, events });
				},
				command.includeTodos,
				command.activityOnly,
			);
			break;
		case "unwatch":
			await session.unwatch(command.watchId);
			break;
	}
}

process.on("message", (message: unknown) => {
	if (exiting || !message || typeof message !== "object") return;
	const command = message as KernelCommand;
	if (command.type === "shutdown") {
		void shutdown();
		return;
	}
	if (command.type === "start") {
		if (initialization) return;
		initialization = (async () => {
			session = await KernelSession.open(command.spec, {
				onWorking: (working, completion) =>
					void send({ type: "working", working, ...(completion ? { completion } : {}) }),
				onUsageChanged: (usage) => void send({ type: "usage", usage }),
				onArtifactsChanged: () => void send({ type: "artifacts.changed" }),
			});
			await send({
				type: "ready",
				model: session.model,
				thinking: session.thinkingLevel,
				working: session.working,
				usage: session.usage,
				...(session.completion ? { completion: session.completion } : {}),
			});
		})();
		initialization.catch(async (error) => {
			await send({ type: "error", message: `Kernel failed to start: ${errorText(error)}` });
			await shutdown(1);
		});
		return;
	}
	commands = commands
		.then(() => execute(command))
		.catch((error) =>
			send({
				type: "error",
				requestId: "requestId" in command ? command.requestId : undefined,
				message: errorText(error),
				...(error instanceof ConversationBusy ? { code: "busy" as const } : {}),
			}),
		);
});

process.on("disconnect", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());
