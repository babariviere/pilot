/** Cancel child recovery without loading a model, credentials or user extensions. */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createJiti } from "jiti";
import type { KernelSubagent } from "./protocol.ts";
import { openSessionStorage } from "./storage.ts";

export type RecoveryStop = { directory: string; cwd: string; sessionId: string };

/** Use the pinned supervisor's own shutdown journal, never reinterpret its private documents. */
export async function stopRecoveryChildren(spec: RecoveryStop): Promise<KernelSubagent[]> {
	const owned = await openSessionStorage(spec.directory);
	try {
		const source = fileURLToPath(
			new URL("../extensions/subagents/durable-supervisor.ts", pathToFileURL(PILOT_PROFILE_PATH)),
		);
		const jiti = createJiti(import.meta.url);
		const { DurableSupervisor, durableDirectory } = await jiti.import<{
			durableDirectory(ref: { sessionId: string; sessionFile: string; cwd: string }): string;
			DurableSupervisor: {
				open(
					ref: object,
					factory: () => object,
				): Promise<{
					close(): Promise<void>;
					describe(): KernelSubagent[];
				}>;
			};
		}>(source);
		const ref = { sessionId: spec.sessionId, sessionFile: join(spec.directory, "native.session"), cwd: spec.cwd };
		if (!existsSync(join(durableDirectory(ref), "runs.sqlite"))) return [];
		// Opening normally dispatches saved children. Supply transport placeholders, not workers:
		// shutdown retains stopRequested so the next real child aborts BEFORE its Harness resumes.
		const supervisor = await DurableSupervisor.open(ref, () => {
			let reject!: (error: Error) => void;
			const ready = new Promise<never>((_resolve, fail) => {
				reject = fail;
			});
			const unavailable = async () => {
				throw new Error("Recovery is stopped");
			};
			return {
				ready,
				input: unavailable,
				status: unavailable,
				stop: unavailable,
				cancel: async () => {
					reject(new Error("Recovery is stopped"));
				},
			};
		});
		await supervisor.close();
		return supervisor.describe();
	} finally {
		try {
			await owned.storage.close(BACKGROUND_CONTEXT);
		} finally {
			owned.release();
		}
	}
}
