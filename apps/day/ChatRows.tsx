// A chat's rows, read only: the user's messages, Pilot's words, and one
// quiet line per tool step or request. The planning chat and the chats
// Pilot started (ChatScreen.tsx) show the same way. Show earlier reads the
// rows before what shows; it sends nothing.
import { View } from "nsh";
import type { ChatRow } from "pilot-day/native";
import { keepRead, staleLine } from "./freshness";
import { Body, Bubble, Caption, Event, Link, Notice, Reply, Steps } from "./ui";

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
	/** Reads the chat's newest rows again: Pilot does so on its own after a failed read. */
	read?: () => Promise<unknown>;
}) {
	const chat = () => props.chat;
	const reads = keepRead(
		() => props.read?.() ?? Promise.resolve(),
		() => !!props.read && !!chat()?.reason,
		() => (chat()?.rows.length ?? 0) > 0,
	);
	// With rows shown, a failed read says nothing until the shared old-data rule does.
	const reason = () => {
		const c = chat();
		if (!c?.reason) return "";
		if (c.rows.length === 0) return c.reason;
		return reads.stale() ? staleLine(reads.readAt() ?? 0) : "";
	};
	return (
		<View class="gap-3">
			<If when={chat()?.more}>
				<Link
					label={chat()?.reading ? "Reading…" : "Show earlier"}
					testID={`${props.id}-earlier`}
					disabled={chat()?.reading === true}
					onPress={props.onEarlier}
				/>
			</If>
			<If when={reason()}>
				<Notice testID={`${props.id}-off`} text={reason()} />
			</If>
			<If when={!chat() || (chat()?.reading && chat()?.rows.length === 0)}>
				<Body tone="muted">{props.readingWords}</Body>
			</If>
			<If when={chat() && !chat()?.reading && !chat()?.reason && chat()?.rows.length === 0}>
				<Body tone="muted">{props.emptyWords}</Body>
			</If>
			<Each of={chat()?.rows ?? []} key={(r) => r.key}>
				{(r) => <ChatLine row={r()} testID={`${props.id}-${r().key}`} />}
			</Each>
		</View>
	);
}

/**
 * One row: the user's words in a bubble, Pilot's reply, or one quiet line for a request or a tool step. A step that
 * runs now is darker; a failed one gets the red mark.
 */
export function ChatLine(props: { row: ChatRow; testID: string }) {
	return (
		<View testID={props.testID}>
			<If when={props.row.role === "you"}>
				<Bubble text={props.row.text} />
			</If>
			<If when={props.row.role === "pilot"}>
				<Reply>
					<Body>{props.row.text}</Body>
				</Reply>
			</If>
			<If when={props.row.role === "request"}>
				<Event text={props.row.text} />
			</If>
			<If when={props.row.role === "step"}>
				<If
					when={props.row.running && !props.row.failed}
					else={
						<Event
							text={props.row.failed ? `${props.row.text} · Failed` : props.row.text}
							failed={props.row.failed}
						/>
					}
				>
					<Steps steps={[{ id: props.row.key, text: props.row.text, running: true }]} />
				</If>
			</If>
			<If when={props.row.shortened}>
				<Caption tone="faint">Pilot shows the start of this long message only.</Caption>
			</If>
		</View>
	);
}
