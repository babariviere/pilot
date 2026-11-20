// The old mission stays unchanged until an exact published replacement is reviewed.
// Review shows the replacement as a Question; Finish is its one commit.
import { signal, View } from "nsh";
import type { DayFeed } from "../sources/feeds";
import { Block, Body, Button, Buttons, Caption, Disclosure, Heading, Question } from "../ui";
import type { MigrationIntent, MigrationView } from "./migration";

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
			<View testID="migration-controls">
				<If when={preview()?.state === "preview" && !unknown()}>
					<Question
						title={`Finish replacing “${preview()?.oldTitle}” with “${preview()?.newTitle}”?`}
						foot={
							<>
								<Button
									kind="primary"
									label="Finish migration"
									testID="migration-finish"
									disabled={busy()}
									onPress={() => void run("finish")}
								/>
								<Button label="Cancel" disabled={busy()} onPress={() => preview.set(null)} />
							</>
						}
					>
						<Body tone="muted" measure>
							Archive the old mission and finish its replacement link. Keep its history, chats and unpublished
							work. No agents start, move or inherit permissions.
						</Body>
						<If when={preview()?.publicationId}>
							<View selectable class="gap-1">
								<Body>{`Published replacement: brief revision ${preview()?.briefRevision}, plan ${preview()?.publicationId?.slice(0, 12)}.`}</Body>
								<Body tone="muted">{preview()?.newGoal ?? ""}</Body>
								<Each of={preview()?.newTasks ?? []} key={(t) => t.id}>
									{(t) => <Body>{`#${t().number} ${t().title} (${t().status})`}</Body>}
								</Each>
							</View>
							<Disclosure
								label={details() ? "Hide agreement and kept work" : "Show agreement and kept work"}
								open={details()}
								onToggle={() => details.set(!details())}
							>
								<View selectable class="gap-3">
									<Heading role="header">Published agreement</Heading>
									<Body tone="muted">{preview()?.agreement ?? ""}</Body>
									<Heading role="header">Old agreement, kept as history</Heading>
									<Body tone="muted">{preview()?.oldGoal ?? ""}</Body>
									<Body tone="muted">{preview()?.oldAgreement ?? "No saved old brief."}</Body>
									<Each of={preview()?.oldTasks ?? []} key={(t) => t.id}>
										{(t) => <Body tone="muted">{`Kept #${t().number}: ${t().title} (${t().status})`}</Body>}
									</Each>
								</View>
							</Disclosure>
						</If>
						<Each of={preview()?.keptChats ?? []} key={(c) => c.id}>
							{(c) => (
								<Body tone="muted">{`Keep chat “${c().title}”: ${c().unpublishedWork ? "unpublished work reported" : "workspace state not established"}.`}</Body>
							)}
						</Each>
						<If when={(preview()?.members ?? 0) > 0}>
							<Body tone="muted">
								Safely pause the old mission's work on its overview before finishing. A running or uncertain old
								worker blocks migration.
							</Body>
						</If>
						<If when={(preview()?.linkedTickets ?? 0) > 0}>
							<Body tone="muted">
								Managed Linear tickets stay with the old mission. Ticket transfer is not available here.
							</Body>
						</If>
					</Question>
				</If>
				<Block>
					<Buttons>
						<If when={!preview() && !unknown()}>
							<Button
								label="Review migration"
								testID="migration-review"
								disabled={busy()}
								onPress={() => void run("read")}
							/>
						</If>
						<If when={unknown()}>
							<Button
								label="Check status"
								testID="migration-check"
								disabled={busy()}
								onPress={() => void run("check")}
							/>
						</If>
						<If when={preview()?.state === "rejected" && !unknown()}>
							<Button label="Review again" disabled={busy()} onPress={() => void run("read")} />
						</If>
					</Buttons>
					<If when={note()}>
						<Caption testID="migration-note">{note()}</Caption>
					</If>
				</Block>
			</View>
		</If>
	);
}
