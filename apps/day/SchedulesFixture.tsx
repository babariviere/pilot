// Test-only schedule adapter. No host, storage, provider or execution.
import { mount } from "nsh";
import { SchedulesScreen } from "./SchedulesScreen";
import { restoreSchedules, savedSchedules, scheduleDraft } from "./scheduleDraft";
import { scriptedSchedules } from "./schedulesDemo";
import { Block, Button, Buttons, Caption, WindowCanvas } from "./ui";

const { controls, snapshot, writes, checks, reads, many, lastTarget, unknown, operations } = scriptedSchedules();
mount(() => (
	<WindowCanvas>
		<Block>
			<Buttons>
				<Caption tone="faint">Mock data</Caption>
				<Caption>{`Writes: ${writes()}, checks: ${checks()}, reads: ${reads()}`}</Caption>
				<Caption>{`Saved target: ${lastTarget()}`}</Caption>
				<Button
					small
					label="Many choices"
					onPress={() => {
						many.set(true);
						snapshot.set({ ...snapshot()!, targetsMore: true });
					}}
				/>
				<Button small label="Next unknown" onPress={() => unknown.set(true)} />
				<Button
					small
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
				<Button small label="Restore draft" onPress={() => restoreSchedules(savedSchedules())} />
				<Button
					small
					label="Restore legacy draft"
					onPress={() => {
						const value = JSON.parse(savedSchedules());
						delete value.draft.draftId;
						restoreSchedules(JSON.stringify(value));
					}}
				/>
				<Button
					small
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
				<Button
					small
					label="External change"
					onPress={() => snapshot.set({ ...snapshot()!, binding: "b".repeat(64) })}
				/>
				<Button small label="Clear draft" onPress={() => scheduleDraft.set(null)} />
			</Buttons>
		</Block>
		<SchedulesScreen controls={controls} />
	</WindowCanvas>
));
