// Focused threads with a mission's coordinator: one subject each. The
// mission overview lists them; a thread's page shows what it links, the
// coordinator's ORIGINAL conversation (never a topic-only copy: only the
// messages the thread names are marked as its own) and the reply box.
// Talking here never starts, approves, resumes, archives or stops work. A
// message is sent only to an active, unheld planning coordinator; when it
// cannot take one, the page says why and nothing is sent. A sent message is
// not the coordinator's answer. A lost answer stays Unknown: Check only
// reads it, and the words stay until the service accepted them.
import { effect, keymap, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import { Input } from "nsh/base";
import type { Day } from "./day";
import { keepField, keepScroll, restoreScroll, scrollOf } from "./kept";
import { glide } from "./motion";
import {
	type Catalog,
	type HistoryEntry,
	historyKey,
	MAX_TEXT_BYTES,
	MAX_TITLE,
	type MissionThreads,
	type ThreadOp,
	type ThreadReference,
	type ThreadsMirror,
	type ThreadWrite,
	type Topic,
	utf8Bytes,
	type WriteResult,
} from "./threadFeed";
import {
	clearDraft,
	closeThread,
	draftKey,
	linkOpen,
	naming,
	openThread,
	setDraft,
	setMessage,
	showDiscarded,
	threadDrafts,
	threadMessages,
} from "./threadView";
import { Action, InlineAction, Mark, type MarkKind, RowLink, SectionTitle } from "./ui";

const STATUS: Record<Topic["disposition"], { word: string; mark: MarkKind }> = {
	open: { word: "Open", mark: "still" },
	later: { word: "Later", mark: "paused" },
	discarded: { word: "Discarded", mark: "done" },
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
	const words = (o: ThreadOp) => {
		if (o.purpose === "thread-send") return `Message not confirmed: “${o.text ?? ""}”`;
		if (o.purpose === "thread-create") return "A new thread is not confirmed.";
		if (o.purpose === "thread-reference") return "A link is not confirmed.";
		return "A Later, Discard or Reopen is not confirmed.";
	};
	return (
		<If when={props.ops.length > 0}>
			<View testID={props.testID} class="gap-2 rounded-xl bg-muted px-4 py-3">
				<Each of={props.ops} key={(o) => o.operationId}>
					{(o) => (
						<View class="gap-1.5">
							<View class="flex-row items-start gap-2.5">
								<View class="pt-1.5">
									<Mark kind="unknown" />
								</View>
								<View selectable class="flex-1">
									<Text class="text-sm text-foreground">{words(o())}</Text>
								</View>
							</View>
							<Text class="pl-4 text-xs text-muted-foreground">
								Pilot sent it but heard nothing back. It will not send it again. Check reads what happened.
							</Text>
							<View class="flex-row pl-3">
								<Action
									label={o().state === "checking" ? "Checking…" : "Check"}
									icon="refresh"
									testID={`thread-check-${o().operationId}`}
									disabled={o().state === "checking"}
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
							</View>
						</View>
					)}
				</Each>
				<If when={threadMessages()[key()]}>
					<Text testID={`${props.testID}-message`} class="text-xs text-muted-foreground">
						{threadMessages()[key()] ?? ""}
					</Text>
				</If>
			</View>
		</If>
	);
}

/** What the read could not show, never as "no threads". */
function Unreadable(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	return (
		<View testID="threads-off" class="gap-2">
			<View class="flex-row items-start gap-2.5">
				<View class="pt-1.5">
					<Mark kind="unknown" />
				</View>
				<Text class="flex-1 text-sm text-foreground">
					{`${props.m.reason} Threads are not shown; this is not the same as having none.`}
				</Text>
			</View>
			<View class="flex-row pl-3">
				<Action
					label="Read again"
					icon="refresh"
					testID="threads-read"
					accessibilityLabel="Read this mission's threads again. This sends nothing."
					onPress={() => void props.mirror.source.read(props.missionId)}
				/>
			</View>
		</View>
	);
}

/** Naming a new thread. Starting it sends nothing to the coordinator. */
function NewThread(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	const key = () => draftKey(props.missionId, "");
	const title = () => threadDrafts()[key()] ?? "";
	const open = () => naming()[props.missionId] === true;
	const field = keepField(`thread-title-${props.missionId}`, () => `mission/${props.missionId}`, title);
	const tooLong = () => [...title().trim()].length > MAX_TITLE;
	const blocked = () =>
		props.m.availability !== "live" || props.m.writing || props.m.ops.some(unsettled) || !title().trim() || tooLong();
	const start = async () => {
		if (blocked()) return;
		const r = await send(
			props.mirror,
			props.missionId,
			key(),
			{ purpose: "thread-create", title: title().trim() },
			key(),
		);
		if (r?.status === "accepted" && r.topicId) {
			naming.update((all) => ({ ...all, [props.missionId]: false }));
			setMessage(key(), "");
			// Back from the thread comes to this page where it was.
			restoreScroll(`mission/${props.missionId}`, scrollOf(`mission/${props.missionId}`));
			openThread(props.missionId, r.topicId);
		}
	};
	return (
		<If
			when={open()}
			else={
				<View class="flex-row">
					<Action
						label="New thread"
						icon="plus"
						testID="thread-new"
						disabled={props.m.availability !== "live"}
						accessibilityLabel="Start a new thread with the coordinator. Starting it sends nothing."
						onPress={() => {
							glide();
							naming.update((all) => ({ ...all, [props.missionId]: true }));
						}}
					/>
				</View>
			}
		>
			<View class="gap-2">
				<Input
					testID="thread-title"
					ref={field.ref}
					autoFocus
					value={title()}
					accessibilityLabel="What the new thread is about"
					placeholder="One subject, such as: which file types are in scope?"
					onChange={({ value }) => setDraft(key(), value)}
					onFocus={field.focus}
					onSelectionChange={field.select}
					onSubmit={() => void start()}
					class="min-h-9 rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground focus:border-primary"
				/>
				<If when={tooLong()}>
					<Text class="text-xs text-needs-ink">{`Too long. Keep it under ${MAX_TITLE} characters.`}</Text>
				</If>
				<View class="flex-row flex-wrap items-center gap-2">
					<Action
						primary
						label={props.m.writing ? "Starting…" : "Start thread"}
						testID="thread-start"
						disabled={blocked()}
						onPress={() => void start()}
					/>
					<Action
						label="Cancel"
						testID="thread-cancel"
						accessibilityLabel="Close this without starting a thread. Your words stay."
						onPress={() => naming.update((all) => ({ ...all, [props.missionId]: false }))}
					/>
				</View>
				<If when={threadMessages()[key()]}>
					<Text testID="thread-new-message" class="text-xs text-muted-foreground">
						{threadMessages()[key()] ?? ""}
					</Text>
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
		<View class="gap-0.5 border-t border-border py-2.5">
			<RowLink
				testID={`thread-${props.topic.id}`}
				title={props.topic.title}
				accessibilityLabel={`${props.topic.title}, ${pending() ? "not confirmed" : status().word}. Open the thread.`}
				onPress={open}
			>
				<View class="flex-row items-center gap-1.5">
					<Mark kind={pending() ? "unknown" : status().mark} />
					<Text class={pending() ? "text-xs text-needs-ink" : "text-xs text-muted-foreground"}>
						{pending() ? "Not confirmed" : status().word}
					</Text>
				</View>
			</RowLink>
			<Text class="text-xs text-faint">{meta()}</Text>
		</View>
	);
}

/**
 * The mission overview's threads: open ones first, then Later; discarded
 * ones on request. Reading them sends nothing.
 */
export function MissionThreadsSection(props: { day: Day; missionId: string }) {
	const mirror = props.day.threads as ThreadsMirror;
	const m = () => mirror.mission(props.missionId);
	if (m().availability !== "live") void mirror.source.read(props.missionId);
	const topics = () => m().snapshot?.topics ?? [];
	const shown = () => {
		const all = topics();
		const kept = showDiscarded()[props.missionId] === true;
		return [
			...all.filter((t) => t.disposition === "open"),
			...all.filter((t) => t.disposition === "later"),
			...(kept ? all.filter((t) => t.disposition === "discarded") : []),
		];
	};
	const discarded = () => topics().filter((t) => t.disposition === "discarded").length;
	return (
		<View testID="mission-threads" class="gap-2">
			<SectionTitle title="Threads with the coordinator" count={topics().length} />
			<Text class="text-sm text-muted-foreground">
				Talk through one subject at a time. Talking here never starts, approves or stops work.
			</Text>
			<If
				when={m().snapshot}
				else={
					<If
						when={m().availability === "unavailable"}
						else={<Text class="text-sm text-muted-foreground">Reading this mission's threads…</Text>}
					>
						<Unreadable mirror={mirror} missionId={props.missionId} m={m()} />
					</If>
				}
			>
				<View>
					<If when={m().reason}>
						<Text class="pb-2 text-xs text-muted-foreground">{m().reason}</Text>
					</If>
					<If when={topics().length === 0}>
						<Text testID="threads-empty" class="border-t border-border py-3 text-sm text-muted-foreground">
							No threads yet.
						</Text>
					</If>
					<Each of={shown()} key={(t) => t.id}>
						{(t) => <TopicRow missionId={props.missionId} topic={t()} ops={m().ops} />}
					</Each>
					<If when={discarded() > 0}>
						<View class="flex-row border-t border-border pt-2">
							<InlineAction
								testID="threads-discarded"
								label={
									showDiscarded()[props.missionId] ? "Hide discarded threads" : `Show ${discarded()} discarded`
								}
								onPress={() => {
									glide();
									showDiscarded.update((all) => ({ ...all, [props.missionId]: !all[props.missionId] }));
								}}
							/>
						</View>
					</If>
				</View>
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

/** What the thread links, and linking a task or decision. Linking never changes them. */
function Links(props: { mirror: ThreadsMirror; missionId: string; topic: Topic; catalog: Catalog; canWrite: boolean }) {
	const key = () => draftKey(props.missionId, props.topic.id);
	const open = () => linkOpen()[key()] === true;
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
		<View testID="thread-links" class="gap-1.5">
			<SectionTitle title="Linked" count={props.topic.references.length} />
			<If when={props.topic.references.length === 0}>
				<Text class="text-sm text-muted-foreground">Nothing linked yet.</Text>
			</If>
			<Each of={props.topic.references} key={(r) => JSON.stringify(r)}>
				{(r) => (
					<View selectable>
						<Text testID="thread-link" class="text-sm text-foreground">
							{referenceWords(r(), props.catalog)}
						</Text>
					</View>
				)}
			</Each>
			<If when={props.canWrite && props.catalog.known}>
				<View class="flex-row">
					<InlineAction
						testID="thread-link-open"
						label={open() ? "Close" : "Link a task or decision"}
						onPress={() => {
							glide();
							linkOpen.update((all) => ({ ...all, [key()]: !open() }));
						}}
					/>
				</View>
			</If>
			<If when={open()}>
				<View class="gap-0.5 rounded-xl bg-muted px-3 py-2">
					<If when={choices().length === 0}>
						<Text class="text-xs text-muted-foreground">Every task and decision is linked already.</Text>
					</If>
					<Each of={choices()} key={(c) => JSON.stringify(c.ref)}>
						{(c) => (
							<RowLink
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
				</View>
			</If>
		</View>
	);
}

/** Who wrote an entry. */
function who(e: HistoryEntry): string {
	if (e.role === "you") return "You";
	if (e.role === "coordinator") return "Coordinator";
	if (e.role === "planning") return "Pilot";
	return "";
}

/** One original message. The thread's own ones are marked; the rest is the coordinator's other work. */
function Entry(props: {
	mirror: ThreadsMirror;
	missionId: string;
	topic: Topic;
	entry: HistoryEntry;
	canLink: boolean;
}) {
	const own = () => props.entry.input || props.entry.referenced;
	const tag = () => {
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
		<View
			testID={`entry-${props.entry.id}`}
			class="gap-1 rounded-lg px-3 py-2"
			classList={{ "bg-muted": own(), "bg-background": !own() }}
		>
			<View class="flex-row items-baseline gap-2">
				<Text class="text-xs font-medium text-muted-foreground">{who(props.entry)}</Text>
				<If when={tag()}>
					<Text class="text-xs text-faint">{tag()}</Text>
				</If>
				<View class="flex-1" />
				<If when={props.canLink && !own() && props.entry.role === "coordinator"}>
					<InlineAction
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
									reference: {
										kind: "history",
										sessionId: props.topic.ownerSessionId,
										entryId: props.entry.id,
									},
								},
								null,
							)
						}
					/>
				</If>
			</View>
			<View selectable>
				<Text
					class={
						props.entry.role === "planning"
							? "text-sm text-muted-foreground"
							: "text-sm leading-relaxed text-foreground"
					}
				>
					{body()}
				</Text>
			</View>
			<If when={props.entry.shortened}>
				<Text class="text-xs text-faint">Pilot shows the start of this long message only.</Text>
			</If>
		</View>
	);
}

/** Runs of tools and notes, folded into one quiet line. */
type Shown = { kind: "entry"; entry: HistoryEntry } | { kind: "quiet"; id: number; count: number };

function fold(entries: HistoryEntry[]): Shown[] {
	const out: Shown[] = [];
	for (const e of entries) {
		if (e.role === "activity" && !e.referenced) {
			const last = out[out.length - 1];
			if (last?.kind === "quiet") last.count += 1;
			else out.push({ kind: "quiet", id: e.id, count: 1 });
		} else out.push({ kind: "entry", entry: e });
	}
	return out;
}

/** The coordinator's original conversation, oldest first, with the thread's own messages marked. */
function Conversation(props: { mirror: ThreadsMirror; missionId: string; topic: Topic; canLink: boolean }) {
	const h = () => props.mirror.state().histories[historyKey(props.missionId, props.topic.id)];
	return (
		<View testID="thread-history" class="gap-2">
			<SectionTitle title="Coordinator conversation" />
			<Text class="text-xs text-muted-foreground">
				The coordinator's whole conversation, not only this thread. Messages this thread sent or linked are marked.
			</Text>
			<If when={h()?.more}>
				<View class="flex-row">
					<Action
						label={h()?.reading ? "Reading…" : "Show earlier"}
						testID="thread-earlier"
						disabled={h()?.reading === true}
						onPress={() => void props.mirror.source.history(props.missionId, props.topic.id, true)}
					/>
				</View>
			</If>
			<If when={h()?.reason}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-1.5">
						<Mark kind="unknown" />
					</View>
					<Text testID="thread-history-off" class="flex-1 text-sm text-foreground">
						{h()?.reason ?? ""}
					</Text>
				</View>
			</If>
			<If when={!h() || (h()?.reading && h()?.entries.length === 0)}>
				<Text class="text-sm text-muted-foreground">Reading the conversation…</Text>
			</If>
			<If when={h()?.availability === "live" && h()?.entries.length === 0 && !h()?.reading}>
				<Text class="text-sm text-muted-foreground">The coordinator has no messages yet.</Text>
			</If>
			<Each of={fold(h()?.entries ?? [])} key={(s) => (s.kind === "entry" ? `e${s.entry.id}` : `q${s.id}`)}>
				{(s) => (
					<If
						when={s().kind === "entry"}
						else={
							<Text class="px-3 text-xs text-faint">
								{(s() as { count: number }).count === 1
									? "One tool step or note"
									: `${(s() as { count: number }).count} tool steps and notes`}
							</Text>
						}
					>
						<Entry
							mirror={props.mirror}
							missionId={props.missionId}
							topic={props.topic}
							entry={(s() as { entry: HistoryEntry }).entry}
							canLink={props.canLink}
						/>
					</If>
				)}
			</Each>
		</View>
	);
}

/** The reply box. Only Send sends, once; the words stay until the service accepted them. */
function Composer(props: { mirror: ThreadsMirror; missionId: string; topic: Topic; m: MissionThreads }) {
	const key = () => draftKey(props.missionId, props.topic.id);
	const text = () => threadDrafts()[key()] ?? "";
	const field = keepField(
		`thread-reply-${props.missionId}-${props.topic.id}`,
		() => `thread/${props.missionId}/${props.topic.id}`,
		text,
	);
	const tooLong = () => utf8Bytes(text()) > MAX_TEXT_BYTES;
	const pending = () => props.m.ops.some(unsettled);
	const discussion = () => props.m.snapshot?.discussion ?? { available: false, reason: "" };
	const why = () => {
		if (props.m.availability !== "live") return "Read this mission's threads again before you send.";
		if (pending()) return "An earlier action on this mission is not confirmed. Check it before you send another.";
		if (!discussion().available)
			return `The coordinator cannot take a message now. It needs an active, unheld planning coordinator${discussion().reason ? ` (${discussion().reason})` : ""}. Your words stay; nothing is sent.`;
		return "";
	};
	const canSend = () => !why() && !props.m.writing && text().trim() !== "" && !tooLong();
	const go = async () => {
		if (!canSend()) return;
		const r = await send(
			props.mirror,
			props.missionId,
			key(),
			{ purpose: "thread-send", topicId: props.topic.id, text: text() },
			key(),
		);
		if (r?.status === "accepted") void props.mirror.source.history(props.missionId, props.topic.id);
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
				<Text testID="thread-cannot-send" class="text-sm text-muted-foreground">
					{why()}
				</Text>
			</If>
			<Input
				testID="thread-reply"
				ref={field.ref}
				multiline
				value={text()}
				accessibilityLabel="Your message to the coordinator"
				placeholder="Write to the coordinator about this subject"
				onChange={({ value }) => setDraft(key(), value)}
				onFocus={field.focus}
				onSelectionChange={field.select}
				class="min-h-20 rounded-xl border border-input bg-background px-3.5 py-2.5 text-sm text-foreground focus:border-primary"
			/>
			<If when={tooLong()}>
				<Text class="text-xs text-needs-ink">{`Too long. Keep it under ${MAX_TEXT_BYTES} bytes.`}</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<Action
					primary
					label={props.m.writing ? "Sending…" : "Send"}
					shortcut="⌘↩"
					testID="thread-send"
					disabled={!canSend()}
					accessibilityLabel="Send this message to the coordinator once. It does not start or approve work."
					onPress={() => void go()}
				/>
				<View class="flex-1" />
				<Action
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
				<Action
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
			</View>
		</View>
	);
}

/**
 * The thread on screen is not in what shows. Says which: still reading,
 * not in the latest read, or the read failed (and then why). A failed read
 * keeps the earlier one; it is never shown as the thread being gone.
 */
function Absent(props: { mirror: ThreadsMirror; missionId: string; m: MissionThreads }) {
	const failed = () => props.m.availability === "unavailable" || (props.m.snapshot !== null && props.m.failed !== "");
	const words = () => {
		if (props.m.availability === "unavailable") return `${props.m.reason} Your words for this thread stay.`;
		if (!props.m.snapshot) return "Reading this thread…";
		if (props.m.failed)
			return `${props.m.failed} This thread is not in Pilot's last read, so Pilot cannot show it now. Your words for it stay.`;
		return "This thread is not in the latest read. Your words for it stay.";
	};
	return (
		<View testID="thread-absent" class="gap-3">
			<If when={failed()} else={<Text class="text-base text-muted-foreground">{words()}</Text>}>
				<View class="flex-row items-start gap-2.5">
					<View class="pt-2">
						<Mark kind="unknown" />
					</View>
					<Text testID="thread-absent-failed" role="alert" class="flex-1 text-base text-foreground">
						{words()}
					</Text>
				</View>
			</If>
			<If when={props.m.availability === "unavailable" || props.m.snapshot}>
				<View class="flex-row">
					<Action
						label="Read again"
						icon="refresh"
						testID="threads-read"
						accessibilityLabel="Read this mission's threads again. This sends nothing."
						onPress={() => void props.mirror.source.read(props.missionId)}
					/>
				</View>
			</If>
		</View>
	);
}

/** A thread's page over its mission. Opening it only reads. */
export function ThreadScreen(props: { day: Day; missionId: string; topicId: string }) {
	const mirror = props.day.threads as ThreadsMirror;
	const m = () => mirror.mission(props.missionId);
	void mirror.source.read(props.missionId);
	void mirror.source.history(props.missionId, props.topicId);
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
			if (linkOpen()[key()]) {
				glide();
				linkOpen.update((all) => ({ ...all, [key()]: false }));
			} else closeThread();
		},
		{ when: "always" },
	);
	const title = () => props.day.feed.mission(props.missionId)?.row.title ?? "";
	const canWrite = () => m().availability === "live" && !m().writing && !m().ops.some(unsettled);
	const place = `thread/${props.missionId}/${props.topicId}`;
	const scroll = keepScroll(place);
	// A restored offset waits for the conversation it scrolled through.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		const h = mirror.state().histories[historyKey(props.missionId, props.topicId)];
		if (waiting === null || !node || !h || h.entries.length === 0) return;
		const y = waiting;
		waiting = null;
		node.scrollTo({ y, animated: false });
	});
	return (
		<Scroll
			ref={(node) => scroller.set(node)}
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={(e) => {
				if (waiting === null) scroll.onScroll(e);
			}}
		>
			<View testID="thread" class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<If when={topic()} else={<Absent mirror={mirror} missionId={props.missionId} m={m()} />}>
					<Each of={topic() ? [topic() as Topic] : []} key={(t) => t.id}>
						{(t) => (
							<View class="gap-8">
								<View class="gap-2">
									<Text class="text-xs text-faint">
										{title() ? `${title()} · Thread with the coordinator` : "Thread with the coordinator"}
									</Text>
									<Text
										role="header"
										class="text-3xl font-semibold leading-tight tracking-tight text-foreground"
									>
										{t().title}
									</Text>
									<View class="flex-row flex-wrap items-center gap-1.5">
										<Mark kind={STATUS[t().disposition].mark} />
										<Text testID="thread-status" class="text-xs text-muted-foreground">
											{STATUS[t().disposition].word}
										</Text>
										<Text class="text-xs text-faint">
											· Started by you. Talking here never starts, approves or stops work.
										</Text>
										<View class="flex-1" />
										<Action
											label="Read again"
											icon="refresh"
											testID="threads-read-again"
											accessibilityLabel="Read this thread and the coordinator's conversation again. This sends nothing."
											onPress={() => {
												void mirror.source.read(props.missionId);
												void mirror.source.history(props.missionId, t().id);
											}}
										/>
									</View>
								</View>
								<If when={m().reason}>
									<View testID="thread-stale" class="flex-row items-start gap-2.5">
										<View class="pt-1.5">
											<Mark kind="unknown" />
										</View>
										<Text role="alert" class="flex-1 text-sm text-muted-foreground">
											{m().reason}
										</Text>
									</View>
								</If>
								<If when={t().disposition !== "open"}>
									<View testID="thread-closed" class="gap-2 rounded-xl bg-muted px-4 py-3">
										<Text class="text-sm text-foreground">
											{t().disposition === "later"
												? "This thread is in Later. Its history stays."
												: "This thread is discarded. Its history stays."}
										</Text>
										<View class="flex-row">
											<Action
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
										</View>
									</View>
								</If>
								<Links
									mirror={mirror}
									missionId={props.missionId}
									topic={t()}
									catalog={m().snapshot?.catalog ?? { known: false, tasks: [], decisions: [] }}
									canWrite={canWrite()}
								/>
								<Conversation mirror={mirror} missionId={props.missionId} topic={t()} canLink={canWrite()} />
								<Unsettled
									mirror={mirror}
									missionId={props.missionId}
									ops={m().ops.filter(unsettled)}
									testID="thread-unknown"
								/>
								<If when={t().disposition === "open"}>
									<Composer mirror={mirror} missionId={props.missionId} topic={t()} m={m()} />
								</If>
								<If when={threadMessages()[key()]}>
									<Text testID="thread-message" class="text-xs text-muted-foreground">
										{threadMessages()[key()] ?? ""}
									</Text>
								</If>
							</View>
						)}
					</Each>
				</If>
			</View>
		</Scroll>
	);
}
