// Isolated fixture of the production migration controls. No service or executor.
import { mount, signal } from "nsh";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";
import { MigrationControls } from "./updates/MigrationControls";
import type { MigrationIntent, MigrationView } from "./updates/migration";
import { PreviousMission } from "./updates/PreviousMission";

const mode = signal("lost");
const sends = signal(0);
const checks = signal(0);
const source = {
	async migration(r: MigrationIntent): Promise<MigrationView> {
		const base = {
			oldGoal: "Import archives safely",
			newGoal: "Import only reviewed formats",
			publicationId: "a".repeat(64),
			briefRevision: 3,
			agreement: "Read exact archive bytes. Do not deploy.",
			oldAgreement: "Keep original importer history.",
			oldTasks: [
				{ id: "old-task", number: 1, title: "Unfinished import tests", status: "blocked", sessionId: "old-chat" },
			],
			newTasks: [{ id: "new-task", number: 1, title: "Reviewed importer", status: "todo" }],
			keptChats: [{ id: "kept", title: "Importer work", unpublishedWork: true as const }],
			digest: "exact-preview",
			oldTitle: "Old export",
			newTitle: "Export safely",
			members: 2,
			linkedTickets: 1,
		};
		if (r.action === "read") return { ...base, state: "preview", message: "Published plan ready to review." };
		if (r.action === "history")
			return {
				...base,
				state: "history",
				message: "Saved old history.",
				decisions: [{ id: "d1", number: 1, text: "Preserve exact bytes" }],
			};
		if (r.action === "check") {
			checks.set(checks() + 1);
			return { ...base, state: "finished", message: "Migration finished. History and chats kept. No work started." };
		}
		if (mode() === "stale")
			return {
				...base,
				state: "rejected",
				message: "The preview changed before sending. Nothing was sent. Review again.",
			};
		sends.set(sends() + 1);
		throw new Error("Migration is not confirmed. Check status; do not finish again.");
	},
};
mount(() => (
	<WindowCanvas>
		<Block gap={4}>
			<Caption tone="faint">Mock data · Migration</Caption>
			<Buttons>
				<Button label="Make preview stale" onPress={() => mode.set("stale")} />
			</Buttons>
		</Block>
		<MigrationControls source={source} missionId="old" successorId="new" />
		<PreviousMission source={source} oldId="old" successorId="new" canReadChats />
		<Block>
			<Caption>{`Finish sends: ${sends()} · Checks: ${checks()}`}</Caption>
		</Block>
	</WindowCanvas>
));
