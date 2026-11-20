// Focused threads with a mission's coordinator: one subject each. The
// mission overview lists them; a thread's page shows what it links, the
// thread's own conversation (your messages and the replies saved as the
// thread's, read from their ORIGINAL entries, never matched by guess) and
// the reply box. Show activity adds the original history with other work
// below, keeping the conversation, the draft and the scroll.
// Talking here never starts, approves, resumes, archives or stops work. A
// message is sent only to an active, unheld planning coordinator; when it
// cannot take one, the page says why and nothing is sent. A sent message is
// not the coordinator's answer. A lost answer stays Unknown: Check only
// reads it, and the words stay until the service accepted them.
import {
	cleanup,
	effect,
	type JSX,
	keymap,
	Scroll,
	type ScrollRef,
	type Signal,
	signal,
	untracked,
	View,
	type ViewRef,
} from "nsh";
// LIBRARY GAP: see ConfirmDialog below; the interrupt confirmation needs the base Dialog.
import { Dialog } from "nsh/base";
import type { Day } from "./day";
import { openDelivery } from "./deliveryView";
import { keepRead, staleLine } from "./freshness";
import { keepField, keepScroll, restoreScroll, scrollOf } from "./kept";
import {
	type Catalog,
	type HistoryEntry,
	historyKey,
	MAX_TEXT_BYTES,
	type MissionThreads,
	messageTime,
	type Original,
	type ReplyState,
	type ThreadOp,
	type ThreadReference,
	type ThreadsMirror,
	type ThreadWrite,
	type Topic,
	type TopicMessage,
	titleOf,
	utf8Bytes,
	type WaitingMessage,
	type WriteResult,
} from "./threadFeed";
import {
	activityOpen,
	clearDraft,
	closeThread,
	draftKey,
	linkOpen,
	naming,
	openThread,
	originalKey,
	originalOpen,
	setDraft,
	setMessage,
	showDiscarded,
	stepsOpen,
	threadDrafts,
	threadMessages,
} from "./threadView";
import {
	Block,
	Body,
	BodyStrong,
	Bubble,
	Button,
	Buttons,
	Caption,
	Column,
	Composer,
	Disclosure,
	EmptyLine,
	Event,
	glide,
	KeyHints,
	Link,
	type MarkKind,
	Notice,
	Num,
	Page,
	PageHead,
	Panel,
	Quote,
	Reply,
	Row,
	RowGroup,
	Rows,
	Section,
	Spacer,
	State,
	Steps,
	TextField,
	Title,
} from "./ui";

const STATUS: Record<Topic["disposition"], { word: string; mark: MarkKind }> = {
	open: { word: "Open", mark: "new" },
	later: { word: "Later", mark: "paused" },
	discarded: { word: "Discarded", mark: "done" },
	resolved: { word: "Resolved", mark: "done" },
};

const unsettled = (o: ThreadOp) => o.state === "unknown" || o.state === "checking";

/** One write, with its message kept by `key`. Accepted words are no longer a draft. */
async function send(
	mirror: ThreadsMirror,
	missionId: string,
	key: string,
	write: ThreadWrite,
	clearOnAccept: string | null,
): Promise<WriteResult | null> {
	const m = mirror.mission(missionId);
	const source = m.snapshot?.source;
	if (!source || m.availability !== "live") {
		setMessage(key, "Read this mission's threads again first. Nothing was sent.");
		return null;
	}
	setMessage(key, "");
	const r = await mirror.source.write(missionId, source, write);
	// Only an accepted write ends a draft. Refused, stale, rejected and Unknown keep every word.
	if (r.status === "accepted" && clearOnAccept !== null) clearDraft(clearOnAccept);
	setMessage(key, r.message);
	return r;
}

/** Writes on this mission whose result Pilot does not know, with Check. They block other writes. */
function Unsettled(props: { mirror: ThreadsMirror; missionId: string; ops: ThreadOp[]; testID: string }) {
	const key = () => draftKey(props.missionId, "check");
	// Pilot checks unconfirmed writes by itself. A message it proves the service took is no
	// longer an unsent draft: clear those exact words, as a manual Check does.
	const unsure = new Set<string>();
	effect(() => {
		for (const o of props.mirror.mission(props.missionId).ops) {
			if (o.state === "unknown" || o.state === "checking") unsure.add(o.operationId);
			else if (unsure.delete(o.operationId) && o.state === "accepted" && o.purpose === "thread-send") {
				const words = draftKey(props.missionId, o.topicId);
				if (untracked(() => threadDrafts()[words]) === o.text) clearDraft(words);
			}
		}
	});
	const words = (o: ThreadOp) => {
		if (o.purpose === "thread-send") return `Message not confirmed: “${o.text ?? ""}”`;
		if (o.purpose === "thread-create") return "A new thread is not confirmed.";
		if (o.purpose === "thread-reference") return "A link is not confirmed.";
		return "A Later, Discard or Reopen is not confirmed.";
	};
	return (
		<If when={props.ops.length > 0}>
			<View testID={props.testID} class="gap-2">
				<Each of={props.ops} key={(o) => o.operationId}>
					{(o) => (
						<Notice
							text={words(o())}
							detail={
								o().state === "checking"
									? "Checking that it arrived…"
									: "Pilot could not confirm it yet. It will not send it again. Check only reads."
							}
							action={
								/* Pilot checks by itself first; the button is the fallback after its tries. */
								<If when={o().state !== "checking"}>
									<Button
										small
										label="Check"
										icon="refresh"
										testID={`thread-check-${o().operationId}`}
										accessibilityLabel="Check what happened to it. This reads only and sends nothing again."
										onPress={async () => {
											const op = o();
											const r = await props.mirror.source.check(props.missionId, op.operationId);
											// Words the service proved it took are no longer unsent.
											const words = draftKey(props.missionId, op.topicId);
											if (
												r.status === "accepted" &&
												op.purpose === "thread-send" &&
												threadDrafts()[words] === op.text
											)
												clearDraft(words);
											setMessage(key(), r.message);
										}}
									/>
								</If>
							}
						/>
					)}
				</Each>
				<If when={threadMessages()[key()]}>
					<Caption testID={`${props.testID}-message`}>{threadMessages()[key()] ?? ""}</Caption>
				</If>
			</View>
		</If>
	);
}

/** What the read could not show, never as "no threads". */
function Unreadable(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	// Pilot reads again on its own; Try now shows after 3 failed tries.
	const reads = keepRead(
		() => props.mirror.source.read(props.missionId),
		() => props.m.availability === "unavailable",
		() => false,
	);
	return (
		<Notice
			testID="threads-off"
			text={`${props.m.reason} Threads are not shown; this is not the same as having none.`}
			action={
				<If when={reads.warn()}>
					<Link
						label="Try now"
						icon="refresh"
						testID="threads-read"
						accessibilityLabel="Read this mission's threads again. This sends nothing."
						onPress={() => void reads.now()}
					/>
				</If>
			}
		/>
	);
}

/**
 * A new thread starts with its first message: one field and Send. The thread's title is the message's first
 * sentence (titleOf). Pilot starts the thread, then sends the message in it. When the coordinator cannot take a
 * message, or the send does not go through, the thread opens with the words kept in its reply box.
 */
