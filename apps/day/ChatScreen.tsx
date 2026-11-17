// A chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. It shows what the user and Pilot said, one
// quiet line per tool step, and whether the chat works, finished or failed.
// What the chat says is its own report, not a checked result. Opening,
// reading earlier rows and leaving send nothing; while the page is open,
// Pilot reads the chat again as it changes.
// A stopped chat offers Continue: one explicit press sends fixed words once.
import { cleanup, keymap, Scroll, signal, Text, View } from "nsh";
import { ChatTranscript } from "./ChatRows";
import { closeChat } from "./chatView";
import { DiagnosisReply } from "./DiagnosisSettings";
import type { Day } from "./day";
import type { ContinueResult, SessionChat, SessionChatMirror } from "./sessionChat";
import { Action, type MarkKind, MarkLine, Page, PageTitle } from "./ui";

/** The chat's state as one quiet line and its mark. */
function stateLine(chat: SessionChat | null): { mark: MarkKind; text: string } | null {
	switch (chat?.state) {
		case "working":
			return { mark: "moving", text: "Working." };
		case "question":
			return { mark: "needs", text: "It asks a question and waits for an answer." };
		case "done":
			return { mark: "done", text: "Done. What it says below is its own report, not a checked result." };
		case "failed":
			return { mark: "failed", text: chat?.stateReason ? `Failed: ${chat.stateReason}` : "Failed." };
		case "stopped":
			return { mark: "still", text: chat?.stateReason ? `Stopped: ${chat.stateReason}` : "Stopped." };
		case "idle":
			return { mark: "still", text: "Not working now." };
		default:
			return null;
	}
}

/** Continue for a stopped chat, sent once. An unknown send is checked, never sent again. */
function ContinueRow(props: { mirror: SessionChatMirror; sessionId: string }) {
	const sending = signal(false);
	const result = signal<ContinueResult | null>(null);
	const unknown = () => (result()?.status === "unknown" ? (result()?.operationId ?? null) : null);
	const go = async () => {
		sending.set(true);
		result.set(await props.mirror.source.continueChat(props.sessionId));
		sending.set(false);
	};
	const check = async (operationId: string) => {
		sending.set(true);
		const r = await props.mirror.source.checkContinue(operationId);
		result.set(r.status === "accepted" ? null : r);
		sending.set(false);
	};
	return (
		<View class="gap-1.5">
			<View class="flex-row flex-wrap items-center gap-3">
				<If
					when={unknown()}
					else={
						<Action
							variant="outline"
							label={sending() ? "Sending…" : "Continue"}
							testID="chat-continue"
							disabled={sending()}
							accessibilityLabel="Ask this chat to continue. It asks its lost question again or picks up where it stopped. Sent once."
							onPress={() => void go()}
						/>
					}
				>
					{(id) => (
						<Action
							label={sending() ? "Checking…" : "Check"}
							testID="chat-continue-check"
							disabled={sending()}
							onPress={() => void check(id())}
						/>
					)}
				</If>
				<Text class="flex-1 text-xs text-faint">
					Asks it to pick up where it stopped, or to ask a lost question again. Sent once.
				</Text>
			</View>
			<If when={result()?.message}>
				<Text testID="chat-continue-message" class="text-xs text-muted-foreground">
					{result()?.message ?? ""}
				</Text>
			</If>
		</View>
	);
}

/** The chat page. Opening it only reads. */
export function ChatScreen(props: { day: Day; sessionId: string }) {
	const mirror = props.day.chat as SessionChatMirror;
	void mirror.source.open(props.sessionId);
	cleanup(() => mirror.source.close(props.sessionId));
	keymap.bind("escape", closeChat, { when: "always" });
	const chat = () => {
		const c = mirror.chat();
		return c?.sessionId === props.sessionId ? c : null;
	};
	const state = () => stateLine(chat());
	return (
		<Scroll class="flex-1 bg-background">
			<Page testID="chat" gap={8}>
				<View class="gap-3">
					<PageTitle title={chat()?.title || "Chat"} />
					<Text class="text-sm text-muted-foreground">
						{chat()?.specialist
							? "Read-only specialist. Its findings are an assessment, not a verified cause. Reading sends nothing."
							: "Read only. Reading it sends nothing and changes nothing."}
					</Text>
					<If when={state()}>
						<If when={!chat()?.specialist && chat()?.sourcePath}>
							<View selectable class="gap-1">
								<Text class="text-xs text-muted-foreground">{chat()?.sourceLabel ?? "Working copy"}</Text>
								<Text testID="chat-source-path" class="text-xs text-faint">
									{chat()?.sourcePath ?? ""}
								</Text>
								<Text class="text-xs text-faint">
									Use this location in your terminal. Local files may change while work runs.
								</Text>
							</View>
						</If>
						<MarkLine testID="chat-state" kind={state()?.mark ?? "still"}>
							<Text class="text-sm text-foreground">{state()?.text ?? ""}</Text>
						</MarkLine>
						<If when={chat()?.state === "stopped" && !chat()?.specialist}>
							<ContinueRow mirror={mirror} sessionId={props.sessionId} />
						</If>
					</If>
				</View>
				<ChatTranscript
					id="chat"
					chat={chat()}
					readingWords="Reading this chat…"
					emptyWords="This chat has no messages yet."
					onEarlier={() => void mirror.source.earlier()}
				/>
				<If when={chat()?.specialist && props.day.diagnosis}>
					<DiagnosisReply controls={props.day.diagnosis!} sessionId={props.sessionId} />
				</If>
			</Page>
		</Scroll>
	);
}
