import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { UpdateReservation } from "../packages/daemon/src/update-reservation.ts";
import { recoverOnce } from "./day-recover-legacy.ts";

test("legacy global envelope is refused before checkpoint or admission effects", async () => {
	// This production class is byte-identical to the diagnosed bf005fd7 version.
	const effects: string[] = [];
	const reservation = new UpdateReservation({
		freezeAdmissions() {
			effects.push("freeze");
			return () => effects.push("thaw");
		},
		async blockers() {
			effects.push("inspect");
			return [];
		},
	});
	const envelope = { globalUpdate: { operationId: "8817ea02-15c3-4931-8800-65d359f13001" } };
	const legacy = envelope as unknown as { operationId: string };
	await assert.rejects(reservation.prepare(legacy.operationId), /update_reservation_busy/);
	assert.deepEqual(effects, []);
	reservation.close();
});

for (const failure of [undefined, "prepare", "stop", "stopped", "replace", "start", "verify"]) {
	test(`legacy recovery is one-shot and keeps original records (${failure ?? "success"})`, async () => {
		const root = await mkdtemp(join(tmpdir(), "day-legacy-recovery-"));
		const original = '{"state":"entered","operationId":"original"}';
		await writeFile(join(root, "handoff-entered.json"), original, { mode: 0o600 });
		await writeFile(join(root, "window-journal"), "draft 日本語", { mode: 0o600 });
		const calls: string[] = [];
		const step = async (name: string) => {
			calls.push(name);
			if (failure === name) throw new Error(`lost ${name} reply`);
		};
		const host = {
			async prepare() {
				await step("prepare");
				return { operationId: "original", profile: "same", originalHash: "pinned" };
			},
			async stop() {
				await step("stop");
			},
			async stopped() {
				await step("stopped");
			},
			async replace() {
				await step("replace");
			},
			async start() {
				await step("start");
			},
			async verify() {
				await step("verify");
				return { runtime: "verified target", boot: "new" };
			},
		};
		try {
			if (failure) await assert.rejects(recoverOnce(root, host), new RegExp(`lost ${failure}`));
			else assert.equal((await recoverOnce(root, host)).state, "successor-verified");
			assert.deepEqual(
				calls,
				["prepare", "stop", "stopped", "replace", "start", "verify"].slice(
					0,
					failure ? ["prepare", "stop", "stopped", "replace", "start", "verify"].indexOf(failure) + 1 : undefined,
				),
			);
			assert.equal(await readFile(join(root, "handoff-entered.json"), "utf8"), original);
			assert.equal(await readFile(join(root, "window-journal"), "utf8"), "draft 日本語");
			const files = await readdir(root);
			assert.ok(!files.includes("handoff-complete.json"), "never fabricate original completion");
			assert.equal(files.includes("legacy-recovery-complete.json"), !failure);
			if (failure !== "prepare") {
				calls.length = 0;
				assert.equal((await recoverOnce(root, host)).state, "observed");
				assert.deepEqual(calls, [], "even missing start/release evidence never permits replay");
			}
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("concurrent recovery cannot stop twice", async () => {
	const root = await mkdtemp(join(tmpdir(), "day-legacy-recovery-"));
	let stops = 0;
	const host = {
		async prepare() {
			return { operationId: "same" };
		},
		async stop() {
			stops++;
		},
		async stopped() {},
		async replace() {},
		async start() {},
		async verify() {
			return { boot: "new" };
		},
	};
	try {
		await Promise.allSettled([recoverOnce(root, host), recoverOnce(root, host)]);
		assert.equal(stops, 1);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
