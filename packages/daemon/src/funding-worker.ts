import { parentPort, workerData } from "node:worker_threads";
import { FundingDisk } from "./funding-disk.ts";
import { FundingRefused } from "./funding-errors.ts";

const disk = new FundingDisk(workerData.file);
parentPort!.on("message", ({ id, method, args }) => {
	try {
		let value: unknown;
		switch (method) {
			case "read":
				value = disk.read(args.projectId, args.now);
				break;
			case "configure":
				value = disk.configure(args.projectId, args.expected, args.value);
				break;
			case "enabled":
				value = disk.enabled();
				break;
			case "setEnabled":
				value = disk.setEnabled(args.expected, args.enabled);
				break;
			case "fund":
				value = disk.fund(args.owner, args.expected, args.amount);
				break;
			case "open":
				value = disk.open(args.owner, args.amount);
				break;
			case "reserve":
				value = disk.reserve(args.owner, args.requestId, args.quote, args.job, args.now);
				break;
			case "settle":
				value = disk.settle(args.requestId, args.owner, args.usage);
				break;
			case "close":
				disk.close();
				break;
			default:
				throw new Error("Unknown funding method");
		}
		parentPort!.postMessage({ id, value });
	} catch (e) {
		parentPort!.postMessage({
			id,
			error: e instanceof Error ? e.message : "Funding unavailable",
			refused: e instanceof FundingRefused,
		});
	}
});
