import { parentPort, workerData } from "node:worker_threads";
import { CriticalReviewDisk } from "./critical-review-disk.ts";

const disk = new CriticalReviewDisk(workerData.file);
parentPort!.on("message", ({ id, method, args }) => {
	try {
		let value: unknown;
		if (method === "put") value = disk.put(args.record);
		else if (method === "get") value = disk.get(args.kind, args.id);
		else if (method === "list") value = disk.list(args.kind, args.after, args.limit);
		else if (method === "close") disk.close();
		else throw new Error("Unknown critical review operation");
		parentPort!.postMessage({ id, value });
	} catch (error) {
		parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
