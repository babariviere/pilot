// A mission chat ended its turn with no result and no question: it may ask
// the user something in prose. This shows its last message, a reply field and
// the two ways on. Reply sends the user's own words; Continue sends Pilot's
// fixed words. Each is sent once, on a press. A lost answer is checked, never
// sent again. A read of the same chat keeps the field, its focus and its words.
import { signal, View } from "nsh";
import { keepField } from "./kept";
import type { ContinueResult, SessionChatSource } from "./sessionChat";
import { Button, Caption, Quote, TextField } from "./ui";

/** Most characters a reply carries, as the service checks: the same as a new chat's first message. */
const REPLY_CHARS = 12_000;

/** Unsent replies by chat, kept while the window lives, so a new read never changes a draft. */
const drafts = signal<Record<string, string>>({});

export function ChatWaits(props: {
	chat: SessionChatSource;
	sessionId: string;
	/** The chat's last message, word for word, when Pilot could read it. */
	says?: string | null;
	canContinue: boolean;
	/** The screen this card is on, for keeping the field's focus. */
	place: string;
	/** After the service took a reply or Continue, so the page can read again. */
	onSent?: () => void;
}) {
	const id = () => props.sessionId;
	const sending = signal(false);
	const result = signal<ContinueResult | null>(null);
	const text = () => drafts()[id()] ?? "";
	const setText = (value: string) => drafts.set({ ...drafts(), [id()]: value });
	const field = keepField(`chat-reply:${id()}`, () => props.place, text);
	const unknown = () => (result()?.status === "unknown" ? (result()?.operationId ?? null) : null);
	const sent = () => result()?.status === "accepted";
	const tooLong = () => [...text()].length > REPLY_CHARS;
	const run = async (send: () => Promise<ContinueResult>, words: string) => {
		if (sending()) return;
		sending.set(true);
		const r = await send();
		result.set(r);
		sending.set(false);
		if (r.status !== "accepted") return;
		if (words && text() === words) setText("");
		props.onSent?.();
	};
	const reply = () => {
		const words = text();
		if (!words.trim() || tooLong() || !props.chat.replyChat) return;
		void run(() => props.chat.replyChat!(id(), words), words);
	};
	const check = async (operationId: string) => {
		if (sending()) return;
		sending.set(true);
		result.set(await props.chat.checkContinue(operationId));
		sending.set(false);
	};
	return (
		<View testID={`chat-waits-${id()}`} class="gap-2">
			<If when={props.says}>
				<Caption tone="faint">Its last message</Caption>
				<Quote testID={`chat-says-${id()}`} text={props.says ?? ""} />
			</If>
			<If when={!sent() && !unknown()}>
				<TextField
					ref={field.ref}
					onFocus={field.focus}
					onSelectionChange={field.select}
					testID={`chat-reply-${id()}`}
					multiline
					compact
					value={text()}
					onChange={({ value }) => setText(value)}
					accessibilityLabel="Your reply to this chat. It reads your words as your answer and goes on."
				/>
				<If when={tooLong()}>
					<Caption tone="needs">{`A reply holds at most ${REPLY_CHARS} characters. Shorten it to send.`}</Caption>
				</If>
				<View class="flex-row gap-2">
					<Button
						small
						testID={`chat-reply-send-${id()}`}
						label={sending() ? "Sending…" : "Reply"}
						disabled={sending() || !text().trim() || tooLong() || !props.chat.replyChat}
						accessibilityLabel="Send your reply to this chat. Sent once."
						onPress={reply}
					/>
					<If when={props.canContinue}>
						<Button
							small
							testID={`chat-waits-continue-${id()}`}
							label="Continue"
							disabled={sending()}
							accessibilityLabel="Let this chat go on without your words. Pilot sends its fixed words once."
							onPress={() => void run(() => props.chat.continueChat(id()), "")}
						/>
					</If>
				</View>
			</If>
			<If when={unknown()}>
				{(op) => (
					<Button
						small
						testID={`chat-waits-check-${id()}`}
						label={sending() ? "Checking…" : "Check"}
						disabled={sending()}
						accessibilityLabel="Check whether it reached the chat. This reads Pilot's saved answer and sends nothing."
						onPress={() => void check(op())}
					/>
				)}
			</If>
			<If when={sent()}>
				<Caption testID={`chat-waits-sent-${id()}`} tone="faint">
					Sent. The chat goes on; this shows its next state when Pilot reads it again.
				</Caption>
			</If>
			<If when={result()?.message}>
				<Caption testID={`chat-waits-message-${id()}`}>{result()?.message ?? ""}</Caption>
			</If>
		</View>
	);
}
