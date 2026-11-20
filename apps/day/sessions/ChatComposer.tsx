// One draft per chat. Only Send writes; Check looks up the exact operation.
import { cleanup, effect, keymap, signal, untracked } from "nsh";
import { keepField } from "../app/kept";
import { AutoCheck } from "../sources/autoCheck";
import { Block, Button, Caption, Column, Composer, KeyCap, narrow, Spacer, TextField, WorkingLine } from "../ui";
import { recoveryNote, setRecoveryNote } from "./recovery/recoveryDraft";
import type { ContinueResult, SessionChatMirror } from "./sessionChat";

const REPLY_CHARS = 12_000;
type Attempt = { prior?: string; words: string; result?: ContinueResult; busy: boolean };
const attempts = signal<Record<string, Attempt | undefined>>({});

export function ChatComposer(props: { mirror: SessionChatMirror; sessionId: string; visible: boolean }) {
	const id = props.sessionId;
	const key = `chat_reply_${id}`;
	const draft = () => recoveryNote(key);
	const field = keepField(key, () => `chat:${id}`, draft);
	const source = props.mirror.source;
	const chat = () => {
		const current = props.mirror.chat();
		return current?.sessionId === id ? current : null;
	};
	const attempt = () => attempts()[id];
	const set = (update: Attempt) => attempts.update((all) => ({ ...all, [id]: update }));
	const pending = () => attempt()?.result?.status === "unknown";
	const busy = () => attempt()?.busy === true;
	const visible = () => props.visible || pending() || busy();
	const tooLong = () => [...draft()].length > REPLY_CHARS;
	const focused = signal(false);
	const canSend = () =>
		visible() && !!chat()?.canReply && !chat()?.reason && !busy() && !pending() && !!draft().trim() && !tooLong();

	const apply = (a: Attempt, result: ContinueResult) => {
		set({ ...a, result, busy: false });
		const submitted = result.submittedText ?? a.words;
		if (result.status === "accepted" && draft() === submitted) setRecoveryNote(key, "");
	};
	const check = async () => {
		const a = attempt();
		if (!a || a.busy || a.result?.status !== "unknown") return;
		set({ ...a, busy: true });
		let operationId = a.result.operationId;
		if (!operationId) {
			await source.refresh();
			const receipt = chat()?.reply;
			if (receipt?.operationId && receipt.operationId !== a.prior && receipt.submittedText === a.words) {
				if (receipt.status !== "unknown") return apply(a, receipt);
				operationId = receipt.operationId;
			}
		}
		if (!operationId) {
			set(a);
			return;
		}
		const result = await source.checkContinue(operationId);
		apply(
			a,
			result.status === "unknown"
				? { ...result, message: "Pilot could not confirm the message. It will not send it again." }
				: result,
		);
	};
	const send = async () => {
		if (!canSend() || !source.replyChat) return;
		const a = { prior: chat()?.reply?.operationId, words: draft(), busy: true };
		set(a);
		const result = await source.replyChat(id, a.words);
		apply(a, result);
	};
	const checkingNow = signal(false);
	const look = new AutoCheck(check, () => checkingNow.set(look.checking(id)));
	cleanup(() => look.close());
	effect(() => {
		look.watch(pending() ? [id] : []);
		checkingNow.set(look.checking(id));
	});
	effect(() => {
		const reply = chat()?.reply;
		if (reply?.status !== "unknown") return;
		untracked(() => {
			if (busy() || pending() || attempt()?.result?.operationId === reply.operationId) return;
			set({ words: reply.submittedText ?? "", result: reply, busy: false });
		});
	});
	keymap.bind(
		"mod+enter",
		() => {
			if (focused()) void send();
		},
		{ when: "always" },
	);
	return (
		<If when={visible()}>
			<Column centered>
				<Block gap={2}>
					<If when={chat()?.state === "working" && !!chat()?.canReply}>
						<WorkingLine text="Working… New messages wait until this turn ends." />
					</If>
					<Composer
						testID="chat-composer"
						field={
							<TextField
								variant="composer"
								multiline
								rows={2}
								testID="chat-message"
								accessibilityLabel="Message this chat"
								placeholder="Message this chat"
								ref={field.ref}
								value={draft()}
								onChange={({ value }) => setRecoveryNote(key, value)}
								onFocus={() => {
									field.focus();
									focused.set(true);
								}}
								onBlur={() => focused.set(false)}
								onSelectionChange={field.select}
							/>
						}
						bar={
							<>
								<Spacer />
								<If
									when={pending()}
									else={
										<>
											<If when={!narrow()}>
												<KeyCap label="⌘↩" />
											</If>
											<Button
												kind="primary"
												small
												testID="chat-send"
												label={busy() ? "Sending…" : "Send"}
												shortcut="⌘↩"
												disabled={!canSend()}
												onPress={() => void send()}
											/>
										</>
									}
								>
									<Button
										small
										testID="chat-message-check"
										label={busy() || checkingNow() ? "Checking…" : "Check"}
										disabled={busy() || checkingNow()}
										onPress={() => void check()}
									/>
								</If>
							</>
						}
					/>
					<If when={tooLong()}>
						<Caption tone="needs">Shorten your message to 12,000 characters before sending.</Caption>
					</If>
					<If when={attempt()?.result?.message}>
						<Caption testID="chat-message-status">{attempt()?.result?.message ?? ""}</Caption>
					</If>
				</Block>
			</Column>
		</If>
	);
}
