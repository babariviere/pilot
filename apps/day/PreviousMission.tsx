// Finished replacements keep their old agreement and work readable, not executable.
import { signal, View } from "nsh";
import { openChat } from "./chatView";
import type { DayFeed } from "./feeds";
import type { MigrationView } from "./migration";
import { OpenChatAction } from "./OpenChatAction";
import { Block, Body, Button, Buttons, Caption, Heading, Notice, Row, Rows } from "./ui";

export function PreviousMission(props: {
	source: Pick<DayFeed, "migration">;
	oldId: string;
	successorId: string;
	canReadChats?: boolean;
}) {
	const history = signal<MigrationView | null>(null);
	const note = signal("");
	const busy = signal(false);
	const shown = signal(false);
	async function read() {
		if (busy() || !props.source.migration) return;
		shown.set(true);
		busy.set(true);
		note.set("");
		try {
			history.set(
				await props.source.migration({ missionId: props.oldId, successorId: props.successorId, action: "history" }),
			);
		} catch {
			note.set("The previous mission's history could not be read. Nothing changed. Read again.");
		} finally {
			busy.set(false);
		}
	}
	return (
		<View>
			<Block>
				<Buttons>
					<Button
						testID="previous-mission"
						label={shown() ? "Read history again" : "Read previous mission"}
						disabled={busy() || !props.source.migration}
						onPress={() => void read()}
					/>
					<If when={shown()}>
						<Button label="Hide history" onPress={() => shown.set(false)} />
					</If>
				</Buttons>
			</Block>
			<If when={shown()}>
				<If when={note()}>
					<Notice placement="section" kind="failed" role="alert" text={note()} />
				</If>
				<If when={history()}>
					<View testID="previous-mission-history">
						<Block gap={3}>
							<Heading role="header">{history()?.oldTitle ?? "Previous mission"}</Heading>
							<Caption>Archived history. Reading does not restart old work or transfer permissions.</Caption>
							<View selectable class="gap-3">
								<Body>{history()?.oldGoal ?? ""}</Body>
								<Body tone="muted">{history()?.oldAgreement ?? "No saved brief."}</Body>
								<Each of={history()?.decisions ?? []} key={(d) => d.id}>
									{(d) => (
										<Body tone="muted">{`D${d().number}: ${d().text}${d().replacement ? " (replaced)" : d().withdrawn ? " (withdrawn)" : ""}`}</Body>
									)}
								</Each>
							</View>
						</Block>
						<Rows>
							<Each of={history()?.oldTasks ?? []} key={(t) => t.id}>
								{(t) => (
									<Row
										title={`#${t().number} ${t().title} (${t().status})`}
										meta={t().body ?? ""}
										wrap
										trailing={
											<If when={t().sessionId && props.canReadChats}>
												<OpenChatAction
													label="Open saved chat"
													testID={`previous-chat-${t().id}`}
													accessibilityLabel={`Open saved chat for #${t().number} ${t().title}, read only. This starts nothing.`}
													onPress={() =>
														openChat(t().sessionId ?? "", history()?.oldTitle ?? "Previous mission")
													}
												/>
											</If>
										}
									/>
								)}
							</Each>
							<Each of={history()?.resources ?? []} key={(r) => r.id}>
								{(r) => <Row title={r().title ?? "Saved link"} meta={r().url} selectable />}
							</Each>
						</Rows>
						<Block gap={1}>
							<Caption>Recent saved activity. Earlier events remain kept in the old mission.</Caption>
							<Each of={history()?.events ?? []} key={(e) => e.id}>
								{(e) => <Caption tone="faint">{e().text}</Caption>}
							</Each>
						</Block>
					</View>
				</If>
			</If>
		</View>
	);
}
