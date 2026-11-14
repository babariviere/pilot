// Read-only host attention, using the same calm rows as the mission and
// Today. Reports cannot create or clear these. No retry/permission intents.
import { Text, View } from "nsh";
import type { Problem } from "pilot-day/native";
import { openDelivery } from "./deliveryView";
import { Action, SectionTitle } from "./ui";
import { openMission } from "./view";

export function Problems(props: { rows: Problem[]; known: boolean; inMission?: boolean; earlier?: boolean }) {
	return (
		<If when={props.rows.length > 0 || !props.known}>
			<View testID="problems" class="gap-1">
				<SectionTitle title="Needs a look" count={props.rows.length} />
				<If when={!props.known}>
					<Text class="text-sm text-muted-foreground">
						Pilot cannot read all unresolved problems. This is not the same as having none.
					</Text>
				</If>
				<If when={props.earlier}>
					<Text class="text-xs text-faint">Earlier read. These problems may have changed.</Text>
				</If>
				<Each of={props.rows} key={(p) => p.id}>
					{(p) => (
						<View testID={`problem-${p().id}`} selectable class="gap-2 border-t border-border py-3">
							<Text class="text-sm font-medium text-foreground">{p().title}</Text>
							<If when={p().cause}>
								<Text class="text-sm text-muted-foreground">{p().cause as string}</Text>
							</If>
							<Text class="text-sm text-muted-foreground">{`Next: ${p().nextStep}`}</Text>
							<If when={p().taskId || (p().sessionId && !p().missionId)}>
								<View class="flex-row">
									<Action
										label="See the work"
										accessibilityLabel={`See the work of ${p().title}`}
										onPress={() =>
											openDelivery(
												p().taskId
													? {
															kind: "task",
															projectId: p().projectId,
															missionId: p().missionId as string,
															taskId: p().taskId as string,
														}
													: { kind: "chat", projectId: p().projectId, sessionId: p().sessionId as string },
												p().title,
												true,
											)
										}
									/>
								</View>
							</If>
							<If when={!props.inMission && p().missionId}>
								<View class="flex-row">
									<Action
										label="Open mission"
										accessibilityLabel={`Open the mission for ${p().title}`}
										onPress={() => openMission(p().missionId as string)}
									/>
								</View>
							</If>
						</View>
					)}
				</Each>
			</View>
		</If>
	);
}
