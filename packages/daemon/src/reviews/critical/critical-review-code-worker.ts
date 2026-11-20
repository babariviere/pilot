import { parentPort, workerData } from "node:worker_threads";
import { scanCodeTree } from "./critical-review-code-tree.ts";

// Git child handles stay with the owner so terminating this worker cannot orphan a Git command.
let response: ((message: { bytes?: Uint8Array; error?: boolean }) => void) | undefined;
parentPort!.on("message", (message) => response?.(message));
parentPort!.postMessage({
	kind: "result",
	value: await scanCodeTree(
		workerData,
		(args, maxBuffer, input) =>
			new Promise((resolve, reject) => {
				response = (message) => {
					response = undefined;
					if (message.error) reject(new Error("Git read unavailable"));
					else resolve(Buffer.from(message.bytes!));
				};
				parentPort!.postMessage({ kind: "git", args, maxBuffer, input });
			}),
	),
});
