// Invented service data only. Exercises the production result page and its Review code page over a scripted
// result (deliveryDemo.ts) and a scripted private review, not a second screen.
import { keymap, mount, signal, Text, View } from "nsh";
import { DeliveryScreen } from "./DeliveryScreen";
import { ScriptedDelivery } from "./deliveryDemo";
import { mirrorDelivery } from "./deliveryFeed";
import { backNotes, type DeliveryPlace, deliveryRoute, openDelivery } from "./deliveryView";
import { openDay } from "./mockFeeds";
import {
	captureReviewDrafts,
	type ResultReviewEntry,
	type ResultReviewSource,
	restoreReviewDrafts,
	reviewDrafts,
} from "./resultReview";
import { Action } from "./ui";

const KEY = "task/mock-project/native/native-4";
const delivery = new ScriptedDelivery();
const day = { ...openDay(), delivery: mirrorDelivery(delivery) };
void delivery.readSaved();
openDelivery({ kind: "task", projectId: "mock-project", missionId: "native", taskId: "native-4" }, "#4 History slice");

const entries: ResultReviewEntry[] = [];
const revision = signal(0);
const saves = signal(0);
let lose = false;
let refuse = false,
	hold = false,
	release: (() => void) | undefined;
let pending: string[] = [];
const file = (path: string, before: string, after: string, n: number) => ({
	path,
	status: "modified",
	reason: "",
	before: { path, sha256: String(n).repeat(64), text: before },
	after: { path, sha256: String(n + 1).repeat(64), text: after },
});
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
			base: "8ac2d10e",
			head: "c94fa21b",
			status: "complete",
			omissions: [],
			files: [
				file(
					"src/export.ts",
					"async function exportReport() {\n  const path = await chooseSavePath();\n  clearDraft();\n  await writeReport(path);\n}\n",
					"async function exportReport() {\n  const path = await chooseSavePath();\n  if (!path) return;\n  await writeReport(path);\n  clearDraft();\n}\n",
					1,
				),
				file(
					"src/history/loader.ts",
					"export function load(page: number) {\n  return fetchPage(page);\n}\n",
					"export function load(page: number, before?: string) {\n  return fetchPage(page, before);\n}\n",
					3,
				),
				file(
					"src/history/loader.test.ts",
					"test('loads', () => load(1));\n",
					"test('loads', () => load(1));\ntest('loads older', () => load(2, 'm1'));\n",
					5,
				),
			],
		};
	},
	async save(shown, edit) {
		saves.set(saves() + 1);
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
mount(() => {
	// A background read of the same result, as a fresh copy, from a key so the focus stays where it is.
	keymap.bind(
		"mod+shift+u",
		() => {
			const shown = delivery.works.get(KEY);
			if (shown) delivery.works.set(KEY, { ...shown });
			delivery.publish();
		},
		{ when: "always" },
	);
	return (
		<View class="flex-1 bg-background">
			<View class="min-h-0 flex-1">
				<Each
					of={deliveryRoute() ? [{ place: deliveryRoute() as DeliveryPlace, at: revision() }] : []}
					key={(p) => `${p.place.key}:${p.at}`}
				>
					{(p) => <DeliveryScreen day={day} place={p().place} reviewSource={source} />}
				</Each>
				<If when={!deliveryRoute()}>
					<Text class="p-6 text-sm text-muted-foreground">Result closed</Text>
				</If>
			</View>
			<View class="flex-row flex-wrap gap-2 border-t border-border p-3">
				<Text class="text-xs text-muted-foreground">Mock data · Result review fixture</Text>
				<Text>{`Saves: ${saves()}`}</Text>
				<Text>{`Sends: ${delivery.counts().sends}`}</Text>
				<Text testID="sent-note">{`Note sent: [${delivery.counts().note}]`}</Text>
				<Text testID="revision-request">{backNotes()[KEY] ?? "No unsent Send back note"}</Text>
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
				<Action label="New result version" onPress={() => delivery.deliverAgain(KEY, "d")} />
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
	);
});
