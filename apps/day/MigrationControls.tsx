// The old mission stays unchanged until an exact published replacement is reviewed.
import { signal, Text, View } from "nsh";
import type { DayFeed } from "./feeds";
import type { MigrationIntent, MigrationView } from "./migration";
import { Action, QuietPanel } from "./ui";

export function MigrationControls(props: {
	source: Pick<DayFeed, "migration">;
	missionId: string;
	successorId: string;
}) {
	const preview = signal<MigrationView | null>(null);
	const busy = signal(false);
	const note = signal("");
	const unknown = signal(false);
	const details = signal(false);
	async function run(action: MigrationIntent["action"]) {
		if (busy() || !props.source.migration || (action === "finish" && (!preview() || unknown()))) return;
		busy.set(true);
		note.set("");
		try {
			const next = await props.source.migration({
				missionId: props.missionId,
				successorId: props.successorId,
				action,
				...(action === "finish" ? { digest: preview()?.digest } : {}),
			});
			preview.set(next);
			unknown.set(next.state === "unknown");
			note.set(next.message);
		} catch (error) {
			if (action !== "read") unknown.set(true);
			note.set(error instanceof Error ? error.message : "Migration is unavailable. Nothing will be sent again.");
		} finally {
			busy.set(false);
		}
	}
	return (
		<If when={props.source.migration}>
			<View testID="migration-controls" class="gap-3">
				<If when={!preview() && !unknown()}>
					<Action
						label="Review migration"
						testID="migration-review"
						disabled={busy()}
						onPress={() => void run("read")}
					/>
				</If>
				<If when={preview()?.state === "preview" && !unknown()}>
					<QuietPanel class="gap-3">
						<Text class="text-sm font-medium text-foreground">{`Finish replacing “${preview()?.oldTitle}” with “${preview()?.newTitle}”?`}</Text>
						<Text class="text-sm text-muted-foreground">
							Archive the old mission and finish its replacement link. Keep its history, chats and unpublished
							work. No agents start, move or inherit permissions.
						</Text>
						<If when={preview()?.publicationId}>
							<Text class="text-sm text-foreground">{`Published replacement: brief revision ${preview()?.briefRevision}, plan ${preview()?.publicationId?.slice(0, 12)}.`}</Text>
							<Text class="text-sm text-muted-foreground">{preview()?.newGoal ?? ""}</Text>
							<Each of={preview()?.newTasks ?? []} key={(t) => t.id}>
								{(t) => (
									<Text class="text-sm text-foreground">{`#${t().number} ${t().title} (${t().status})`}</Text>
								)}
							</Each>
							<Action
								label={details() ? "Hide agreement and kept work" : "Show agreement and kept work"}
								onPress={() => details.set(!details())}
							/>
							<If when={details()}>
								<View selectable class="gap-3">
									<Text role="header" class="text-sm font-medium text-foreground">
										Published agreement
									</Text>
									<Text class="text-sm text-muted-foreground">{preview()?.agreement ?? ""}</Text>
									<Text role="header" class="text-sm font-medium text-foreground">
										Old agreement, kept as history
									</Text>
									<Text class="text-sm text-muted-foreground">{preview()?.oldGoal ?? ""}</Text>
									<Text class="text-sm text-muted-foreground">
										{preview()?.oldAgreement ?? "No saved old brief."}
									</Text>
									<Each of={preview()?.oldTasks ?? []} key={(t) => t.id}>
										{(t) => (
											<Text class="text-sm text-muted-foreground">{`Kept #${t().number}: ${t().title} (${t().status})`}</Text>
										)}
									</Each>
								</View>
							</If>
						</If>
						<Each of={preview()?.keptChats ?? []} key={(c) => c.id}>
							{(c) => (
								<Text class="text-sm text-muted-foreground">{`Keep chat “${c().title}”: ${c().unpublishedWork ? "unpublished work reported" : "workspace state not established"}.`}</Text>
							)}
						</Each>
						<If when={(preview()?.members ?? 0) > 0}>
							<Text class="text-sm text-muted-foreground">
								Safely pause the old mission's work on its overview before finishing. A running or uncertain old
								worker blocks migration.
							</Text>
						</If>
						<If when={(preview()?.linkedTickets ?? 0) > 0}>
							<Text class="text-sm text-muted-foreground">
								Managed Linear tickets stay with the old mission. Ticket transfer is not available here.
							</Text>
						</If>
						<View class="flex-row gap-2">
							<Action
								variant="primary"
								label="Finish migration"
								testID="migration-finish"
								disabled={busy()}
								onPress={() => void run("finish")}
							/>
							<Action label="Cancel" disabled={busy()} onPress={() => preview.set(null)} />
						</View>
					</QuietPanel>
				</If>
				<If when={unknown()}>
					<Action
						label="Check status"
						testID="migration-check"
						disabled={busy()}
						onPress={() => void run("check")}
					/>
				</If>
				<If when={preview()?.state === "rejected" && !unknown()}>
					<Action label="Review again" disabled={busy()} onPress={() => void run("read")} />
				</If>
				<If when={note()}>
					<Text testID="migration-note" class="text-sm text-muted-foreground">
						{note()}
					</Text>
				</If>
			</View>
		</If>
	);
}