function NewThread(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	const key = () => draftKey(props.missionId, "");
	const text = () => threadDrafts()[key()] ?? "";
	const open = () => naming()[props.missionId] === true;
	const field = keepField(`thread-title-${props.missionId}`, () => `mission/${props.missionId}`, text);
	const tooLong = () => utf8Bytes(text()) > MAX_TEXT_BYTES;
	const blocked = () =>
		props.m.availability !== "live" || props.m.writing || props.m.ops.some(unsettled) || !text().trim() || tooLong();
	const start = async () => {
		if (blocked()) return;
		const words = text();
		const r = await send(
			props.mirror,
			props.missionId,
			key(),
			{ purpose: "thread-create", title: titleOf(words) },
			null,
		);
		if (r?.status !== "accepted" || !r.topicId) return;
		const topicId = r.topicId;
		// The words move to the new thread's reply box, so they stay if the send does not go through.
		const reply = draftKey(props.missionId, topicId);
		setDraft(reply, words);
		clearDraft(key());
		setMessage(key(), "");
		naming.update((all) => ({ ...all, [props.missionId]: false }));
		// Back from the thread comes to this page where it was.
		restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
		openThread(props.missionId, topicId);
		let m = props.mirror.mission(props.missionId);
		if (!m.snapshot?.topics.some((t) => t.id === topicId)) {
			await props.mirror.source.read(props.missionId);
			m = props.mirror.mission(props.missionId);
		}
		// The thread's page says why when the coordinator cannot take a message and none can wait; nothing is sent then.
		if (!m.snapshot?.discussion?.available && !m.snapshot?.discussion?.waits) return;
		const sent = await send(
			props.mirror,
			props.missionId,
			reply,
			{ purpose: "thread-send", topicId, text: words },
			reply,
		);
		if (sent?.status === "accepted") void props.mirror.source.history(props.missionId, topicId);
	};
	// Not while an input method composes here: see the Escape binding in ThreadScreen.
	effect(() => {
		if (!open()) return;
		cleanup(keymap.bind("mod+enter", () => void start(), { when: "always" }));
	});
	return (
		<If
			when={open()}
			else={
				<Buttons>
					<Button
						label="New thread"
						icon="plus"
						testID="thread-new"
						disabled={props.m.availability !== "live"}
						accessibilityLabel="Start a new thread by writing its first message. A thread chat answers it."
						onPress={() => {
							glide();
							naming.update((all) => ({ ...all, [props.missionId]: true }));
						}}
					/>
				</Buttons>
			}
		>
			<View class="gap-2">
				<Composer
					field={
						<TextField
							variant="composer"
							testID="thread-title"
							ref={field.ref}
							autoFocus
							multiline
							value={text()}
							accessibilityLabel="Your first message. Its first sentence becomes the thread's title."
							placeholder="What do you want to talk about? The first sentence becomes the thread's title."
							onChange={({ value }) => setDraft(key(), value)}
							onFocus={field.focus}
							onSelectionChange={field.select}
						/>
					}
					bar={
						<>
							<If when={text().trim()}>
								<Caption testID="thread-new-title" truncate grow>
									{`Title: ${titleOf(text())}`}
								</Caption>
							</If>
							<Spacer />
							{/* Send comes first: Tab from the field reaches it before Cancel. */}
							<Button
								label={props.m.writing ? "Sending…" : "Send"}
								testID="thread-start"
								shortcut="⌘↩"
								disabled={blocked()}
								onPress={() => void start()}
							/>
							<Button
								label="Cancel"
								testID="thread-cancel"
								accessibilityLabel="Close this without starting a thread. Your words stay."
								onPress={() => naming.update((all) => ({ ...all, [props.missionId]: false }))}
							/>
						</>
					}
				/>
				<If when={tooLong()}>
					<Caption tone="needs">{`Too long. Keep it under ${MAX_TEXT_BYTES} bytes.`}</Caption>
				</If>
				<If when={threadMessages()[key()]}>
					<Caption testID="thread-new-message">{threadMessages()[key()] ?? ""}</Caption>
				</If>
			</View>
		</If>
	);
}

/** One topic's row. Opening it only reads. */
function TopicRow(props: { missionId: string; topic: Topic; ops: ThreadOp[] }) {
	const status = () => STATUS[props.topic.disposition];
	const pending = () => props.ops.some((o) => o.topicId === props.topic.id && unsettled(o));
	const draft = () => (threadDrafts()[draftKey(props.missionId, props.topic.id)] ?? "") !== "";
	const meta = () => {
		const n = props.topic.inputs.length;
		const parts = [n === 0 ? "No messages yet" : n === 1 ? "1 message sent" : `${n} messages sent`];
		if (draft()) parts.push("unsent words kept");
		return parts.join(" · ");
	};
	const open = () => {
		restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
		openThread(props.missionId, props.topic.id);
	};
	return (
		<Row
			testID={`thread-${props.topic.id}`}
			mark={pending() ? "needs" : status().mark}
			title={props.topic.title}
			meta={meta()}
			state={pending() ? "Not confirmed" : status().word}
			stateTone={pending() ? "needs" : "quiet"}
			accessibilityLabel={`${props.topic.title}, ${pending() ? "not confirmed" : status().word}. Open the thread.`}
			onPress={open}
		/>
	);
}

/**
 * The mission overview's threads: open ones first, then Later; discarded
 * ones on request. Reading them sends nothing.
 */
