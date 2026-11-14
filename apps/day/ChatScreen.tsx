// A chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. It shows what the user and Pilot said, one
// quiet line per tool step, and whether the chat works, finished or failed.
// What the chat says is its own report, not a checked result. Opening,
// reading earlier rows and leaving send nothing; while the page is open,
// Pilot reads the chat again as it changes.
import { cleanup, keymap, Scroll, Text, View } from "nsh";
import { ChatTranscript } from "./ChatRows";
import { closeChat } from "./chatView";
import type { Day } from "./day";
import type { SessionChat, SessionChatMirror } from "./sessionChat";
import { Mark, type MarkKind } from "./ui";

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
			<View testID="chat" class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<View class="gap-3">
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						{chat()?.title || "Chat"}
					</Text>
					<Text class="text-sm text-muted-foreground">
						Read only. Reading it sends nothing and changes nothing.
					</Text>
					<If when={state()}>
						<View testID="chat-state" class="flex-row items-start gap-2.5">
							<View class="pt-1.5">
								<Mark kind={state()?.mark ?? "still"} />
							</View>
							<Text class="flex-1 text-sm text-foreground">{state()?.text ?? ""}</Text>
						</View>
					</If>
				</View>
				<ChatTranscript
					id="chat"
					chat={chat()}
					readingWords="Reading this chat…"
					emptyWords="This chat has no messages yet."
					onEarlier={() => void mirror.source.earlier()}
				/>
			</View>
		</Scroll>
	);
}
