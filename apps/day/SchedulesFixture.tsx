// Test-only schedule adapter. No host, storage, provider or execution.
import { mount, Text, View } from "nsh";
import { SchedulesScreen } from "./SchedulesScreen";
import { restoreSchedules, savedSchedules, scheduleDraft } from "./scheduleDraft";
import { scriptedSchedules } from "./schedulesDemo";
import { Action } from "./ui";

const { controls, snapshot, writes, checks, reads, many, lastTarget, unknown, operations } = scriptedSchedules();
mount(() => (
	<View class="flex-1 bg-background">
		<View class="flex-row flex-wrap gap-2 p-3">
			<Text>Mock data</Text>
			<Text>{`Writes: ${writes()}, checks: ${checks()}, reads: ${reads()}`}</Text>
			<Text>{`Saved target: ${lastTarget()}`}</Text>
			<Action
				label="Many choices"
				onPress={() => {
					many.set(true);
					snapshot.set({ ...snapshot()!, targetsMore: true });
				}}
			/>
			<Action label="Next unknown" onPress={() => unknown.set(true)} />
			<Action
				label="Sunday rules"
				onPress={() => {
					const base = snapshot()!.schedules[0]!;
					snapshot.set({
						...snapshot()!,
						schedules: [
							{
								...base,
								id: "sunday",
								trigger: "recurring",
								recurrence: { every: "week", time: "09:00", timeZone: "UTC", weekday: 7 },
							},
							{
								...base,
								id: "mon-sun",
								trigger: "recurring",
								recurrence: { every: "day", time: "10:00", timeZone: "UTC", weekdays: [1, 7] },
							},
						],
					});
				}}
			/>
			<Action label="Restore draft" onPress={() => restoreSchedules(savedSchedules())} />
			<Action
				label="Restore legacy draft"
				onPress={() => {
					const value = JSON.parse(savedSchedules());
					delete value.draft.draftId;
					restoreSchedules(JSON.stringify(value));
				}}
			/>
			<Action
				label="Accepted replacement"
				onPress={() => {
					const old = scheduleDraft();
					if (!old) return;
					operations.set([
						{
							operationId: "replacement",
							draftId: "different-draft",
							supersedesDraftId: old.draftId,
							state: "accepted",
							pending: false,
						},
					]);
					restoreSchedules(savedSchedules());
					snapshot.set({ ...snapshot()!, draftId: "new-window-draft" });
				}}
			/>
			<Action label="External change" onPress={() => snapshot.set({ ...snapshot()!, binding: "b".repeat(64) })} />
			<Action label="Clear draft" onPress={() => scheduleDraft.set(null)} />
		</View>
		<SchedulesScreen controls={controls} />
	</View>
));