/** A mission's threads. `heading={false}` leaves out the title where the row that holds it names it. */
export function MissionThreadsSection(props: { day: Day; missionId: string; heading?: boolean }) {
	const mirror = props.day.threads as ThreadsMirror;
	const m = () => mirror.mission(props.missionId);
	if (m().availability !== "live") void mirror.source.read(props.missionId);
	// Pilot reads again on its own after a failed read; with threads shown, it says nothing until the old-data rule does.
	const reads = keepRead(
		() => mirror.source.read(props.missionId),
		() => m().failed !== "" || m().availability === "unavailable",
		() => !!m().snapshot,
	);
	const topics = () => m().snapshot?.topics ?? [];
	const shown = () => {
		const all = topics();
		const kept = showDiscarded()[props.missionId] === true;
		return [
			...all.filter((t) => t.disposition === "open"),
			...all.filter((t) => t.disposition === "later"),
			...(kept ? all.filter((t) => t.disposition === "resolved" || t.disposition === "discarded") : []),
		];
	};
	const discarded = () => topics().filter((t) => t.disposition === "resolved" || t.disposition === "discarded").length;
	const body = () => (
		<View testID="mission-threads" class="gap-3">
			<Body tone="muted">
				Talk through one subject at a time. Talking here never starts, approves or stops work.
			</Body>
			<If
				when={m().snapshot}
				else={
					<If
						when={m().availability === "unavailable"}
						else={<Body tone="muted">Reading this mission's threads…</Body>}
					>
						<Unreadable mirror={mirror} missionId={props.missionId} m={m()} />
					</If>
				}
			>
				<If when={m().reason && reads.stale()}>
					<Caption>{staleLine(reads.readAt() ?? 0)}</Caption>
				</If>
				<If when={topics().length === 0}>
					<Body testID="threads-empty" tone="muted">
						No threads yet.
					</Body>
				</If>
				<Rows>
					<Each of={shown()} key={(t) => t.id}>
						{(t) => <TopicRow missionId={props.missionId} topic={t()} ops={m().ops} />}
					</Each>
				</Rows>
				<If when={discarded() > 0}>
					<Link
						testID="threads-discarded"
						tone="faint"
						label={showDiscarded()[props.missionId] ? "Hide closed threads" : `Show ${discarded()} closed`}
						onPress={() => {
							glide();
							showDiscarded.update((all) => ({ ...all, [props.missionId]: !all[props.missionId] }));
						}}
					/>
				</If>
			</If>
			<Unsettled
				mirror={mirror}
				missionId={props.missionId}
				ops={m().ops.filter((o) => unsettled(o) && !topics().some((t) => t.id === o.topicId))}
				testID="threads-unknown"
			/>
			<NewThread mirror={mirror} missionId={props.missionId} m={m()} />
		</View>
	);
	// Where the row that holds the threads names them, the content stands alone; elsewhere it is its own section.
	// `heading` does not change for a mounted section.
	if (props.heading === false) return body();
	return (
		<Section title="Threads with the coordinator" count={topics().length}>
			<Block>{body()}</Block>
		</Section>
	);
}

/** A reference's words: a task's number and title, a decision, or one message. */
function referenceWords(r: ThreadReference, catalog: Catalog): string {
	if (r.kind === "task") {
		const t = catalog.tasks.find((x) => x.id === r.id);
		return t ? `Task #${t.number} ${t.title}` : "A task of this mission";
	}
	if (r.kind === "decision") {
		const d = catalog.decisions.find((x) => x.id === r.id);
		return d ? `Decision D${d.number}: ${d.text}` : "A decision of this mission";
	}
	return `Message ${r.entryId} of the coordinator conversation`;
}

/**
 * What the thread links, and linking a task or decision. Linking never changes them.
 * A linked task with a result opens its page with Agent work shown; that only reads.
 */
function Links(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	catalog: Catalog;
	canWrite: boolean;
	projectId: string;
}) {
	const key = () => draftKey(props.missionId, props.topic.id);
	const open = () => linkOpen()[key()] === true;
	const delivered = (r: ThreadReference) => {
		if (r.kind !== "task" || !props.projectId) return null;
		const t = props.catalog.tasks.find((x) => x.id === r.id);
		return t && ["done", "in_review", "inReview"].includes(t.status) ? t : null;
	};
	const showWork = (r: ThreadReference) => {
		const t = delivered(r);
		if (!t) return;
		openDelivery(
			{ kind: "task", projectId: props.projectId, missionId: props.missionId, taskId: t.id },
			`#${t.number} ${t.title}`,
			true,
		);
	};
	const has = (r: ThreadReference) =>
		props.topic.references.some(
			(x) => x.kind === r.kind && (x.kind === "history" ? false : x.id === (r as { id: string }).id),
		);
	const choices = () =>
		[
			...props.catalog.tasks
				.filter((t) => t.status !== "dropped")
				.map((t) => ({
					ref: { kind: "task", id: t.id } as ThreadReference,
					words: `Task #${t.number} ${t.title}`,
				})),
			...props.catalog.decisions
				.filter((d) => !d.withdrawn)
				.map((d) => ({ ref: { kind: "decision", id: d.id } as ThreadReference, words: `D${d.number}: ${d.text}` })),
		].filter((c) => !has(c.ref));
	return (
		<Section
			testID="thread-links"
			title="Linked"
			count={props.topic.references.length}
			action={
				<If when={props.canWrite && props.catalog.known}>
					<Link
						testID="thread-link-open"
						label={open() ? "Close" : "Link a task or decision"}
						onPress={() => {
							glide();
							linkOpen.update((all) => ({ ...all, [key()]: !open() }));
						}}
					/>
				</If>
			}
		>
			<If when={props.topic.references.length === 0}>
				<EmptyLine text="Nothing linked yet." />
			</If>
			<Rows>
				<Each of={props.topic.references} key={(r) => JSON.stringify(r)}>
					{(r) => (
						<Row
							testID="thread-link"
							title={referenceWords(r(), props.catalog)}
							wrap
							selectable
							trailing={
								<If when={delivered(r())}>
									<Link
										testID={`thread-agent-work-${(r() as { id: string }).id}`}
										label="Agent work"
										onPress={() => showWork(r())}
									/>
								</If>
							}
						/>
					)}
				</Each>
			</Rows>
			<If when={open()}>
				<RowGroup label="Link to this thread" />
				<If when={choices().length === 0}>
					<EmptyLine text="Every task and decision is linked already." />
				</If>
				<Rows>
					<Each of={choices()} key={(c) => JSON.stringify(c.ref)}>
						{(c) => (
							<Row
								testID={`thread-link-${(c().ref as { id: string }).id}`}
								title={c().words}
								accessibilityLabel={`Link ${c().words} to this thread. This changes nothing about it.`}
								onPress={() =>
									void send(
										props.mirror,
										props.missionId,
										key(),
										{ purpose: "thread-reference", topicId: props.topic.id, reference: c().ref },
										null,
									)
								}
							/>
						)}
					</Each>
				</Rows>
			</If>
		</Section>
	);
}

/** What resolved a thread: the tasks its confirmed revision added, by number when known. */
function resolvedLine(topic: Topic, tasks: { id: string; number: number; title: string }[]): string {
	const named = topic.resolvedTaskIds.map((id) => {
		const task = tasks.find((x) => x.id === id);
		return task ? `#${task.number} ${task.title}` : "a new task";
	});
	return named.length
		? `A confirmed revision resolved this thread. It added ${named.join(", ")}. Its history stays.`
		: "A confirmed revision resolved this thread. Its history stays.";
}

/** What the thread chat sent to the planner. It grants nothing; the planner proposes a revision to confirm. */
function HandoffNote(props: { topic: Topic }) {
	const h = () => props.topic.handoff;
	return (
		<If when={props.topic.disposition === "open" && h()}>
			<Quote testID="thread-handoff">
				<BodyStrong>{h()?.queued ? "Sent to the planner" : "Waits to go to the planner"}</BodyStrong>
				<Body tone="muted">{h()?.summary ?? ""}</Body>
				<Each of={h()?.tasks ?? []} key={(task) => task.key}>
					{(task) => <Body>· {task().title}</Body>}
				</Each>
				<Caption>
					The planner proposes a revision with these tasks. Confirm it on the mission's planning page; nothing
					changes before.
				</Caption>
			</Quote>
		</If>
	);
}

/** Who wrote an entry. */
function who(e: HistoryEntry): string {
	if (e.role === "you") return "You";
	if (e.role === "coordinator") return "Coordinator";
	if (e.role === "chat") return "Thread chat";
	if (e.role === "planning") return "Pilot";
	return "";
}

/** One original entry of the activity. The thread's own ones are marked; the rest is other work. */
function Entry(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	sessionId: string;
	entry: HistoryEntry;
	focused: boolean;
	canLink: boolean;
}) {
	const own = () => props.entry.input || props.entry.referenced;
	const tag = () => {
		if (props.focused) return "The original of a message in this thread";
		if (props.entry.input) return "Sent in this thread";
		if (props.entry.referenced) return "Linked to this thread";
		if (props.entry.sentIn && props.entry.sentIn !== props.topic.id) return "Sent in another thread";
		return "";
	};
	const body = () =>
		props.entry.role === "planning" && !props.entry.text
			? "Pilot sent the coordinator a planning request."
			: props.entry.text;
	return (
		<View testID={`entry-${props.entry.id}`} class="gap-1">
			<View class="flex-row items-center gap-2">
				<Caption>{who(props.entry)}</Caption>
				<If when={tag()}>
					<Caption tone="faint">{tag()}</Caption>
				</If>
				<Spacer />
				<If when={props.canLink && !own() && props.entry.role === "coordinator"}>
					<Link
						testID={`entry-link-${props.entry.id}`}
						label="Link to thread"
						onPress={() =>
							void send(
								props.mirror,
								props.missionId,
								draftKey(props.missionId, props.topic.id),
								{
									purpose: "thread-reference",
									topicId: props.topic.id,
									reference: { kind: "history", sessionId: props.sessionId, entryId: props.entry.id },
								},
								null,
							)
						}
					/>
				</If>
			</View>
			{/* The message a thread opened the activity at is quoted, so the eye finds it. */}
			<If
				when={props.focused}
				else={
					<If
						when={props.entry.role === "you"}
						else={
							<If
								when={props.entry.role === "planning"}
								else={
									<Reply>
										<Body>{body()}</Body>
									</Reply>
								}
							>
								<Event text={body()} />
							</If>
						}
					>
						<Bubble text={body()} />
					</If>
				}
			>
				<Quote text={body()} />
			</If>
			<If when={props.entry.shortened}>
				<Caption tone="faint">Pilot shows the start of this long message only.</Caption>
			</If>
		</View>
	);
}

