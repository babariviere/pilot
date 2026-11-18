// A chat Pilot started for the user, read only: a feedback triage or fix,
// or a chat started from New. It shows what the user and Pilot said, one
// quiet line per tool step, and whether the chat works, finished or failed.
// What the chat says is its own report, not a checked result. Opening,
// reading earlier rows and leaving send nothing; while the page is open,
// Pilot reads the chat again as it changes.
// A chat the service says can continue (stopped, or failed with a safe retry)
// offers Continue: one explicit press sends fixed words once.
import { cleanup, Keyboard, keymap, Scroll, signal, Text, View } from "nsh";
import { ChatTranscript } from "./ChatRows";
import { closeChat } from "./chatView";
import { queueLine } from "./codingQueue";
import { DiagnosisReply } from "./DiagnosisSettings";
import type { Day } from "./day";
import { LiveChanges } from "./LiveChanges";
import { RECOVERY_INPUT_BYTES, recoveryBytes, recoveryNote, setRecoveryNote } from "./recoveryDraft";
import type { ContinueResult, SessionChat, SessionChatMirror, SessionChatSource } from "./sessionChat";
import { Action, type MarkKind, MarkLine, Page, PageTitle, TextField } from "./ui";

/** Explicit recovery, never a new chat, clone, grant or allowance. */
function RecoveryRow(props: { mirror: SessionChatMirror; sessionId: string; restartOnly: boolean }) {
	const editing = signal(!!recoveryNote(props.sessionId));
	const sending = signal(false);
	const result = signal<ContinueResult | null>(props.mirror.chat()?.pendingRecovery ?? null);
	let submitted = result()?.submittedText ?? "";
	const unknown = () => result()?.status === "unknown";
	const text = () => recoveryNote(props.sessionId);
	const tooLarge = () => recoveryBytes(text()) > RECOVERY_INPUT_BYTES;
	const go = async (message: string) => {
		if (sending() || unknown()) return;
		Keyboard.dismiss();
		submitted = message;
		sending.set(true);
		try {
			const r = await props.mirror.source.recoverChat!(props.sessionId, message);
			submitted = r.submittedText ?? message;
			result.set(r);
			if (r.status === "accepted" && text() === submitted) setRecoveryNote(props.sessionId, "");
		} finally {
			sending.set(false);
		}
	};
	const check = async () => {
		const id = result()?.operationId ?? props.mirror.chat()?.pendingRecovery?.operationId;
		if (sending() || !id) return;
		sending.set(true);
		try {
			const r = await props.mirror.source.checkContinue(id);
			submitted = r.submittedText ?? submitted;
			result.set(r);
			if (r.status === "accepted" && text() === submitted) setRecoveryNote(props.sessionId, "");
		} finally {
			sending.set(false);
		}
	};
	return (
		<View class="gap-3">
			<Text class="text-sm text-muted-foreground">
				Retry continues in this chat with its existing access and remaining allowance.
			</Text>
			<If
				when={unknown()}
				else={
					<View class="flex-row gap-2">
						<Action
							label={sending() ? "Sending…" : "Retry"}
							testID="chat-retry"
							disabled={sending()}
							onPress={() => void go("")}
						/>
						<If when={!props.restartOnly}>
							<Action
								label="Correct follow-up…"
								testID="chat-correct"
								disabled={sending()}
								onPress={() => editing.set(true)}
							/>
						</If>
					</View>
				}
			>
				<Action
					label={sending() ? "Checking…" : "Check"}
					testID="chat-recovery-check"
					disabled={sending() || !(result()?.operationId ?? props.mirror.chat()?.pendingRecovery?.operationId)}
					onPress={() => void check()}
				/>
			</If>
			<If when={editing() && !unknown() && !props.restartOnly}>
				<View class="gap-2">
					<TextField
						testID="chat-recovery-note"
						accessibilityLabel="Corrected follow-up"
						multiline
						rows={3}
						value={text()}
						onChange={({ value }) => setRecoveryNote(props.sessionId, value)}
						disabled={sending()}
					/>
					<View class="flex-row gap-2">
						<Action
							label="Send follow-up"
							testID="chat-recovery-send"
							disabled={sending() || !text().trim() || tooLarge()}
							onPress={() => void go(text())}
						/>
						<Action
							label="Cancel"
							disabled={sending()}
							onPress={() => {
								Keyboard.dismiss();
								editing.set(false);
							}}
						/>
					</View>
					<If when={tooLarge()}>
						<Text class="text-xs text-muted-foreground">{`This follow-up is ${recoveryBytes(text())} bytes. The limit is ${RECOVERY_INPUT_BYTES}; shorten it before sending. Your draft is kept.`}</Text>
					</If>
				</View>
			</If>
			<If when={result()?.message}>
				<Text class="text-xs text-muted-foreground">{result()?.message ?? ""}</Text>
			</If>
		</View>
	);
}

