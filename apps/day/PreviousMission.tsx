// Finished replacements keep their old agreement and work readable, not executable.
import { signal, Text, View } from "nsh";
import { openChat } from "./chatView";
import type { DayFeed } from "./feeds";
import type { MigrationView } from "./migration";
import { OpenChatAction } from "./OpenChatAction";
import { Action } from "./ui";

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
		<View class="gap-3">
			<View class="flex-row gap-2">
				<Action
					testID="previous-mission"
					label={shown() ? "Read history again" : "Read previous mission"}
					disabled={busy() || !props.source.migration}
					onPress={() => void read()}
				/>
				<If when={shown()}>
					<Action label="Hide history" onPress={() => shown.set(false)} />
				</If>
			</View>
			<If when={shown()}>
				<If when={note()}>
					<Text role="alert" class="text-sm text-muted-foreground">
						{note()}
					</Text>
				</If>
				<If when={history()}>
					<View testID="previous-mission-history" class="gap-3 border-t border-border pt-4">
						<Text role="header" class="text-xl font-semibold text-foreground">
							{history()?.oldTitle ?? "Previous mission"}
						</Text>
						<Text class="text-sm text-muted-foreground">
							Archived history. Reading does not restart old work or transfer permissions.
						</Text>
						<View selectable class="gap-3">
							<Text class="text-sm text-foreground">{history()?.oldGoal ?? ""}</Text>
							<Text class="text-sm text-muted-foreground">{history()?.oldAgreement ?? "No saved brief."}</Text>
						</View>
						<Each of={history()?.decisions ?? []} key={(d) => d.id}>
							{(d) => (
								<Text class="text-sm text-muted-foreground">{`D${d().number}: ${d().text}${d().replacement ? " (replaced)" : d().withdrawn ? " (withdrawn)" : ""}`}</Text>
							)}
						</Each>
						<Each of={history()?.oldTasks ?? []} key={(t) => t.id}>
							{(t) => (
								<View class="gap-1">
									<View class="flex-row items-start gap-3">
										<Text class="min-w-0 flex-1 text-sm text-foreground">{`#${t().number} ${t().title} (${t().status})`}</Text>
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
									</View>
									<Text class="text-sm text-muted-foreground">{t().body ?? ""}</Text>
								</View>
							)}
						</Each>
						<Each of={history()?.resources ?? []} key={(r) => r.id}>
							{(r) => (
								<View selectable class="gap-1">
									<Text class="text-sm text-foreground">{r().title ?? "Saved link"}</Text>
									<Text class="text-xs text-muted-foreground">{r().url}</Text>
								</View>
							)}
						</Each>
						<Text class="text-xs text-muted-foreground">
							Recent saved activity. Earlier events remain kept in the old mission.
						</Text>
						<Each of={history()?.events ?? []} key={(e) => e.id}>
							{(e) => <Text class="text-xs text-muted-foreground">{e().text}</Text>}
						</Each>
					</View>
				</If>
			</If>
		</View>
	);
}
