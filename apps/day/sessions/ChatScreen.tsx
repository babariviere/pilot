import { cleanup, Keyboard, keymap, Scroll, signal, View } from "nsh";
import type { Day } from "../app/day";
import { LiveChanges } from "../changes/LiveChanges";
import { LinkedFeedback } from "../feedback/LinkedFeedback";
import { DiagnosisReply } from "../settings/diagnostics/DiagnosisSettings";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	type MarkKind,
	Notice,
	Page,
	PageHead,
	Panel,
	Section,
	State,
	TextField,
} from "../ui";
import { ChatComposer } from "./ChatComposer";
import { ChatTranscript } from "./ChatRows";
import { chatRoute, closeChat, openChat } from "./chatView";
import { queueLine } from "./codingQueue";
import { RECOVERY_INPUT_BYTES, recoveryBytes, recoveryNote, setRecoveryNote } from "./recovery/recoveryDraft";
import {
	type ContinueResult,
	type SessionChat,
	type SessionChatMirror,
	type SessionChatSource,
	settle,
} from "./sessionChat";

/** The note is editable; scope and evidence remain in the original history. */
function FixHandoffRow(props: { mirror: SessionChatMirror; sessionId: string }) {
	let alive = true;
	cleanup(() => {
		alive = false;
	});
	const key = `handoff_${props.sessionId}`;
	const editing = signal(!!recoveryNote(key));
	const sending = signal(false);
	const result = signal<ContinueResult | null>(null);
	const chat = () => props.mirror.chat();
	const nativePending = () => (chat()?.pendingRecovery?.kind === "chat-handoff" ? chat()?.pendingRecovery : null);
	const pending = () =>
		result()?.status === "unknown" && !result()?.operationId
			? (nativePending() ?? result())
			: (result() ?? nativePending());
	const unknown = () => pending()?.status === "unknown";
	const note = () => recoveryNote(key);
	const accept = (r: ContinueResult, submitted: string) => {
		if (alive) result.set(r);
		if (r.status === "accepted") {
			if (note() === submitted) setRecoveryNote(key, "");
			if (r.sessionId && (alive || chatRoute()?.sessionId === props.sessionId)) openChat(r.sessionId, "Chat");
		}
	};
	const check = async () => {
		const id = pending()?.operationId;
		if (!id || sending()) return;
		sending.set(true);
		try {
			accept(await props.mirror.source.checkContinue(id), pending()?.submittedText ?? note());
		} finally {
			sending.set(false);
		}
	};
	const start = async () => {
		if (sending() || unknown()) return;
		Keyboard.dismiss();
		const submitted = note();
		sending.set(true);
		try {
			const source = props.mirror.source;
			accept(await settle(source, await source.handoffChat!(props.sessionId, submitted)), submitted);
		} finally {
			sending.set(false);
		}
	};
	// A reopened uncertain handoff looks up only its saved operation.
	if (unknown()) void check();
	return (
		<Section title="Continue in a linked chat">
			<Block gap={3}>
				<Caption>
					Pilot pauses the original writer before handing over its working copy. Its history and evidence stay
					available. This is the same fix, not a new allowance.
				</Caption>
				<If when={!!chat()?.fixHandoff}>
					<Caption testID="chat-handoff-context">{`${chat()?.fixHandoff?.projectName || chat()?.fixHandoff?.projectId} · ${chat()?.fixHandoff?.model}${chat()?.fixHandoff?.thinking ? ` (${chat()?.fixHandoff?.thinking})` : ""} · ${!chat()?.fixHandoff?.allowanceEnabled ? "Spending limits off" : chat()?.fixHandoff?.remainingMicros == null ? "Unlimited remaining" : `$${((chat()?.fixHandoff?.remainingMicros ?? 0) / 1_000_000).toFixed(2)} remaining`}`}</Caption>
				</If>
				<If when={!editing() && !unknown()}>
					<Buttons>
						<Button label="Prepare handoff…" testID="chat-handoff-prepare" onPress={() => editing.set(true)} />
					</Buttons>
				</If>
				<If when={editing() && !unknown()}>
					<View class="gap-2">
						<Caption>Original scope (kept unchanged)</Caption>
						<View selectable>
							<Caption testID="chat-handoff-scope">{chat()?.fixHandoff?.originalScope ?? ""}</Caption>
						</View>
						<TextField
							testID="chat-handoff-note"
							accessibilityLabel="Handoff note"
							multiline
							rows={3}
							value={note()}
							onChange={({ value }) => setRecoveryNote(key, value)}
							disabled={sending()}
						/>
						<Buttons>
							<Button
								label={sending() ? "Starting…" : "Start linked chat"}
								testID="chat-handoff-start"
								disabled={sending() || recoveryBytes(note()) > RECOVERY_INPUT_BYTES}
								onPress={() => void start()}
							/>
							<Button label="Cancel" disabled={sending()} onPress={() => editing.set(false)} />
						</Buttons>
						<If when={recoveryBytes(note()) > RECOVERY_INPUT_BYTES}>
							<Caption>{`This note is ${recoveryBytes(note())} bytes. The limit is ${RECOVERY_INPUT_BYTES}; shorten it before starting. Your draft is kept.`}</Caption>
						</If>
					</View>
				</If>
				<If when={unknown()}>
					<Buttons>
						<Button
							label={sending() ? "Checking…" : "Check"}
							testID="chat-handoff-check"
							disabled={sending()}
							onPress={() => void check()}
						/>
					</Buttons>
				</If>
				<If when={pending()?.message}>
					<Caption>{pending()?.message ?? ""}</Caption>
				</If>
			</Block>
		</Section>
	);
}

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
			const source = props.mirror.source;
			const r = await settle(source, await source.recoverChat!(props.sessionId, message));
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
			<Body tone="muted">Retry continues in this chat with its existing access and remaining allowance.</Body>
			<If
				when={unknown()}
				else={
					<Buttons>
						<Button
							label={sending() ? "Sending…" : "Retry"}
							testID="chat-retry"
							disabled={sending()}
							onPress={() => void go("")}
						/>
						<If when={!props.restartOnly}>
							<Button
								label="Correct follow-up…"
								testID="chat-correct"
								disabled={sending()}
								onPress={() => editing.set(true)}
							/>
						</If>
					</Buttons>
				}
			>
				<Buttons>
					<Button
						label={sending() ? "Checking…" : "Check"}
						testID="chat-recovery-check"
						disabled={sending() || !(result()?.operationId ?? props.mirror.chat()?.pendingRecovery?.operationId)}
						onPress={() => void check()}
					/>
				</Buttons>
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
					<Buttons>
						<Button
							label="Send follow-up"
							testID="chat-recovery-send"
							disabled={sending() || !text().trim() || tooLarge()}
							onPress={() => void go(text())}
						/>
						<Button
							label="Cancel"
							disabled={sending()}
							onPress={() => {
								Keyboard.dismiss();
								editing.set(false);
							}}
						/>
					</Buttons>
					<If when={tooLarge()}>
						<Caption>{`This follow-up is ${recoveryBytes(text())} bytes. The limit is ${RECOVERY_INPUT_BYTES}; shorten it before sending. Your draft is kept.`}</Caption>
					</If>
				</View>
			</If>
			<If when={result()?.message}>
				<Caption>{result()?.message ?? ""}</Caption>
			</If>
		</View>
	);
}