/** Runs of tools and notes, folded into one quiet line that opens to show each one. */
type Shown = { kind: "entry"; entry: HistoryEntry } | { kind: "quiet"; id: number; entries: HistoryEntry[] };

function fold(entries: HistoryEntry[]): Shown[] {
	const out: Shown[] = [];
	for (const e of entries) {
		if (e.role === "activity" && !e.referenced) {
			const last = out[out.length - 1];
			if (last?.kind === "quiet") last.entries.push(e);
			else out.push({ kind: "quiet", id: e.id, entries: [e] });
		} else out.push({ kind: "entry", entry: e });
	}
	return out;
}

/** Folded tool calls and notes. Opening them shows what each one saved, exactly as the history keeps it. */
function FoldedSteps(props: {
	missionId: string;
	topicId: string;
	sessionId: string;
	id: number;
	entries: HistoryEntry[];
}) {
	const key = () => `${draftKey(props.missionId, props.topicId)}/${props.sessionId}:${props.id}`;
	const open = () => stepsOpen()[key()] === true;
	const words = () =>
		props.entries.length === 1 ? "One tool step or note" : `${props.entries.length} tool steps and notes`;
	const steps = () =>
		props.entries.flatMap((e) => [
			{ id: String(e.id), text: e.text || "This step saved no details." },
			...(e.shortened ? [{ id: `${e.id}-start`, text: "Pilot shows the start of this step only." }] : []),
		]);
	return (
		<Disclosure
			testID={`steps-${props.id}`}
			label={words()}
			open={open()}
			accessibilityLabel={`${words()}. ${open() ? "Hide them" : "Show what they did"}. This only reads.`}
			onToggle={() => {
				glide();
				stepsOpen.update((all) => ({ ...all, [key()]: !open() }));
			}}
		>
			<View selectable>
				<Steps steps={steps()} />
			</View>
		</Disclosure>
	);
}

/**
 * The original conversation the thread reads, oldest first, with its other work and tool steps: the thread chat's
 * or the coordinator's, which may hold replies no thread links. It shows below the thread's conversation on request.
 */
function Activity(props: { mirror: ThreadsMirror; missionId: string; topic: Topic; canLink: boolean }) {
	const h = () => props.mirror.state().histories[historyKey(props.missionId, props.topic.id)];
	const chat = () => h()?.scope === "thread-chat";
	const read = (which: "older" | "latest", sessionId?: string) =>
		void props.mirror.source.history(props.missionId, props.topic.id, which, sessionId);
	return (
		<View testID="thread-history" class="gap-3">
			<View class="flex-row flex-wrap items-center gap-2">
				<BodyStrong>{chat() ? "Thread chat activity" : "Coordinator activity"}</BodyStrong>
				<Spacer />
				{/* The other conversation the thread owns, one press away: never only the one Pilot opened first. */}
				<If when={chat()}>
					<Button
						small
						label="Coordinator activity"
						testID="thread-activity-coordinator"
						disabled={h()?.reading === true}
						accessibilityLabel="Show the coordinator's original history, with replies no thread links. This only reads."
						onPress={() => read("latest", props.topic.ownerSessionId)}
					/>
				</If>
				<If when={!chat() && props.topic.chatSessionId}>
					<Button
						small
						label="Thread chat activity"
						testID="thread-activity-chat"
						disabled={h()?.reading === true}
						accessibilityLabel="Show this thread chat's original history. This only reads."
						onPress={() => read("latest")}
					/>
				</If>
			</View>
			<Caption>
				{chat()
					? "The thread chat's original history, with its tool steps."
					: "The coordinator's original history. It includes work outside this thread; messages this thread sent or linked are marked."}
			</Caption>
			<If when={h()?.more}>
				<Link
					label={h()?.reading ? "Reading…" : "Show earlier activity"}
					testID="thread-earlier"
					disabled={h()?.reading === true}
					onPress={() => read("older")}
				/>
			</If>
			<If when={h()?.reason}>
				<Notice testID="thread-history-off" role="alert" text={h()?.reason ?? ""} />
			</If>
			<If when={!h() || (h()?.reading && h()?.entries.length === 0)}>
				<Body tone="muted">Reading the activity…</Body>
			</If>
			<If when={h()?.availability === "live" && h()?.entries.length === 0 && !h()?.reading}>
				<Body tone="muted">No activity yet.</Body>
			</If>
			<Each of={fold(h()?.entries ?? [])} key={(s) => (s.kind === "entry" ? `e${s.entry.id}` : `q${s.id}`)}>
				{(s) => (
					<If
						when={s().kind === "entry"}
						else={
							<FoldedSteps
								missionId={props.missionId}
								topicId={props.topic.id}
								sessionId={h()?.sessionId ?? ""}
								id={(s() as { id: number }).id}
								entries={(s() as { entries: HistoryEntry[] }).entries}
							/>
						}
					>
						<Entry
							mirror={props.mirror}
							missionId={props.missionId}
							topic={props.topic}
							sessionId={h()?.sessionId ?? ""}
							entry={(s() as { entry: HistoryEntry }).entry}
							focused={h()?.focus?.entryId === (s() as { entry: HistoryEntry }).entry.id}
							canLink={props.canLink}
						/>
					</If>
				)}
			</Each>
			<If when={h()?.view === "original"}>
				<Link
					label={h()?.reading ? "Reading…" : "Show latest activity"}
					testID="thread-activity-latest"
					disabled={h()?.reading === true}
					onPress={() => read("latest")}
				/>
			</If>
		</View>
	);
}

/**
 * NSH's `<Scroll>` keeps its offset, not what shows: content that grows or shrinks above the viewport moves the
 * messages on screen (only a `List` has maintainVisibleContentPosition, and this page is a `Scroll`). ReadingPlace
 * keeps the message being read still. When scrolling rests, it notes the message intersecting the viewport's top
 * (or the next one below it) and where it is, with a binary search over the messages in order (a few
 * measures). When the threads' state changes (a page, a live read, a status that goes away), it measures that one
 * message again and scrolls by how far it moved. It measures nothing per frame or per scroll event, and leaves the
 * page alone while the user scrolls. Activity entries are not anchors: content that changes above the viewport
 * inside the activity can still move it.
 */
class ReadingPlace {
	#refs = new Map<string, ViewRef>();
	#scroller: () => ScrollRef | null;
	#scrollY: () => number;
	#order: () => string[];
	/** Position relative to the viewport, not window chrome that can move. */
	#anchor: { key: string; y: number } | null = null;
	/** The user scrolled and the page has not rested since. */
	#moving = false;
	/** Where this put the page, until the scroll view reports it. */
	#placed: number | null = null;
	#rest: ReturnType<typeof setTimeout> | undefined;
	#turn = 0;

	constructor(scroller: () => ScrollRef | null, scrollY: () => number, order: () => string[]) {
		this.#scroller = scroller;
		this.#scrollY = scrollY;
		this.#order = order;
	}

