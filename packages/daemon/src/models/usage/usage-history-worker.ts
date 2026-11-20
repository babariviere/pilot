import { parentPort, workerData } from "node:worker_threads";
import { UsageHistoryDisk } from "./usage-history-disk.ts";

const disk = new UsageHistoryDisk(workerData.file, workerData.now, workerData.limits);
let clock = workerData.now as number;
let wall = Date.now();
let idleTimer: NodeJS.Timeout | undefined;
let batch: NodeJS.Immediate | undefined;
// Privacy maintenance, not provider/host polling. Each <=500-row transaction yields to queued RPCs.
// Hourly idle cleanup bounds retention lag without doing writes on UI repaint.
function sweep(): void {
	const before = disk.status().expired;
	disk.expire(clock + Math.max(0, Date.now() - wall));
	if (disk.status().expired - before >= 500) batch = setImmediate(sweep).unref();
	else idleTimer = setTimeout(sweep, 60 * 60 * 1000).unref();
}
batch = setImmediate(sweep).unref();
parentPort!.on("message", ({ id, method, args }) => {
	try {
		clock = args.now;
		wall = Date.now();
		let value: unknown;
		if (method === "status") value = disk.status();
		else if (method === "put") value = disk.put(args.row, args.now);
		else if (method === "page") value = disk.page(args.query, args.now);
		else if (method === "analytics") value = disk.analytics(args.query, args.now);
		else if (method === "erase") value = disk.erase(args.chatId, args.now);
		else if (method === "expire") {
			disk.expire(args.now);
			value = disk.status();
		} else if (method === "close") {
			clearTimeout(idleTimer);
			if (batch) clearImmediate(batch);
			disk.close();
		} else throw new Error("Invalid usage operation");
		parentPort!.postMessage({ id, value });
	} catch {
		// Never send raw SQLite/input error text into logs or clients.
		parentPort!.postMessage({ id, error: "Usage history unavailable" });
	}
});
