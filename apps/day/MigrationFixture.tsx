// Isolated fixture of the production migration controls. No service or executor.
import { mount, signal, Text, View } from "nsh";
import { MigrationControls } from "./MigrationControls";
import type { MigrationIntent, MigrationView } from "./migration";
import { PreviousMission } from "./PreviousMission";
import { Action } from "./ui";

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
			oldTasks: [{ id: "old-task", number: 1, title: "Unfinished import tests", status: "blocked" }],
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
	<View class="flex-1 gap-5 bg-background p-8">
		<Text>Mock data · Migration</Text>
		<Action label="Make preview stale" onPress={() => mode.set("stale")} />
		<MigrationControls source={source} missionId="old" successorId="new" />
		<PreviousMission source={source} oldId="old" successorId="new" />
		<Text>{`Finish sends: ${sends()} · Checks: ${checks()}`}</Text>
	</View>
));
