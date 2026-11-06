import { parentPort, workerData } from "node:worker_threads";

const state = new Int32Array(workerData.state);
parentPort!.on("message", (message) => {
	if (message === "abort") {
		Atomics.store(state, 0, 1);
		Atomics.notify(state, 0);
		if (workerData.mode === "result") parentPort!.postMessage({ result: "late success" });
	} else if (message?.bytes) {
		Atomics.add(state, 1, 1);
		parentPort!.postMessage({ result: "bytes received" });
	}
});
if (workerData.mode === "success") parentPort!.postMessage({ result: "ready" });
else parentPort!.postMessage({ read: "held read" });
