import { parentPort, workerData } from "node:worker_threads";
import { CriticalReviewDisk } from "./critical-review-disk.ts";

const disk = new CriticalReviewDisk(workerData.file);
parentPort!.on("message", ({ id, method, args }) => {
	try {
		let value: unknown;
		if (method === "put") value = disk.put(args.record);
		else if (method === "get") value = disk.get(args.kind, args.id, args.now);
		else if (method === "list") value = disk.list(args.kind, args.after, args.limit, args.now);
		else if (method === "retentionAction") value = disk.retention.action(args.kind, args.id, args.action, args.now);
		else if (method === "eraseSource") value = disk.retention.erase(args.source);
		else if (method === "expire") value = disk.retention.expire(args.now);
		else if (method === "pendingErasure") value = disk.retention.pending();
		else if (method === "finishErasure") value = disk.retention.finish(args.kind, args.id);
		else if (method === "vaultStage") value = disk.retention.stage(args.id, args.projectId, args.bytes);
		else if (method === "abortStage") value = disk.db.prepare("DELETE FROM review_staging WHERE id=?").run(args.id);
		else if (method === "stagedCaptures") value = disk.db.prepare("SELECT id FROM review_staging LIMIT 16").all();
		else if (method === "close") disk.close();
		else throw new Error("Unknown critical review operation");
		parentPort!.postMessage({ id, value });
	} catch (error) {
		parentPort!.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
	}
});
