// Host attention, using the same calm rows as the mission and Today. Reports
// cannot create or clear these. Every row offers the action that moves it: a
// failed or stopped chat the service says can continue offers Continue (one
// fixed follow-up, sent once on a press), and a failed chat offers Dismiss,
// which takes it off this list and sends nothing to the chat. A lost answer is
// checked, never sent again. A chat that ended its turn with no result and no
// question shows its last message with Reply and Continue (ChatWaits.tsx).
// Nothing here retries on its own.
import { signal, Text, View } from "nsh";
import type { Problem } from "pilot-day/native";
import { ChatWaits } from "./ChatWaits";
import { openDelivery } from "./deliveryView";
import type { ContinueResult, SessionChatSource } from "./sessionChat";
import { Action, SectionTitle } from "./ui";
import { openMission } from "./view";

/** Continue and Dismiss for one row's chat. Each is sent once; an unknown answer is checked only. */
function ChatActions(props: { p: Problem; chat: SessionChatSource }) {
	const sending = signal(false);
	const result = signal<ContinueResult | null>(null);
	// The operation an unknown answer left, for Check only.
	const unknown = () => (result()?.status === "unknown" ? (result()?.operationId ?? null) : null);
	const run = async (send: () => Promise<ContinueResult>) => {
		if (sending()) return;
		sending.set(true);
		result.set(await send());
		sending.set(false);
	};
	const id = () => props.p.sessionId as string;
	const done = () => result()?.status === "accepted";
	return (
		<View class="gap-1">
			<View class="-ml-3 flex-row flex-wrap items-center gap-2">
				<If when={!unknown() && !done()}>
					<If when={props.p.canContinue}>
						<Action
							variant="outline"
							testID={`problem-continue-${props.p.id}`}
							label={sending() ? "Sending…" : "Continue"}
							disabled={sending()}
							accessibilityLabel={`Continue ${props.p.title}: ask its chat to try again from where it stopped. Sent once.`}
							onPress={() => void run(() => props.chat.continueChat(id()))}
						/>
					</If>
					<If when={props.p.canDismiss && props.chat.dismissChat}>
						<Action
							testID={`problem-dismiss-${props.p.id}`}
							label="Dismiss"
							disabled={sending()}
							accessibilityLabel={`Dismiss ${props.p.title} from this list. Nothing is sent to its chat.`}
							onPress={() => void run(() => props.chat.dismissChat!(id()))}
						/>
					</If>
				</If>
				<If when={unknown()}>
					{(op) => (
						<Action
							testID={`problem-check-${props.p.id}`}
							label={sending() ? "Checking…" : "Check"}
							disabled={sending()}
							onPress={() => void run(() => props.chat.checkContinue(op()))}
						/>
					)}
				</If>
			</View>
			<If when={done()}>
				<Text testID={`problem-sent-${props.p.id}`} class="text-xs text-faint">
					Sent. This row goes when Pilot reads the chat again.
				</Text>
			</If>
			<If when={result()?.message}>
				<Text testID={`problem-message-${props.p.id}`} class="text-xs text-muted-foreground">
					{result()?.message ?? ""}
				</Text>
			</If>
		</View>
	);
}

export function Problems(props: {
	rows: Problem[];
	known: boolean;
	inMission?: boolean;
	earlier?: boolean;
	/** Sends Continue and Dismiss. Without it, rows offer only their way to the work. */
	chat?: SessionChatSource;
}) {
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
							<If when={props.chat && p().sessionId && p().canReply}>
								<ChatWaits
									chat={props.chat as SessionChatSource}
									sessionId={p().sessionId as string}
									says={p().says}
									canContinue={p().canContinue}
									place={props.inMission ? `mission/${p().missionId ?? ""}` : "today"}
								/>
							</If>
							<If when={props.chat && p().sessionId && !p().canReply && (p().canContinue || p().canDismiss)}>
								<ChatActions p={p()} chat={props.chat as SessionChatSource} />
							</If>
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
