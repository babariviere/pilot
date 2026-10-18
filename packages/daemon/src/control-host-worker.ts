import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import { ControlHostError } from "./control-host-policy.ts";
import { ControlHostsDisk } from "./control-hosts-disk.ts";

const { path } = workerData as { path: string };
mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
const lease = new DatabaseSync(`${path}.owner`, { timeout: 0 });
lease.exec("BEGIN EXCLUSIVE");
const db = new DatabaseSync(path);
const disk = new ControlHostsDisk(db);
parentPort!.on("message", ({ id, method, args }) => {
	try {
		let value: unknown;
		if (method === "close") {
			db.close();
			lease.close();
		} else value = disk.call(method, args);
		parentPort!.postMessage({ id, value });
	} catch (error) {
		// Policy refusals are conclusive; disk/programming failures retain pending ownership.
		if (error instanceof ControlHostError)
			parentPort!.postMessage({ id, error: { ...error.response(), status: error.status } });
		else {
			parentPort!.postMessage({
				id,
				error: { code: "capacity", error: "Control host storage requires recovery", status: 503 },
			});
			throw error;
		}
	}
});
