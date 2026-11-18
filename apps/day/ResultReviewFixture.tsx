// Invented service data only. Exercises the production review panel, not a second screen.
import { mount, Scroll, signal, Text, View } from "nsh";
import type { DeliveredWork } from "./deliveryContract";
import { backNotes } from "./deliveryView";
import { ResultReviewPanel } from "./ResultReviewPanel";
import {
	captureReviewDrafts,
	type ResultReviewEntry,
	type ResultReviewSource,
	restoreReviewDrafts,
	reviewDrafts,
} from "./resultReview";
import { Action, Page } from "./ui";

const work = signal<DeliveredWork>({
	version: 1,
	subject: { kind: "task", projectId: "project", missionId: "mission", taskId: "task" },
	deliveryId: "a".repeat(64),
	targetId: "target",
	ownerSessionId: "worker",
	pullRequests: [],
	artifacts: [],
	production: "not_tracked",
	verification: null,
	verificationCurrent: false,
	verificationReceiptState: "unknown",
	verificationRevision: 0,
	pendingOperationId: null,
});
const entries: ResultReviewEntry[] = [];
const revision = signal(0);
const sends = signal(0);
const laterReturns = signal(0);
let lose = false;
let refuse = false,
	hold = false,
	release: (() => void) | undefined;
let pending: string[] = [];
const source: ResultReviewSource = {
	async read(shown) {
		return {
			data: {
				subject: shown.subject,
				deliveryId: shown.deliveryId!,
				revision: entries.length,
				entries: [...entries],
				snapshots: ["snapshot"],
			},
			pending: [...pending],
		};
	},
	async diff() {
		return {
			snapshotId: "snapshot",
			base: "8ac2d10",
			head: "c94fa21",
			status: "complete",
			omissions: [],
			files: [
				{
					path: "src/export.ts",
					status: "modified",
					reason: "",
					before: {
						path: "src/export.ts",
						sha256: "b".repeat(64),
						text: "async function exportReport() {\n  const path = await chooseSavePath();\n  clearDraft();\n  await writeReport(path);\n}\n",
					},
					after: {
						path: "src/export.ts",
						sha256: "c".repeat(64),
						text: "async function exportReport() {\n  const path = await chooseSavePath();\n  if (!path) return;\n  await writeReport(path);\n  clearDraft();\n}\n",
					},
				},
			],
		};
	},
	async save(shown, edit) {
		sends.set(sends() + 1);
		if (refuse) {
			refuse = false;
			const receipt = {
				...edit,
				operationId: crypto.randomUUID(),
				subject: shown.subject,
				state: "rejected" as const,
				reason: "A newer save exists",
			};
			return { state: "rejected", operationId: receipt.operationId, receipt };
		}
		const entry = {
			...edit,
			operationId: crypto.randomUUID(),
			subject: shown.subject,
			revision: entries.length + 1,
			ownerSessionId: shown.ownerSessionId,
			at: 1,
		};
		entries.push(entry);
		if (hold) {
			hold = false;
			await new Promise<void>((resolve) => {
				release = resolve;
			});
		}
		if (lose) {
			lose = false;
			pending = [entry.operationId];
			return { state: "unknown", operationId: entry.operationId, receipt: null };
		}
		return { state: "saved", operationId: entry.operationId, receipt: entry };
	},
	async check(id) {
		const receipt = entries.find((e) => e.operationId === id) ?? null;
		if (receipt) pending = [];
		return { state: receipt ? "saved" : "unknown", operationId: id, receipt };
	},
};
mount(() => (
	<View class="flex-1 bg-background">
		<Scroll testID="review-scroll" class="flex-1 min-h-0">
			<Page gap={8}>
				<Text class="text-xs text-muted-foreground">Mock data · Result review fixture</Text>
				<Text class="text-2xl font-semibold text-foreground">Keep the export draft after cancel</Text>
				<Text class="text-sm text-muted-foreground">
					Checks: cancel and exact-byte export passed. Risks: Linux dialog unverified.
				</Text>
				<Each of={[`${work().deliveryId}:${revision()}`]} key={(id) => id}>
					{() => (
						<ResultReviewPanel
							source={source}
							work={work()}
							fresh={true}
							onLater={() => laterReturns.set(laterReturns() + 1)}
						/>
					)}
				</Each>
				<Text testID="revision-request">{backNotes()["task/project/mission/task"] ?? "No revision request"}</Text>
			</Page>
		</Scroll>
		<View class="flex-row flex-wrap gap-2 p-3 border-t border-border">
			<Text>{`Saves: ${sends()}`}</Text>
			<Text>{`Later returns: ${laterReturns()}`}</Text>
			<Action
				label="Refuse next save"
				onPress={() => {
					refuse = true;
				}}
			/>
			<Action
				label="Delay next save reply"
				onPress={() => {
					hold = true;
				}}
			/>
			<Action
				label="Release saved reply"
				onPress={() => {
					release?.();
					release = undefined;
				}}
			/>
			<Action
				label="Lose next save reply"
				onPress={() => {
					lose = true;
				}}
			/>
			<Action label="Reopen review" onPress={() => revision.set(revision() + 1)} />
			<Action label="New result version" onPress={() => work.set({ ...work(), deliveryId: "d".repeat(64) })} />
			<Action
				label="Save and restore drafts"
				onPress={() => {
					const saved = captureReviewDrafts();
					reviewDrafts.set({});
					restoreReviewDrafts(saved);
					revision.set(revision() + 1);
				}}
			/>
		</View>
	</View>
));