/** The chat's state as one quiet line and its mark. */
function stateLine(chat: SessionChat | null): { mark: MarkKind; text: string } | null {
	if (chat?.archived) return { mark: "paused", text: "Archived. This view is read-only." };
	switch (chat?.state) {
		case "working":
			return { mark: "working", text: "Working." };
		case "question":
			return chat.questionSettled
				? { mark: "done", text: "This question no longer needs you. The plan settled it." }
				: { mark: "needs", text: "It asks a question and waits for an answer." };
		case "done":
			return { mark: "done", text: "Done. What it says below is its own report, not a checked result." };
		case "failed":
			return { mark: "failed", text: chat?.stateReason ? `Failed: ${chat.stateReason}` : "Failed." };
		case "stopped":
			return { mark: "paused", text: chat?.stateReason ? `Stopped: ${chat.stateReason}` : "Stopped." };
		case "idle":
			return { mark: "paused", text: chat?.queue ? queueLine(chat.queue) : chat?.stateReason || "Not working now." };
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
		const r = await settle(props.source, await props.source.continueChat(props.sessionId));
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
			<Buttons>
				<If
					when={unknown()}
					else={
						<Button
							label={sending() ? "Sending…" : "Continue"}
							testID="chat-continue"
							disabled={sending()}
							accessibilityLabel="Ask this chat to continue. It asks its lost question again or picks up where it stopped. Sent once."
							onPress={() => void go()}
						/>
					}
				>
					{(id) => (
						<Button
							label={sending() ? "Checking…" : "Check"}
							testID="chat-continue-check"
							disabled={sending()}
							onPress={() => void check(id())}
						/>
					)}
				</If>
				<Caption tone="faint" grow>
					{props.failed
						? "Asks it to try again from where it failed. Sent once."
						: "Asks it to pick up where it stopped, or to ask a lost question again. Sent once."}
				</Caption>
			</Buttons>
			<If when={result()?.message}>
				<Caption testID="chat-continue-message">{result()?.message ?? ""}</Caption>
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
	const showComposer = () => !!mirror.source.replyChat && !!(chat()?.canReply || chat()?.reply?.status === "unknown");
	const canContinue = () =>
		chat()?.canContinue &&
		!chat()?.continuedTo &&
		!chat()?.specialist &&
		!chat()?.recoveryBlocked &&
		!chat()?.archived &&
		// Where Retry shows below, it is the one way to move a failed or stopped chat.
		!(
			mirror.source.recoverChat &&
			(chat()?.state === "failed" || chat()?.state === "stopped" || chat()?.pendingRecovery)
		);
	const canRecover = () =>
		(chat()?.state === "failed" || chat()?.state === "stopped" || chat()?.pendingRecovery) &&
		!chat()?.continuedTo &&
		chat()?.pendingRecovery?.kind !== "chat-handoff" &&
		(!chat()?.recoveryBlocked || chat()?.pendingRecovery) &&
		!chat()?.specialist &&
		!chat()?.archived &&
		mirror.source.recoverChat;
	return (
		<Page testID="chat" fill>
			<PageHead
				title={chat()?.title || "Chat"}
				text={
					chat()?.specialist
						? "Read-only specialist. Its findings are an assessment, not a verified cause. Reading sends nothing."
						: mirror.source.recoverChat && chat()?.state === "failed" && !chat()?.archived
							? "Reading sends nothing. Recovery starts only when you choose it."
							: showComposer()
								? undefined
								: state()
									? "This chat does not accept ordinary messages right now."
									: undefined
				}
				actions={
					<If when={state()}>
						<If when={chat()?.continuedTo}>
							<Button
								label="Open linked chat"
								testID="chat-successor"
								onPress={() => openChat(chat()!.continuedTo!, "Chat")}
							/>
						</If>
						<If when={chat()?.continuationOf}>
							<Button
								label="Original chat and evidence"
								testID="chat-predecessor"
								onPress={() => openChat(chat()!.continuationOf!, "Chat")}
							/>
						</If>
					</If>
				}
			>
				<If when={state()}>
					<If when={!chat()?.specialist && chat()?.sourcePath}>
						<View selectable>
							<Caption>{chat()?.sourceLabel ?? "Working copy"}</Caption>
							<Caption testID="chat-source-path" tone="faint">
								{chat()?.sourcePath ?? ""}
							</Caption>
							<Caption tone="faint">
								Use this location in your terminal. Local files may change while work runs.
							</Caption>
						</View>
					</If>
					<State testID="chat-state" kind={state()?.mark ?? "paused"} label={state()?.text ?? ""} plain />
				</If>
			</PageHead>
			<Panel
				testID="chat-panel"
				fill
				notice={
					<If when={state() && chat()?.state === "failed" && chat()?.recoveryBlocked}>
						<Notice placement="panel" text={chat()?.recoveryBlocked ?? ""} />
					</If>
				}
			>
				<Scroll class="min-h-0 flex-1" testID="chat-scroll">
					<Column centered>
						<If when={state() && (canContinue() || canRecover())}>
							<Block gap={3}>
								<If when={canContinue()}>
									<ContinueRow
										source={mirror.source}
										sessionId={props.sessionId}
										failed={chat()?.state === "failed"}
									/>
								</If>
								<If when={canRecover()}>
									<RecoveryRow
										mirror={mirror}
										sessionId={props.sessionId}
										restartOnly={chat()?.restartOnly === true}
									/>
								</If>
							</Block>
						</If>
						<If
							when={
								state() &&
								!!mirror.source.handoffChat &&
								!!chat()?.fixHandoff &&
								!chat()?.continuedTo &&
								!chat()?.archived
							}
						>
							<FixHandoffRow mirror={mirror} sessionId={props.sessionId} />
						</If>
						<If when={state() && mirror.source.readLiveChanges && chat()?.liveChangesKey}>
							{(key) => (
								<Block>
									<LiveChanges
										workspaceKey={key()}
										read={(workspaceKey) => mirror.source.readLiveChanges!(props.sessionId, workspaceKey)}
									/>
								</Block>
							)}
						</If>
						<If when={state() && chat()?.workspaceKept}>
							<Section testID="chat-final-archive-wait" title="Working copy kept">
								<Block>
									<Caption>
										Final archive is unavailable until required review and saved delivery can be verified.
										Your project folder is never deleted.
									</Caption>
								</Block>
							</Section>
						</If>
						<Section title="Chat">
							<Block gap={4}>
								<ChatTranscript
									id="chat"
									chat={chat()}
									readingWords="Reading this chat…"
									emptyWords="This chat has no messages yet."
									onEarlier={() => void mirror.source.earlier()}
									read={() => mirror.source.refresh()}
								/>
							</Block>
						</Section>
						<If
							when={
								!!props.day.feedback &&
								!!chat()?.projectId &&
								chat()?.state === "done" &&
								!chat()?.continuedTo &&
								!chat()?.specialist
							}
						>
							<LinkedFeedback
								mirror={props.day.feedback!}
								scope={{ kind: "chat", id: props.sessionId, projectId: chat()!.projectId! }}
							/>
						</If>
						<If when={chat()?.specialist && props.day.diagnosis}>
							<Block>
								<DiagnosisReply controls={props.day.diagnosis!} sessionId={props.sessionId} />
							</Block>
						</If>
					</Column>
				</Scroll>
				<ChatComposer mirror={mirror} sessionId={props.sessionId} visible={showComposer()} />
			</Panel>
		</Page>
	);
}