	/** The ref handler of message `key`. */
	ref(key: string): (node: ViewRef | null) => void {
		return (node) => {
			if (node) this.#refs.set(key, node);
			else this.#refs.delete(key);
		};
	}

	/** The scroll view reported `y`. A scroll this made is not the user's. */
	scrolled(y: number) {
		if (this.#placed !== null && Math.abs(y - this.#placed) < 1) {
			this.#placed = null;
			return;
		}
		this.#placed = null;
		this.#moving = true;
		this.#turn++;
		clearTimeout(this.#rest);
		this.#rest = setTimeout(() => void this.#note(), 150);
	}

	/** The threads' state changed: puts the noted message back where it was, once laid out. */
	async changed() {
		const a = this.#anchor;
		const scroller = this.#scroller();
		if (this.#moving || !scroller) return;
		if (!a) return this.#note();
		const turn = ++this.#turn;
		const [now, frame] = await Promise.all([this.#refs.get(a.key)?.measure(), scroller.measure()]);
		if (turn !== this.#turn || this.#moving) return;
		if (!now || !frame) return this.#note();
		const moved = now.pagePosition.y - frame.pagePosition.y - a.y;
		if (Math.abs(moved) < 1) return;
		const y = Math.max(0, (this.#placed ?? this.#scrollY()) + moved);
		this.#placed = y;
		scroller.scrollTo({ y, animated: false });
	}

	/** Notes the message crossing the viewport's top, or the nearest message after it. */
	async #note() {
		const turn = ++this.#turn;
		const scroller = this.#scroller();
		const frame = scroller ? await scroller.measure() : null;
		if (!frame || turn !== this.#turn) return;
		const top = frame.pagePosition.y;
		const keys = this.#order().filter((k) => this.#refs.has(k));
		let below: { key: string; y: number } | null = null;
		let above: { key: string; y: number; bottom: number } | null = null;
		let lo = 0;
		let hi = keys.length - 1;
		while (lo <= hi) {
			const mid = (lo + hi) >> 1;
			const key = keys[mid] as string;
			const at = await this.#refs.get(key)?.measure();
			if (turn !== this.#turn) return;
			if (!at) break;
			if (at.pagePosition.y >= top) {
				below = { key, y: at.pagePosition.y };
				hi = mid - 1;
			} else {
				above = { key, y: at.pagePosition.y, bottom: at.pagePosition.y + at.bounds.size.height };
				lo = mid + 1;
			}
		}
		const found = above && above.bottom > top ? above : (below ?? above);
		this.#anchor = found ? { key: found.key, y: found.y - top } : null;
		this.#moving = false;
	}

	/** State can arrive before native layout. Recheck only the anchor when its layout finishes. */
	laidOut(key: string) {
		if (key === this.#anchor?.key) void this.changed();
	}

	dispose() {
		clearTimeout(this.#rest);
		this.#turn++;
	}

	/** Where the noted message is now, from the top of the viewport. Reads only. */
	async probe(): Promise<{ key: string; top: number } | null> {
		const a = this.#anchor;
		const frame = await this.#scroller()?.measure();
		const now = a ? await this.#refs.get(a.key)?.measure() : null;
		return a && frame && now ? { key: a.key, top: now.pagePosition.y - frame.pagePosition.y } : null;
	}
}

/** The reading place of the thread on screen, for probe(). */
let shownPlace: ReadingPlace | null = null;

/**
 * For test fixtures: the message the thread on screen keeps in place and how far it is from the top of the
 * viewport now, or null. Reads only; it measures two views once.
 */
export function readingProbe(): Promise<{ key: string; top: number } | null> {
	return shownPlace ? shownPlace.probe() : Promise.resolve(null);
}

/** The activity, below the conversation on request. Opening it only reads; the draft and the conversation stay. */
function ActivityToggle(props: { mirror: ThreadsMirror; missionId: string; topic: Topic; canLink: boolean }) {
	const key = () => draftKey(props.missionId, props.topic.id);
	const open = () => activityOpen()[key()] === true;
	let button: ViewRef | undefined;
	return (
		<Section
			testID="thread-activity"
			title="Activity"
			action={
				<Link
					label={open() ? "Hide activity" : "Show activity"}
					testID="thread-activity-toggle"
					anchor={(node) => {
						button = node;
					}}
					accessibilityLabel={
						open()
							? "Hide the activity below this conversation. Your words stay."
							: "Show the original history with other work and tool steps below this conversation. This only reads."
					}
					onPress={() => {
						const hiding = open();
						glide();
						activityOpen.update((all) => ({ ...all, [key()]: !hiding }));
						// Hiding a long activity shortens the page, and the scroll view clamps to it: keep the
						// link that hid it on screen, where the user's eyes are.
						if (hiding) button?.reveal({ vertical: "nearest", animated: false });
					}}
				/>
			}
		>
			<If when={open()}>
				<Block>
					<Activity
						mirror={props.mirror}
						missionId={props.missionId}
						topic={props.topic}
						canLink={props.canLink}
					/>
				</Block>
			</If>
		</Section>
	);
}

const AUTHOR: Record<TopicMessage["author"], string> = { you: "You", chat: "Thread chat", coordinator: "Coordinator" };

/** What a message of yours waits for. Nothing only when a saved link proves its answer; never a guess. */
const REPLY: Record<ReplyState, string> = {
	answered: "",
	awaiting: "Awaiting a reply",
	pending: "Waits to reach the agent",
	unanswered: "The turn ended without a reply",
	unknown: "Reply status unknown",
};

/** Where a message is saved, in words. */
function savedIn(o: Original, topic: Topic): string {
	const where =
		o.sessionId === topic.ownerSessionId
			? "the coordinator's conversation"
			: o.sessionId === topic.chatSessionId
				? "this thread's chat"
				: "an earlier chat of this thread";
	return `Saved as entry ${o.entryId} of ${where}.`;
}

/**
 * What a reply linked whole may also cover: the other threads that link this exact saved reply, or other work. ""
 * for a message of this thread alone.
 */
function sharedWords(m: TopicMessage, topic: Topic, topics: Topic[]): string {
	const o = m.original;
	if (m.author === "you" || !o) return "";
	const others = topics.filter(
		(t) =>
			t.id !== topic.id &&
			t.references.some((r) => r.kind === "history" && r.sessionId === o.sessionId && r.entryId === o.entryId),
	).length;
	if (others === 1) return "Also linked to another thread. Parts of this reply may be about it.";
	if (others > 1) return `Also linked to ${others} other threads. Parts of this reply may be about them.`;
	return m.shared ? "Shown whole from the coordinator's conversation. Parts of it may be about other work." : "";
}

/**
 * One message of the thread's own conversation: who, when, the whole text, and its original on request. A send
 * that waits to be placed has no original yet, and says so instead.
 */
function Message(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	topics: Topic[];
	message: TopicMessage;
	now: number;
	anchor: (node: ViewRef | null) => void;
}) {
	const m = () => props.message;
	const key = () => originalKey(props.missionId, props.topic.id, m().key);
	const open = () => originalOpen()[key()] === true;
	const time = () => messageTime(m().at, props.now);
	const shared = () => sharedWords(m(), props.topic, props.topics);
	const showOriginal = () => {
		const o = m().original;
		if (!o) return;
		const thread = draftKey(props.missionId, props.topic.id);
		glide();
		activityOpen.update((all) => ({ ...all, [thread]: true }));
		void props.mirror.source.original(props.missionId, props.topic.id, o);
	};
	cleanup(() => props.anchor(null));
	return (
		<View ref={(node) => props.anchor(node)} testID={`message-${m().key}`} class="gap-1.5">
			<View class="flex-row items-center gap-2">
				<Caption>{AUTHOR[m().author]}</Caption>
				<Num>{time()}</Num>
				<Spacer />
				<If
					when={m().original}
					else={
						<Caption tone="faint">
							{m().reply === "pending"
								? "Saved. Not placed in the conversation yet."
								: "Saved. Where it was placed is unknown."}
						</Caption>
					}
				>
					<Link
						tone="faint"
						label={open() ? "Hide original" : "Original message"}
						testID={`message-original-${m().key}`}
						accessibilityLabel={`${open() ? "Hide where" : "Where"} ${m().author === "you" ? "your" : `the ${AUTHOR[m().author].toLowerCase()}'s`} message from ${time()} is saved. This only reads.`}
						onPress={() => {
							glide();
							originalOpen.update((all) => ({ ...all, [key()]: !open() }));
						}}
					/>
				</If>
			</View>
			<If
				when={m().author === "you"}
				else={
					<Reply>
						<Body>{m().text}</Body>
					</Reply>
				}
			>
				<Bubble text={m().text} />
			</If>
			{/* Only your messages wait for an answer; the agent's do not. They sit under your bubble. */}
			<If when={m().author === "you" && REPLY[m().reply]}>
				<View class="flex-row">
					<Spacer />
					<State
						testID={`message-reply-${m().key}`}
						kind={m().reply === "unknown" ? "needs" : "new"}
						label={REPLY[m().reply]}
						plain
					/>
				</View>
			</If>
			<If when={shared()}>
				<Caption testID={`message-shared-${m().key}`}>{shared()}</Caption>
			</If>
			<If when={open() && m().original}>
				<Quote testID={`message-origin-${m().key}`}>
					<Caption>{m().original ? savedIn(m().original as Original, props.topic) : ""}</Caption>
					<Link
						label="Show in activity"
						testID={`message-activity-${m().key}`}
						accessibilityLabel="Open the activity below at this exact saved message. This only reads."
						onPress={showOriginal}
					/>
				</Quote>
			</If>
		</View>
	);
}

/**
 * The thread's own conversation, oldest first: your messages and the replies saved as this thread's, across the
 * coordinator's conversation and the thread's chats, then your sends that wait to be placed. Other work stays in
 * the activity. Messages Pilot has not read between two it shows are marked, never closed up silently.
 */
function Conversation(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	topics: Topic[];
	place: ReadingPlace;
}) {
	const c = () => props.mirror.state().conversations[historyKey(props.missionId, props.topic.id)];
	// Pilot reads the conversation again on its own after a failed read. With messages shown, it says
	// nothing until the old-data rule does.
	const conversationReads = keepRead(
		() => props.mirror.source.history(props.missionId, props.topic.id),
		() => !!c()?.reason,
		() => (c()?.messages.length ?? 0) > 0,
	);
	const now = Date.now();
	// Any change of the threads' state may move what is above the viewport (a page, a placed or answered message,
	// a new link). Start the check here; layout callbacks repeat it once native frames have changed.
	effect(() => {
		props.mirror.state();
		void Promise.resolve().then(() => props.place.changed());
	});
	const earlier = () => void props.mirror.source.earlierMessages(props.missionId, props.topic.id);
	const gapAt = (key: string) => c()?.gap?.newer === key;
	function Gap() {
		return (
			<Notice
				testID="thread-gap"
				text="Pilot has not read the messages between these yet. Some may belong to this thread."
				action={
					<Link
						label={c()?.reading ? "Reading…" : "Show the messages between"}
						testID="thread-gap-read"
						disabled={c()?.reading === true}
						accessibilityLabel="Read the messages Pilot has not read between these. This only reads."
						onPress={earlier}
					/>
				}
			/>
		);
	}
	return (
		<View testID="thread-conversation" class="gap-6" onLayout={() => void props.place.changed()}>
			<If when={c()?.reason && ((c()?.messages.length ?? 0) === 0 || conversationReads.stale())}>
				<Notice
					testID="thread-conversation-off"
					role="alert"
					text={
						(c()?.messages.length ?? 0) === 0 ? (c()?.reason ?? "") : staleLine(conversationReads.readAt() ?? 0)
					}
					action={
						<If when={conversationReads.warn()}>
							<Link
								label="Try now"
								icon="refresh"
								testID="thread-conversation-read"
								accessibilityLabel="Read this thread's conversation again. This sends nothing."
								onPress={() => void conversationReads.now()}
							/>
						</If>
					}
				/>
			</If>
			<If when={c()?.availability === "live" && !c()?.complete}>
				<Caption testID="thread-unlinked">
					Some earlier replies may have no saved link to this thread. They stay in the activity, not in this
					conversation.
				</Caption>
			</If>
			<If when={c()?.more && !c()?.gap}>
				<Link
					label={c()?.reading ? "Reading…" : "Show earlier messages"}
					testID="thread-earlier-messages"
					disabled={c()?.reading === true}
					accessibilityLabel="Show this thread's earlier messages above. This only reads."
					onPress={earlier}
				/>
			</If>
			<If when={!c() || (c()?.availability === "reading" && c()?.messages.length === 0)}>
				<Body tone="muted">Reading the conversation…</Body>
			</If>
			{/* Your exact saved words whose place in time Pilot cannot tell: kept apart, never put in an invented order. */}
			<If when={(c()?.queued ?? []).some((q) => q.reply === "unknown")}>
				<View testID="thread-unplaced" class="gap-4">
					<View class="gap-0.5">
						<BodyStrong>Earlier messages with unknown placement</BodyStrong>
						<Caption>
							Pilot saved these words but cannot tell where they sit in this conversation, or whether they were
							answered.
						</Caption>
					</View>
					<Each of={(c()?.queued ?? []).filter((q) => q.reply === "unknown")} key={(m) => m.key}>
						{(m) => (
							<Message
								mirror={props.mirror}
								missionId={props.missionId}
								topic={props.topic}
								topics={props.topics}
								message={m()}
								now={now}
								anchor={props.place.ref(m().key)}
							/>
						)}
					</Each>
				</View>
			</If>
			<If
				when={
					c()?.availability === "live" &&
					c()?.messages.length === 0 &&
					c()?.queued.length === 0 &&
					!c()?.reading &&
					!c()?.more
				}
			>
				<Body testID="thread-conversation-empty" tone="muted">
					No messages in this thread yet.
				</Body>
			</If>
			<Each of={c()?.messages ?? []} key={(m) => m.key}>
				{(m) => (
					<View class="gap-6" onLayout={() => props.place.laidOut(m().key)}>
						<If when={gapAt(m().key)}>
							<Gap />
						</If>
						<Message
							mirror={props.mirror}
							missionId={props.missionId}
							topic={props.topic}
							topics={props.topics}
							message={m()}
							now={now}
							anchor={props.place.ref(m().key)}
						/>
					</View>
				)}
			</Each>
			<If when={c()?.gap && !c()?.gap?.newer}>
				<Gap />
			</If>
			<Each of={(c()?.queued ?? []).filter((q) => q.reply === "pending")} key={(m) => m.key}>
				{(m) => (
					<Message
						mirror={props.mirror}
						missionId={props.missionId}
						topic={props.topic}
						topics={props.topics}
						message={m()}
						now={now}
						anchor={props.place.ref(m().key)}
					/>
				)}
			</Each>
		</View>
	);
}

/** Messages saved to wait for the coordinator, with their words. They go with the next answers, or once it is free. */
function WaitingMessages(props: { messages: WaitingMessage[] }) {
	return (
		<If when={props.messages.length > 0}>
			<View testID="thread-waiting" class="gap-2">
				<Caption>
					{props.messages.length === 1
						? "Waiting for the coordinator. It goes with your next answers, or as soon as the coordinator is free."
						: `${props.messages.length} messages wait for the coordinator. They go with your next answers, or as soon as the coordinator is free.`}
				</Caption>
				<Each of={props.messages} key={(w) => w.operationId}>
					{(w) => <Bubble scheduled text={w().text} />}
				</Each>
			</View>
		</If>
	);
}

/** The reply box. Only Send sends, once; the words stay until the service accepted them. */
function ReplyBox(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	m: MissionThreads;
	interrupting: Signal<boolean>;
}) {
	const interrupting = props.interrupting;
	const key = () => draftKey(props.missionId, props.topic.id);
	const text = () => threadDrafts()[key()] ?? "";
	const field = keepField(
		`thread-reply-${props.missionId}-${props.topic.id}`,
		() => `thread/${props.missionId}/${props.topic.id}`,
		text,
	);
	const tooLong = () => utf8Bytes(text()) > MAX_TEXT_BYTES;
	const pending = () => props.m.ops.some(unsettled);
	const discussion = () => props.m.snapshot?.discussion ?? { available: false, reason: "", waits: false };
	// It cannot take a message now, but Send saves one to wait for it.
	const waits = () => !discussion().available && discussion().waits;
	const why = () => {
		if (props.m.availability !== "live") return "Read this mission's threads again before you send.";
		if (pending()) return "An earlier action on this mission is not confirmed. Check it before you send another.";
		if (!discussion().available && !discussion().waits)
			return `The coordinator cannot take a message now. It needs an active, unheld planning coordinator${discussion().reason ? ` (${discussion().reason})` : ""}. Your words stay; nothing is sent.`;
		return "";
	};
	const canSend = () => !why() && !props.m.writing && text().trim() !== "" && !tooLong();
	const go = async (interrupt = false) => {
		if (!canSend()) return;
		const r = await send(
			props.mirror,
			props.missionId,
			key(),
			{
				purpose: "thread-send",
				topicId: props.topic.id,
				text: text(),
				...(interrupt ? { interrupt: true as const } : {}),
			},
			key(),
		);
		if (r?.status === "accepted") void props.mirror.source.history(props.missionId, props.topic.id);
		interrupting.set(false);
	};
	// Not while an input method composes here: see the Escape binding in ThreadScreen.
	keymap.bind(
		"mod+enter",
		() => {
			void go();
		},
		{ when: "always" },
	);
	return (
		<View testID="thread-composer" class="gap-2">
			<If when={why()}>
				<Body testID="thread-cannot-send" tone="muted">
					{why()}
				</Body>
			</If>
			<Composer
				field={
					<TextField
						variant="composer"
						testID="thread-reply"
						ref={field.ref}
						multiline
						value={text()}
						accessibilityLabel="Your message in this thread"
						placeholder="Write about this subject"
						onChange={({ value }) => setDraft(key(), value)}
						onFocus={field.focus}
						onSelectionChange={field.select}
					/>
				}
				bar={
					<>
						{/* Send comes first: Tab from the field reaches it before the thread's other commands. */}
						<Button
							kind="primary"
							label={props.m.writing ? "Sending…" : "Send"}
							shortcut="⌘↩"
							testID="thread-send"
							disabled={!canSend()}
							accessibilityLabel="Send this message once. The thread chat answers; it does not start or approve work."
							onPress={() => void go()}
						/>
						<If when={props.topic.chatSessionId}>
							<Button
								label="Interrupt…"
								testID="thread-interrupt"
								disabled={!canSend()}
								onPress={() => interrupting.set(true)}
							/>
						</If>
						<Spacer />
						<KeyHints hints={[["⌘↩", "Send"]]} />
						<Button
							kind="quiet"
							small
							label="Later"
							testID="thread-later"
							disabled={props.m.writing || pending() || props.m.availability !== "live"}
							accessibilityLabel="Move this thread to Later. Its history and your words stay."
							onPress={() =>
								void send(
									props.mirror,
									props.missionId,
									key(),
									{ purpose: "thread-disposition", topicId: props.topic.id, disposition: "later" },
									null,
								)
							}
						/>
						<Button
							kind="quiet"
							small
							label="Discard"
							testID="thread-discard"
							disabled={props.m.writing || pending() || props.m.availability !== "live"}
							accessibilityLabel="Discard this thread. Its history stays and you can reopen it."
							onPress={() =>
								void send(
									props.mirror,
									props.missionId,
									key(),
									{ purpose: "thread-disposition", topicId: props.topic.id, disposition: "discarded" },
									null,
								)
							}
						/>
					</>
				}
			/>
			<If when={tooLong()}>
				<Caption tone="needs">{`Too long. Keep it under ${MAX_TEXT_BYTES} bytes.`}</Caption>
			</If>
			{/* Said once: the waiting list says it when a message already waits. */}
			<If when={waits() && !why() && !(props.m.snapshot?.waiting ?? []).some((w) => w.topicId === props.topic.id)}>
				<Caption testID="thread-will-wait">
					The coordinator cannot take a message right now. Send saves it: it goes with your next answers, or as
					soon as the coordinator is free.
				</Caption>
			</If>
			<If when={interrupting()}>
				<ConfirmDialog
					testID="thread-interrupt-confirm"
					title="Interrupt this discussion?"
					onClose={() => interrupting.set(false)}
				>
					<Body tone="muted">
						Save and stop its current response, then send your message now. This does not pause coding agents or
						clear the mission's other holds.
					</Body>
					<Buttons>
						<Button label="Cancel" onPress={() => interrupting.set(false)} />
						<Button label="Interrupt" disabled={!canSend()} onPress={() => void go(true)} />
					</Buttons>
				</ConfirmDialog>
			</If>
		</View>
	);
}

// LIBRARY GAP: the library has no confirmation dialog: a modal over the page that asks before a strong action
// (here, interrupting a discussion). This keeps the base Dialog this screen used and frames it with the panel's look;
// the library should offer a `Confirm` part with a title, a sentence and its buttons.
function ConfirmDialog(props: { testID: string; title: string; onClose: () => void; children?: JSX.Element }) {
	return (
		<Dialog
			accessibilityLabel={props.title}
			closeOnEscape={false}
			onOpenChange={(e) => {
				if (!e.open) props.onClose();
			}}
			class="absolute inset-0 items-center justify-center bg-background/90 p-6"
		>
			<View
				testID={props.testID}
				class="max-w-md gap-3 rounded-(--radius-panel) border border-border bg-popover px-4 py-3.5"
			>
				<Title role="header">{props.title}</Title>
				{props.children}
			</View>
		</Dialog>
	);
}

/**
 * The thread on screen is not in what shows. Says which: still reading,
 * not in the latest read, or the read failed (and then why). A failed read
 * keeps the earlier one; it is never shown as the thread being gone.
 */
function Absent(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	const failed = () => props.m.availability === "unavailable" || (props.m.snapshot !== null && props.m.failed !== "");
	const reads = keepRead(
		() => props.mirror.source.read(props.missionId),
		failed,
		() => !!props.m.snapshot,
	);
	const words = () => {
		if (props.m.availability === "unavailable") return `${props.m.reason} Your words for this thread stay.`;
		if (!props.m.snapshot) return "Reading this thread…";
		if (props.m.failed)
			return `${props.m.failed} This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.`;
		return "This thread is not in the latest read. Your words for it stay.";
	};
	const tryNow = () => (
		<If when={reads.warn()}>
			<Link
				label="Try now"
				icon="refresh"
				testID="threads-read"
				accessibilityLabel="Read this mission's threads again. This sends nothing."
				onPress={() => void reads.now()}
			/>
		</If>
	);
	return (
		<Panel testID="thread-absent">
			<If
				when={failed()}
				else={
					<Block>
						<Body tone="muted">{words()}</Body>
						{tryNow()}
					</Block>
				}
			>
				<Notice testID="thread-absent-failed" role="alert" placement="panel" text={words()} action={tryNow()} />
			</If>
		</Panel>
	);
}

/** A thread's page over its mission. Opening it only reads. */
export function ThreadScreen(props: { day: Day; missionId: string; topicId: string }) {
	const interrupting = signal(false);
	const mirror = props.day.threads as ThreadsMirror;
	const m = () => mirror.mission(props.missionId);
	void mirror.source.read(props.missionId);
	void mirror.source.history(props.missionId, props.topicId);
	// The thread and its conversation, read again on its own after a failed read and when the window comes back.
	const threadReads = keepRead(
		async () => {
			await Promise.all([
				mirror.source.read(props.missionId),
				mirror.source.history(props.missionId, props.topicId),
			]);
		},
		() => m().failed !== "",
		() => !!m().snapshot,
	);
	const topic = (): Topic | null => m().snapshot?.topics.find((t) => t.id === props.topicId) ?? null;
	const key = () => draftKey(props.missionId, props.topicId);
	// Escape closes an open link list first, then goes back to the mission.
	// It works from the reply box too; the draft stays.
	// While an input method composes in the reply box or a title (marked
	// text), NSH 0.5's macOS key monitor gives every key to the input
	// method and fires no binding, `when: "always"` included: Escape then
	// cancels the composition and stays on the page. Headless tests cannot
	// compose, so only a native check with a real input method shows it.
	keymap.bind(
		"escape",
		() => {
			if (interrupting()) interrupting.set(false);
			else if (linkOpen()[key()]) {
				glide();
				linkOpen.update((all) => ({ ...all, [key()]: false }));
			} else closeThread();
		},
		{ when: "always" },
	);
	// A changed thread (a new link or message) reads its newest messages again. Earlier pages, the activity, the
	// draft and the scroll stay.
	let revision: number | null = null;
	effect(() => {
		const r = topic()?.revision ?? null;
		if (r === null) return;
		const changed = revision !== null && r !== revision;
		revision = r;
		if (changed) void Promise.resolve().then(() => mirror.source.history(props.missionId, props.topicId));
	});
	const title = () => props.day.feed.mission(props.missionId)?.row.title ?? "";
	const canWrite = () => m().availability === "live" && !m().writing && !m().ops.some(unsettled);
	const place = `thread/${props.missionId}/${props.topicId}`;
	const scroll = keepScroll(place);
	// A restored offset waits for the conversation it scrolled through.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	const reading = new ReadingPlace(
		() => scroller(),
		() => scrollOf(place),
		() =>
			(mirror.state().conversations[historyKey(props.missionId, props.topicId)]?.messages ?? []).map((m) => m.key),
	);
	shownPlace = reading;
	cleanup(() => {
		if (shownPlace === reading) shownPlace = null;
		reading.dispose();
	});
	effect(() => {
		const node = scroller();
		const c = mirror.state().conversations[historyKey(props.missionId, props.topicId)];
		if (waiting === null || !node || !c || c.messages.length === 0) return;
		const y = waiting;
		waiting = null;
		node.scrollTo({ y, animated: false });
	});
	return (
		<Scroll
			ref={(node) => scroller.set(node)}
			class="flex-1"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={(e) => {
				if (waiting !== null) return;
				scroll.onScroll(e);
				reading.scrolled(e.offset.y);
			}}
		>
			<Page testID="thread">
				<If
					when={topic()}
					else={
						<>
							<PageHead
								pre={
									<Caption>
										{title() ? `${title()} · Thread with the coordinator` : "Thread with the coordinator"}
									</Caption>
								}
								title="Thread"
							/>
							<Absent mirror={mirror} missionId={props.missionId} m={m()} />
						</>
					}
				>
					<Each of={topic() ? [topic() as Topic] : []} key={(t) => t.id}>
						{(t) => (
							<>
								<PageHead
									pre={
										<Caption>
											{title() ? `${title()} · Thread with the coordinator` : "Thread with the coordinator"}
										</Caption>
									}
									title={t().title}
									state={
										<State
											testID="thread-status"
											kind={STATUS[t().disposition].mark}
											label={STATUS[t().disposition].word}
										/>
									}
									text="Started by you. Talking here never starts, approves or stops work."
								/>
								<Panel
									testID="thread-panel"
									notice={
										<If when={m().reason && threadReads.stale()}>
											<Notice
												testID="thread-stale"
												role="alert"
												placement="panel"
												text={staleLine(threadReads.readAt() ?? 0)}
											/>
										</If>
									}
								>
									{/* One column at a reading width, as a conversation reads. */}
									<Column centered>
										<If when={t().disposition !== "open"}>
											<Block testID="thread-closed">
												<Body>
													{t().disposition === "later"
														? "This thread is in Later. Its history stays."
														: t().disposition === "resolved"
															? resolvedLine(t(), m().snapshot?.catalog.tasks ?? [])
															: "This thread is discarded. Its history stays."}
												</Body>
												<Buttons>
													<Button
														label="Reopen"
														testID="thread-reopen"
														disabled={!canWrite()}
														accessibilityLabel="Reopen this thread. This sends nothing to the coordinator."
														onPress={() =>
															void send(
																mirror,
																props.missionId,
																key(),
																{ purpose: "thread-disposition", topicId: t().id, disposition: "open" },
																null,
															)
														}
													/>
												</Buttons>
											</Block>
										</If>
										<Links
											mirror={mirror}
											missionId={props.missionId}
											topic={t()}
											catalog={m().snapshot?.catalog ?? { known: false, tasks: [], decisions: [] }}
											canWrite={canWrite()}
											projectId={props.day.delivery?.view().projectId ?? ""}
										/>
										<Section title="Conversation">
											<Block gap={4}>
												<Conversation
													mirror={mirror}
													missionId={props.missionId}
													topic={t()}
													topics={m().snapshot?.topics ?? []}
													place={reading}
												/>
												<HandoffNote topic={t()} />
												<Unsettled
													mirror={mirror}
													missionId={props.missionId}
													ops={m().ops.filter(unsettled)}
													testID="thread-unknown"
												/>
												{/* A send the conversation already shows as waiting to be placed shows once, there. */}
												<WaitingMessages
													messages={(m().snapshot?.waiting ?? []).filter(
														(w) =>
															w.topicId === t().id &&
															!(
																mirror.state().conversations[historyKey(props.missionId, t().id)]
																	?.queued ?? []
															).some((q) => q.operationId === w.operationId),
													)}
												/>
												<If when={t().disposition === "open"}>
													<ReplyBox
														mirror={mirror}
														missionId={props.missionId}
														topic={t()}
														m={m()}
														interrupting={interrupting}
													/>
												</If>
												<If when={threadMessages()[key()]}>
													<Caption testID="thread-message">{threadMessages()[key()] ?? ""}</Caption>
												</If>
											</Block>
										</Section>
										<ActivityToggle
											mirror={mirror}
											missionId={props.missionId}
											topic={t()}
											canLink={canWrite()}
										/>
									</Column>
								</Panel>
							</>
						)}
					</Each>
				</If>
			</Page>
		</Scroll>
	);
}
