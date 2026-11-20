// Host attention, using the same calm rows as the mission and Today. Reports
// cannot create or clear these. Every row offers the action that moves it: a
// failed or stopped chat the service says can continue offers Continue (one
// fixed follow-up, sent once on a press), and a failed chat offers Dismiss,
// which takes it off this list and sends nothing to the chat. A lost answer is
// checked, never sent again. A chat that ended its turn with no result and no
// question shows its last message with Reply and Continue without reply
// (ChatWaits.tsx). On a mission page a row with a chat links it, read only.
// Nothing here retries on its own.
import { signal, View } from "nsh";
import type { Problem } from "pilot-day/native";
import { ChatWaits } from "./ChatWaits";
import { openDelivery } from "./deliveryView";
import { OpenChatAction } from "./OpenChatAction";
import type { ContinueResult, SessionChatSource } from "./sessionChat";
import { Button, Caption, EmptyLine, Row, RowDetail, Rows, Section } from "./ui";
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
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={!unknown() && !done()}>
					<If when={props.p.canContinue}>
						<Button
							small
							testID={`problem-continue-${props.p.id}`}
							label={sending() ? "Sending…" : "Continue"}
							disabled={sending()}
							accessibilityLabel={`Continue ${props.p.title}: ask its chat to try again from where it stopped. Sent once.`}
							onPress={() => void run(() => props.chat.continueChat(id()))}
						/>
					</If>
					<If when={props.p.canDismiss && props.chat.dismissChat}>
						<Button
							small
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
						<Button
							small
							testID={`problem-check-${props.p.id}`}
							label={sending() ? "Checking…" : "Check"}
							disabled={sending()}
							onPress={() => void run(() => props.chat.checkContinue(op()))}
						/>
					)}
				</If>
			</View>
			<If when={done()}>
				<Caption testID={`problem-sent-${props.p.id}`} tone="faint">
					Sent. This row goes when Pilot reads the chat again.
				</Caption>
			</If>
			<If when={result()?.message}>
				<Caption testID={`problem-message-${props.p.id}`}>{result()?.message ?? ""}</Caption>
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
	/** Opens a row's chat, read only. Without it, rows offer no chat link. */
	openChat?: (sessionId: string) => void;
	actionProject?: string | null;
	project?: (id: string) => string;
	unreadProjects?: string[];
}) {
	const acts = (p: Problem) =>
		!!props.chat && (props.actionProject === undefined || props.actionProject === p.projectId) && !!p.sessionId;
	return (
		<If when={props.rows.length > 0 || !props.known || !!props.unreadProjects?.length}>
			<Section
				testID="problems"
				title="Work that needs attention"
				count={props.known && !props.unreadProjects?.length ? props.rows.length : undefined}
			>
				<If when={!props.known}>
					<EmptyLine text="Pilot cannot read all unresolved problems. This is not the same as having none." />
				</If>
				<Each of={props.unreadProjects ?? []} key={String}>
					{(name) => <EmptyLine text={`Could not check all blockers in ${name()}.`} />}
				</Each>
				<If when={props.earlier}>
					<EmptyLine text="Earlier read. These problems may have changed." />
				</If>
				<Rows>
					<Each of={props.rows} key={(p) => p.id}>
						{(p) => (
							<Row
								testID={`problem-${p().id}`}
								mark="needs"
								title={p().title}
								meta={[props.project?.(p().projectId) ?? "", p().cause ?? ""].filter(Boolean).join(" · ")}
								wrap
								selectable
								detail={
									<RowDetail>
										<Caption>{`Next: ${p().nextStep}`}</Caption>
										<If when={acts(p()) && p().canReply}>
											<ChatWaits
												chat={props.chat as SessionChatSource}
												sessionId={p().sessionId as string}
												says={p().says}
												canContinue={p().canContinue}
												place={props.inMission ? `mission/${p().missionId ?? ""}` : "today"}
											/>
										</If>
										<If when={acts(p()) && !p().canReply && (p().canContinue || p().canDismiss)}>
											<ChatActions p={p()} chat={props.chat as SessionChatSource} />
										</If>
										<View class="flex-row flex-wrap gap-2">
											<If when={props.openChat && p().sessionId}>
												<OpenChatAction
													label="Open agent chat"
													testID={`problem-chat-${p().id}`}
													accessibilityLabel={`Open agent chat for ${p().title}, read only. Opening it sends nothing.`}
													onPress={() => props.openChat?.(p().sessionId as string)}
												/>
											</If>
											<If when={p().taskId || (p().sessionId && !p().missionId)}>
												<Button
													small
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
																: {
																		kind: "chat",
																		projectId: p().projectId,
																		sessionId: p().sessionId as string,
																	},
															p().title,
															true,
														)
													}
												/>
											</If>
											<If when={!props.inMission && p().missionId}>
												<Button
													small
													label="Open mission"
													accessibilityLabel={`Open the mission for ${p().title}`}
													onPress={() => openMission(p().missionId as string)}
												/>
											</If>
										</View>
									</RowDetail>
								}
							/>
						)}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}
