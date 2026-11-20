// Invented service data only. Exercises the production result page and its Review code page over a scripted
// result (deliveryDemo.ts) and a scripted private review, not a second screen.
import { keymap, mount, signal, View } from "nsh";
import { openDay } from "./app/testing/mockFeeds";
import { DeliveryScreen } from "./missions/delivery/DeliveryScreen";
import { ScriptedDelivery } from "./missions/delivery/deliveryDemo";
import { mirrorDelivery } from "./missions/delivery/deliveryFeed";
import { backNotes, type DeliveryPlace, deliveryRoute, openDelivery } from "./missions/delivery/deliveryView";
import {
	captureReviewDrafts,
	type ResultReviewEntry,
	type ResultReviewSource,
	restoreReviewDrafts,
	reviewDrafts,
} from "./missions/review/resultReview";
import { Block, Body, Button, Buttons, Caption, WindowCanvas } from "./ui";

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
		<WindowCanvas>
			<View class="min-h-0 flex-1">
				<Each
					of={deliveryRoute() ? [{ place: deliveryRoute() as DeliveryPlace, at: revision() }] : []}
					key={(p) => `${p.place.key}:${p.at}`}
				>
					{(p) => <DeliveryScreen day={day} place={p().place} reviewSource={source} />}
				</Each>
				<If when={!deliveryRoute()}>
					<Block>
						<Body tone="muted">Result closed</Body>
					</Block>
				</If>
			</View>
			<Block>
				<Buttons>
					<Caption>Mock data · Result review fixture</Caption>
					<Caption>{`Saves: ${saves()}`}</Caption>
					<Caption>{`Sends: ${delivery.counts().sends}`}</Caption>
					<Caption testID="sent-note">{`Note sent: [${delivery.counts().note}]`}</Caption>
					<Caption testID="revision-request">{backNotes()[KEY] ?? "No unsent Send back note"}</Caption>
					<Button
						label="Refuse next save"
						onPress={() => {
							refuse = true;
						}}
					/>
					<Button
						label="Delay next save reply"
						onPress={() => {
							hold = true;
						}}
					/>
					<Button
						label="Release saved reply"
						onPress={() => {
							release?.();
							release = undefined;
						}}
					/>
					<Button
						label="Lose next save reply"
						onPress={() => {
							lose = true;
						}}
					/>
					<Button label="Reopen review" onPress={() => revision.set(revision() + 1)} />
					<Button label="New result version" onPress={() => delivery.deliverAgain(KEY, "d")} />
					<Button
						label="Save and restore drafts"
						onPress={() => {
							const saved = captureReviewDrafts();
							reviewDrafts.set({});
							restoreReviewDrafts(saved);
							revision.set(revision() + 1);
						}}
					/>
				</Buttons>
			</Block>
		</WindowCanvas>
	);
});
