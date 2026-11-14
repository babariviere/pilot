// A chat's rows, read only: the user's messages, Pilot's words, and one
// quiet line per tool step or request. The planning chat and the chats
// Pilot started (ChatScreen.tsx) show the same way. Show earlier reads the
// rows before what shows; it sends nothing.
import { Text, View } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { Action, Mark } from "./ui";

/** What the transcript needs of a chat as read. */
export type ChatRead = { rows: ChatRow[]; more: boolean; reading: boolean; reason: string };

/**
 * A chat's rows with Show earlier, a quiet reason when a read failed, and a
 * line while it reads. `id` prefixes the test IDs, such as "plan-chat".
 */
export function ChatTranscript(props: {
	id: string;
	chat: ChatRead | null;
	/** Said while the first read is on its way. */
	readingWords: string;
	/** Said when the chat has no rows. */
	emptyWords: string;
	onEarlier: () => void;
}) {
	const chat = () => props.chat;
	return (
		<View class="gap-3">
			<If when={chat()?.more}>
				<View class="flex-row">
					<Action
						label={chat()?.reading ? "Reading…" : "Show earlier"}
						testID={`${props.id}-earlier`}
						disabled={chat()?.reading === true}
						onPress={props.onEarlier}
					/>
				</View>
			</If>
			<If when={chat()?.reason}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-1.5">
						<Mark kind="unknown" />
					</View>
					<Text testID={`${props.id}-off`} class="flex-1 text-sm text-muted-foreground">
						{chat()?.reason ?? ""}
					</Text>
				</View>
			</If>
			<If when={!chat() || (chat()?.reading && chat()?.rows.length === 0)}>
				<Text class="text-sm text-muted-foreground">{props.readingWords}</Text>
			</If>
			<If when={chat() && !chat()?.reading && !chat()?.reason && chat()?.rows.length === 0}>
				<Text class="text-sm text-muted-foreground">{props.emptyWords}</Text>
			</If>
			<Each of={chat()?.rows ?? []} key={(r) => r.key}>
				{(r) => <ChatLine row={r()} testID={`${props.id}-${r().key}`} />}
			</Each>
		</View>
	);
}

/** One row: the user's words on the right, Pilot's text, or a quiet step. */
export function ChatLine(props: { row: ChatRow; testID: string }) {
	return (
		<View testID={props.testID}>
			<If when={props.row.role === "you"}>
				<View selectable class="self-end rounded-xl bg-muted px-3 py-2">
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "pilot"}>
				<View selectable>
					<Text class="text-sm leading-relaxed text-foreground">{props.row.text}</Text>
				</View>
			</If>
			<If when={props.row.role === "request"}>
				<Text class="text-xs text-faint">{props.row.text}</Text>
			</If>
			<If when={props.row.role === "step"}>
				<View class="flex-row items-center gap-2">
					<If when={props.row.running || props.row.failed}>
						<Mark kind={props.row.failed ? "failed" : "moving"} />
					</If>
					<Text class="text-xs text-muted-foreground">
						{props.row.failed ? `${props.row.text} · Failed` : props.row.text}
					</Text>
				</View>
			</If>
			<If when={props.row.shortened}>
				<Text class="text-xs text-faint">Pilot shows the start of this long message only.</Text>
			</If>
		</View>
	);
}
