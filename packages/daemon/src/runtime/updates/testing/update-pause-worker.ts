/** Credential-free IPC peer for real host-supervision/update preparation tests. */
import type { KernelCommand, KernelPacket } from "@pilot/kernel";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { writeFileSync } from "node:fs";

const mode = process.argv[2];
const job =
	mode === "job" ? spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }) : undefined;
let canceled: Promise<void> | undefined;
function cancelJob(): Promise<void> {
	canceled ??= (async () => {
		if (!job) return;
		const exited = once(job, "exit");
		job.kill("SIGTERM");
		await exited;
		if (process.argv[3]) writeFileSync(process.argv[3], "owned-job-exited", { mode: 0o600 });
	})();
	return canceled;
}
const send = (packet: KernelPacket) => process.send?.(packet);
process.on("message", (command: KernelCommand) => {
	if (command.type === "start") send({ type: "ready", model: "test/offline", working: false, usage: {} });
	if (command.type === "watch")
		send({
			type: "events",
			watchId: command.watchId,
			events: [
				{
					type: "snapshot",
					entries: [],
					inbox: [],
					tools: [],
					nestedTools: [],
					compactions: [],
					agent: {},
					usage: { models: {}, tools: {} },
				},
			],
		});
	if (command.type === "input") {
		send({ type: "accepted", requestId: command.requestId });
		send({ type: "working", working: true });
	}
	if (command.type === "abort") {
		send({ type: "aborted", requestId: command.requestId, withdrawn: [] });
		send({ type: "working", working: false });
	}
	if (command.type === "pauseInputs" || command.type === "resumeInputs")
		send({ type: "accepted", requestId: command.requestId });
	if (command.type === "checkpointLifecycle") {
		if (mode === "job") {
			void cancelJob().then(() =>
				send({
					type: "error",
					requestId: command.requestId,
					message: "Job canceled; escaped descendants remain uncertain",
				}),
			);
			return;
		}
		if (mode === "unresponsive") return;
		if (mode === "errored") {
			send({ type: "error", requestId: command.requestId, message: "Broken chat fixture" });
			return;
		}
		send({
			type: "lifecycle.checkpointed",
			requestId: command.requestId,
			operationId: command.operationId,
			conversationId: "1",
			children: [],
			jobs: 0,
			hasChildren: false,
			...(mode !== "malformed" ? { updateNoticeOperationId: command.operationId } : {}),
		});
		send({ type: "accepted", requestId: command.requestId });
	}
	if (command.type === "shutdown") void cancelJob().then(() => process.exit(0));
});
