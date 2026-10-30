/** Disposable real jj/SQLite capture fixture for daemon tests and the hidden native journey. */
import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { NativeReviewReader } from "../native-review.ts";
import { ReviewSnapshotStore } from "../review-snapshots.ts";
import { WorkerReviewDelivery } from "../worker-review-delivery.ts";
import { fixture, jj } from "./shared-workspace.ts";

export async function retainedReviewFixture() {
	const f = fixture();
	const scope = { version: 1 as const, sessionId: "chat-B", missionId: "mission-A", taskIds: ["task-A"] };
	const w = await f.store.create(f.source, f.path("chat-B"), undefined, undefined, scope);
	const binding = (await f.store.ownership.sessionBinding(
		scope.sessionId,
		scope.missionId,
		w.shared!.repository,
		w.shared!.name,
	))!;
	const snapshots = new ReviewSnapshotStore(
		join(realpathSync(f.root), "retained", "reviews.sqlite"),
		f.store.ownership,
	);
	const delivery = new WorkerReviewDelivery(f.store.ownership, snapshots);
	let admitted = true;
	const admit = async () => {
		if (!admitted) throw new Error("Membership revoked");
		return binding;
	};
	const observe = () => f.store.observeOwnership(w.path, w.shared!);
	const reader = new NativeReviewReader(snapshots, f.store.ownership, admit);
	const commit = (text: string) => {
		writeFileSync(join(w.path, "a.txt"), text);
		jj(w.path, "commit", "-m", "Committed parser revision");
	};
	return {
		...f,
		w,
		binding,
		snapshots,
		delivery,
		reader,
		admit,
		observe,
		commit,
		revoke: () => {
			admitted = false;
		},
		run: () => delivery.checkpoint(binding.sessionId, admit, observe),
		dispose: async () => {
			await delivery.close();
			await snapshots.close();
			await f.store.close();
			f.close();
		},
	};
}

async function nativeFixture() {
	const f = await retainedReviewFixture();
	try {
		const root = "/api/missions/mission-A/review/chat-B";
		f.commit("retained lower\n");
		await f.run();
		const first = await f.reader.list(0);
		f.commit("retained upper\n");
		await f.run();
		const latest = await f.reader.list(0);
		const routes: Record<string, unknown> = {};
		for (const comparison of latest.comparisons) {
			const id = comparison.snapshotId;
			const snapshot = await f.reader.get(id);
			routes[`${root}/${id}`] = snapshot;
			routes[`${root}/${id}/patch`] = { snapshotId: id, patch: await f.reader.diff(id) };
			for (const e of snapshot.after.filter((e) => e.path === "a.txt")) {
				const ref = { snapshotId: id, side: "after" as const, path: e.path, sha256: e.sha256! };
				routes[`${root}/${id}/source?side=after&path=${e.path}&sha256=${e.sha256}`] = {
					snapshotId: id,
					text: await f.reader.source(id, ref),
				};
			}
		}
		console.log(JSON.stringify({ first, latest, routes }));
	} finally {
		await f.dispose();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await nativeFixture();