/** The chat's state as one quiet line and its mark. */
function stateLine(chat: SessionChat | null): { mark: MarkKind; text: string } | null {
	if (chat?.archived) return { mark: "still", text: "Archived. This view is read-only." };
	switch (chat?.state) {
		case "working":
			return { mark: "moving", text: "Working." };
		case "question":
			return chat.questionSettled
				? { mark: "still", text: "This question no longer needs you. The plan settled it." }
				: { mark: "needs", text: "It asks a question and waits for an answer." };
		case "done":
			return { mark: "done", text: "Done. What it says below is its own report, not a checked result." };
		case "failed":
			return { mark: "failed", text: chat?.stateReason ? `Failed: ${chat.stateReason}` : "Failed." };
		case "stopped":
			return { mark: "still", text: chat?.stateReason ? `Stopped: ${chat.stateReason}` : "Stopped." };
		case "idle":
			return { mark: "still", text: chat?.queue ? queueLine(chat.queue) : chat?.stateReason || "Not working now." };
		default:
			return null;
	}
}

/** Continue for a stopped or failed chat, sent once. An unknown send is checked, never sent again. */
export function ContinueRow(props: {
	source: SessionChatSource;
	sessionId: string;
	failed?: boolean;
	/** After the service took it, so the page can read again. */
	onSent?: () => void;
}) {
	const sending = signal(false);
	const result = signal<ContinueResult | null>(null);
	const unknown = () => (result()?.status === "unknown" ? (result()?.operationId ?? null) : null);
	const go = async () => {
		sending.set(true);
		const r = await props.source.continueChat(props.sessionId);
		result.set(r);
		sending.set(false);
		if (r.status === "accepted") props.onSent?.();
	};
	const check = async (operationId: string) => {
		sending.set(true);
		const r = await props.source.checkContinue(operationId);
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
					{props.failed
						? "Asks it to try again from where it failed. Sent once."
						: "Asks it to pick up where it stopped, or to ask a lost question again. Sent once."}
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
export function ChatScreen(props: { day: Day; sessionId: string; onBackFromJump?: () => boolean }) {
	const mirror = props.day.chat as SessionChatMirror;
	void mirror.source.open(props.sessionId);
	cleanup(() => mirror.source.close(props.sessionId));
	keymap.bind(
		"escape",
		() => {
			if (!props.onBackFromJump?.()) closeChat();
		},
		{ when: "always" },
	);
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
							: mirror.source.recoverChat && chat()?.state === "failed" && !chat()?.archived
								? "Reading sends nothing. Recovery starts only when you choose it."
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
						<If when={mirror.source.readLiveChanges && chat()?.liveChangesKey}>
							{(key) => (
								<LiveChanges
									workspaceKey={key()}
									read={(workspaceKey) => mirror.source.readLiveChanges!(props.sessionId, workspaceKey)}
								/>
							)}
						</If>
						<If
							when={
								chat()?.canContinue &&
								!chat()?.specialist &&
								!chat()?.recoveryBlocked &&
								!chat()?.archived &&
								// Where Retry shows below, it is the one way to move a failed or stopped chat.
								!(
									mirror.source.recoverChat &&
									(chat()?.state === "failed" || chat()?.state === "stopped" || chat()?.pendingRecovery)
								)
							}
						>
							<ContinueRow
								source={mirror.source}
								sessionId={props.sessionId}
								failed={chat()?.state === "failed"}
							/>
						</If>
						<If
							when={
								(chat()?.state === "failed" || chat()?.state === "stopped" || chat()?.pendingRecovery) &&
								(!chat()?.recoveryBlocked || chat()?.pendingRecovery) &&
								!chat()?.specialist &&
								!chat()?.archived &&
								mirror.source.recoverChat
							}
						>
							<RecoveryRow
								mirror={mirror}
								sessionId={props.sessionId}
								restartOnly={chat()?.restartOnly === true}
							/>
						</If>
						<If when={chat()?.workspaceKept}>
							<View testID="chat-final-archive-wait" class="gap-1 border-t border-border pt-3">
								<Text class="text-sm text-foreground">Working copy kept</Text>
								<Text class="text-xs text-muted-foreground">
									Final archive is unavailable until required review and saved delivery can be verified. Your
									project folder is never deleted.
								</Text>
							</View>
						</If>
						<If when={chat()?.state === "failed" && chat()?.recoveryBlocked}>
							<Text class="text-sm text-muted-foreground">{chat()?.recoveryBlocked ?? ""}</Text>
						</If>
					</If>
				</View>
				<ChatTranscript
					id="chat"
					chat={chat()}
					readingWords="Reading this chat…"
					emptyWords="This chat has no messages yet."
					onEarlier={() => void mirror.source.earlier()}
					read={() => mirror.source.refresh()}
				/>
				<If when={chat()?.specialist && props.day.diagnosis}>
					<DiagnosisReply controls={props.day.diagnosis!} sessionId={props.sessionId} />
				</If>
			</Page>
		</Scroll>
	);
}
