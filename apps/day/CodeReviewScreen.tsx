// Review code: one result's saved code changes on a page of their own, over the result page. Files on the left,
// the selected file's saved diff on the right, and the private comments kept with this result. Selecting lines
// opens a comment field under them. Comments are kept with the result and never posted to GitHub; Send back sends
// them to the agent once, through the result's own Send back. Opening the page or reading code records nothing.
import { cleanup, computed, effect, keymap, signal, Text, untracked, View, type ViewRef } from "nsh";
import type { DeliveredWork, DeliveryMirror } from "./deliveryFeed";
import { webLink } from "./deliveryFeed";
import {
	backNotes,
	closeCodeReview,
	closeDelivery,
	codeReviewed,
	type DeliveryPlace,
	deliveryMessages,
	focusReviewCode,
	NOTE_LIMIT,
	ownPullRequests,
	prName,
	reviewableCode,
	setNote,
	utf8,
} from "./deliveryView";
import {
	anchorLabel,
	connectedResultReview,
	forgetReviewDraft,
	keepReviewDraft,
	type ResultReviewEntry,
	type ResultReviewSource,
	reviewDrafts,
	reviewKey,
	revisionContext,
} from "./resultReview";
import { anchorFile, type LineAnchor, type ReviewFile, type ReviewSession, reviewSession } from "./reviewSession";
import {
	Action,
	type DiffAnnotation,
	type DiffLineRange,
	Disclosure,
	LinkAction,
	Mark,
	Menu,
	MenuItem,
	MenuTrigger,
	Notice,
	Picker,
	Pressable,
	ReviewDiff,
	SectionTitle,
	TextField,
} from "./ui";
import { setFor } from "./view";

/** The most lines one comment covers (the service's limit, docs/technical/day-result-comments.md). */
const COMMENT_LINES = 40;
const REVIEW_KEYS = keymap.label("mod+r");

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const short = (commit: string) => commit.slice(0, 7);
/** A pull request's short name, such as "PR #12". */
const prShort = (work: DeliveredWork) => {
	const pr = ownPullRequests(work)[0];
	return pr ? prName(pr).split(" · ")[0] : "";
};
const fileName = (path: string) => path.split("/").pop() ?? path;
const filePath = (f: ReviewFile) =>
	f.before && f.after && f.before.path !== f.after.path ? `${f.before.path} → ${f.after.path}` : f.path;

/** "3 files · +42 −10", from the comparison read. */
function changeLine(review: ReviewSession): string {
	const files = review.diff()?.files.length ?? 0;
	const t = review.totals();
	return `${plural(files, "file")} · +${t.added} −${t.deleted}`;
}

/** Pending private saves with their Check, then the review's last message. */
export function ReviewStatus(props: { review: ReviewSession }) {
	return (
		<View class="gap-2">
			<Each of={props.review.pending()} key={(id) => id}>
				{(id) => (
					<Notice
						text="Private save not confirmed"
						detail="Only this result is held. Independent work continues."
						action={
							<Action
								label="Check saved comment"
								disabled={props.review.busy()}
								onPress={() => void props.review.check(id())}
							/>
						}
					/>
				)}
			</Each>
			<If when={props.review.message()}>
				<Text role="alert" testID="review-message" class="text-sm text-muted-foreground">
					{props.review.message()}
				</Text>
			</If>
		</View>
	);
}

/**
 * The result page's Code changes: one row with the counts, where they come from and Review code (⌘R). It shows
 * only while the result has saved code, or while its review cannot be read.
 */
export function CodeChanges(props: {
	review: ReviewSession;
	work: DeliveredWork;
	placeKey: string;
	primary: boolean;
	onOpen: () => void;
}) {
	const line = () => {
		if (props.review.failed()) return "Pilot could not read the saved code changes.";
		if (!props.review.diff()) return "Reading the saved code changes…";
		return `${changeLine(props.review)} · ${plural(props.review.current().length, "comment")}`;
	};
	const detail = () => {
		const d = props.review.diff();
		return [prShort(props.work), d ? `${short(d.base)} → ${short(d.head)}` : "", "saved copy, not your working copy"]
			.filter(Boolean)
			.join(" · ");
	};
	return (
		<If when={props.review.hasCode()}>
			<CodeChangesRow
				placeKey={props.placeKey}
				primary={props.primary}
				line={line()}
				detail={detail()}
				onOpen={props.onOpen}
			/>
		</If>
	);
}

function CodeChangesRow(props: {
	placeKey: string;
	primary: boolean;
	line: string;
	detail: string;
	onOpen: () => void;
}) {
	reviewableCode.set(props.placeKey);
	cleanup(() => {
		if (untracked(reviewableCode) === props.placeKey) reviewableCode.set(null);
	});
	keymap.bind("mod+r", props.onOpen);
	return (
		<View testID="code-changes" class="gap-3">
			<SectionTitle title="Code changes" />
			<View class="flex-row items-center gap-3 rounded-xl border border-border px-4 py-3">
				<View class="min-w-0 flex-1 gap-0.5">
					<Text testID="code-changes-line" class="text-sm text-foreground">
						{props.line}
					</Text>
					<Text class="text-xs text-faint">{props.detail}</Text>
				</View>
				<Action
					variant={props.primary ? "primary" : "outline"}
					label="Review code"
					testID="review-code"
					shortcut={REVIEW_KEYS}
					accessibilityLabel="Review code. Opens the saved changes; reading them records nothing."
					anchor={(node: ViewRef) => {
						if (untracked(focusReviewCode) !== props.placeKey) return;
						focusReviewCode.set(null);
						node.focus();
					}}
					onPress={props.onOpen}
				/>
			</View>
		</View>
	);
}

/** One file in the list: its name, folder path, counts and a mark when it has comments. */
function FileRow(props: {
	file: ReviewFile;
	counts: { added: number; deleted: number } | null;
	comments: number;
	selected: boolean;
	onPress: () => void;
}) {
	return (
		<Pressable
			testID={`review-file-${props.file.path}`}
			accessibilityLabel={`${filePath(props.file)}, ${props.file.status}${props.comments ? `, ${plural(props.comments, "comment")}` : ""}`}
			selected={props.selected}
			onPress={props.onPress}
			class={`gap-0.5 rounded-lg px-3 py-2 hover:bg-accent ${props.selected ? "bg-muted" : ""}`}
		>
			<Text class="truncate text-sm text-foreground">{fileName(props.file.path)}</Text>
			<View class="flex-row items-center gap-2">
				<Text class="min-w-0 flex-1 truncate text-xs text-faint">{props.file.path}</Text>
				<If when={props.counts} else={<Text class="text-xs text-faint">not shown</Text>}>
					<Text class="text-xs text-ok-ink">{`+${props.counts?.added ?? 0}`}</Text>
					<Text class="text-xs text-failed-ink">{`−${props.counts?.deleted ?? 0}`}</Text>
				</If>
				<If when={props.comments > 0} else={<View class="size-2" />}>
					<Mark kind="needs" />
				</If>
			</View>
		</Pressable>
	);
}

/** A saved comment under its lines. */
function SavedComment(props: { entry: ResultReviewEntry | undefined; current: boolean }) {
	const where = () => {
		const a = props.entry?.anchor;
		if (a?.kind !== "lines") return "";
		const lines = a.end > a.start ? `lines ${a.start}–${a.end}` : `line ${a.start}`;
		return a.side === "before" ? `old ${lines}` : lines;
	};
	return (
		<View class="gap-1 bg-muted p-3">
			<Text class="text-xs text-muted-foreground">
				{props.current ? `Your comment · ${where()}` : `Earlier result version · ${where()}`}
			</Text>
			<View selectable>
				<Text class="text-sm text-foreground">{props.entry?.body ?? ""}</Text>
			</View>
		</View>
	);
}

/** The comment field under the selected lines. Its words are the result's one unsent draft. */
function CommentField(props: {
	review: ReviewSession;
	target: LineAnchor | null;
	tooLong: number;
	onDone: () => void;
}) {
	const draft = () => props.review.draft();
	const elsewhere = () =>
		draft().body !== "" &&
		(draft().kind === "note" ||
			(draft().anchor.kind === "lines" &&
				!!props.target &&
				JSON.stringify(draft().anchor) !== JSON.stringify(props.target)) ||
			draft().anchor.kind !== "lines");
	const value = () => (elsewhere() ? "" : draft().body);
	const save = async () => {
		if (await props.review.save("comment")) props.onDone();
	};
	return (
		<View testID="comment-field" class="gap-2 border-y border-border bg-background p-3">
			<If
				when={props.tooLong === 0}
				else={
					<Text class="text-sm text-muted-foreground">
						{`A comment covers at most ${COMMENT_LINES} lines, and this selection has ${props.tooLong}. Select fewer lines.`}
					</Text>
				}
			>
				<If
					when={!elsewhere()}
					else={
						<Text class="text-sm text-muted-foreground">
							{draft().anchor.kind !== "lines"
								? "Your unsaved note is open on the result page. Save or discard it first."
								: `You have an unsaved comment on ${anchorLabel(draft().anchor)}. Save or discard it first.`}
						</Text>
					}
				>
					<TextField
						testID="review-body"
						accessibilityLabel="Your comment on these lines. Kept with this result, never posted to GitHub."
						placeholder="Comment on these lines"
						multiline
						rows={2}
						autoFocus
						value={value()}
						disabled={props.review.busy() || props.review.pending().length > 0}
						onChange={({ value }) => {
							if (props.target)
								keepReviewDraft(props.review.key, { kind: "comment", anchor: props.target, body: value });
						}}
					/>
					<View class="flex-row items-center gap-2">
						<Action
							variant="outline"
							label={props.review.busy() ? "Saving…" : "Save comment"}
							testID="comment-save"
							disabled={
								props.review.disabled() ||
								!props.target ||
								!draft().body.trim() ||
								utf8(draft().body) > NOTE_LIMIT
							}
							onPress={() => void save()}
						/>
						<Action
							label="Discard"
							testID="comment-discard"
							disabled={props.review.busy()}
							onPress={() => {
								forgetReviewDraft(props.review.key);
								props.onDone();
							}}
						/>
						<Text class="flex-1 text-xs text-faint">Kept with this result. Never posted to GitHub.</Text>
					</View>
				</If>
			</If>
		</View>
	);
}

/** One file's saved diff, with saved comments and the comment field under their lines. */
function FileDiff(props: { review: ReviewSession; file: ReviewFile; snapshotId: string }) {
	const selection = signal<DiffLineRange | null>(null);
	let view: { setSelectedLines: (range?: DiffLineRange | null) => void } | undefined;
	const draft = () => props.review.draft();
	/** The unsent comment on this file, if any. */
	const ownDraft = (): LineAnchor | null => {
		const d = draft();
		const diff = props.review.diff();
		if (!d.body || d.kind !== "comment" || d.anchor.kind !== "lines" || !diff) return null;
		return anchorFile(diff, d.anchor)?.path === props.file.path ? d.anchor : null;
	};
	const fromSelection = (): LineAnchor | null => {
		const range = selection();
		if (!range || range.end - range.start >= COMMENT_LINES) return null;
		const side = range.side === "old" ? "before" : "after";
		const source = props.file[side];
		if (!source) return null;
		return {
			kind: "lines",
			snapshotId: props.snapshotId,
			side,
			path: source.path,
			start: range.start + 1,
			end: range.end + 1,
			blobSha256: source.sha256,
			excerpt: source.text
				.split("\n")
				.slice(range.start, range.end + 1)
				.join("\n"),
		};
	};
	const target = () => ownDraft() ?? fromSelection();
	const tooLong = () => {
		const range = selection();
		return range && !ownDraft() && range.end - range.start >= COMMENT_LINES ? range.end - range.start + 1 : 0;
	};
	// Where the field sits, as one value, so typing never rebuilds the annotations.
	const fieldAt = computed(() => {
		const own = ownDraft();
		if (own) return `${own.side === "before" ? "old" : "new"}:${own.end - 1}`;
		const range = selection();
		return range ? `${range.side}:${range.end}` : "";
	});
	const saved = computed<DiffAnnotation[]>(() =>
		props.review.comments().flatMap((e) => {
			const a = e.anchor;
			if (a.kind !== "lines" || a.snapshotId !== props.snapshotId) return [];
			const source = props.file[a.side];
			return source?.path === a.path && source.sha256 === a.blobSha256
				? [{ id: e.operationId, side: a.side === "before" ? "old" : "new", line: a.end - 1 }]
				: [];
		}),
	);
	const annotations = () => {
		const at = fieldAt();
		if (!at) return saved();
		const [side, line] = at.split(":");
		return [...saved(), { id: "comment-field", side: side as "old" | "new", line: Number(line) }];
	};
	const done = () => {
		selection.set(null);
		view?.setSelectedLines(null);
	};
	// Escape closes the comment field and keeps its words; Escape again goes back to the result.
	keymap.bind(
		"escape",
		() => {
			if (untracked(selection)) done();
			else closeCodeReview();
		},
		{ when: "always" },
	);
	return (
		<ReviewDiff
			before={props.file.before?.text ?? ""}
			after={props.file.after?.text ?? ""}
			language={props.file.path}
			ref={(diff) => {
				view = diff;
			}}
			onSelection={selection.set}
			onComment={selection.set}
			annotations={annotations()}
			renderAnnotation={(a) => (
				<If
					when={a.id === "comment-field"}
					else={
						<SavedComment
							entry={props.review.comments().find((e) => e.operationId === a.id)}
							current={
								props.review.comments().find((e) => e.operationId === a.id)?.deliveryId ===
								props.review.deliveryId
							}
						/>
					}
				>
					<CommentField review={props.review} target={target()} tooLong={tooLong()} onDone={done} />
				</If>
			)}
		/>
	);
}

/** Unsent words from earlier versions of this result, read-only. */
function EarlierDrafts(props: { work: DeliveredWork }) {
	const key = reviewKey(props.work);
	const prefix = `${key.slice(0, key.lastIndexOf("#"))}#`;
	// Earlier-version drafts cannot change from this page. Read once, disclose in pages.
	const earlier = Object.entries(untracked(reviewDrafts))
		.filter(([id, d]) => id !== key && id.startsWith(prefix) && d.body !== "")
		.map(([id, draft]) => ({ deliveryId: id.slice(prefix.length), draft }));
	const open = signal(false);
	const at = signal(0);
	return (
		<If when={earlier.length > 0}>
			<Disclosure
				label={`Earlier unsent drafts (${earlier.length})`}
				testID="review-earlier-drafts"
				open={open()}
				onToggle={() => open.set(!open())}
			>
				<Text class="text-xs text-muted-foreground">Read-only original words. Nothing was moved or sent.</Text>
				<Each of={earlier.slice(at(), at() + 20)} key={(d) => d.deliveryId}>
					{(d) => (
						<View selectable class="gap-1 border-t border-border pt-3">
							<Text class="text-xs text-muted-foreground">{`Unsent · original result ${d().deliveryId.slice(0, 12)} · ${d().draft.kind === "note" ? "My note" : anchorLabel(d().draft.anchor)}`}</Text>
							<If when={d().draft.anchor.kind === "lines"}>
								<Text class="text-xs font-mono text-muted-foreground">
									{(d().draft.anchor as LineAnchor).excerpt}
								</Text>
							</If>
							<Text class="text-sm text-foreground">{d().draft.body}</Text>
						</View>
					)}
				</Each>
				<View class="flex-row gap-2">
					<If when={at() > 0}>
						<Action label="Newer drafts" onPress={() => at.set(Math.max(0, at() - 20))} />
					</If>
					<If when={at() + 20 < earlier.length}>
						<Action label="Older drafts" onPress={() => at.set(at() + 20)} />
					</If>
				</View>
			</Disclosure>
		</If>
	);
}

/**
 * The Review code page of one delivered result. It reads the result's private review and the saved comparison;
 * only Save comment, Keep for later, Add to review queue and Send back write, each once.
 */
export function CodeReviewScreen(props: {
	mirror: DeliveryMirror;
	place: DeliveryPlace;
	work: DeliveredWork;
	fresh: boolean;
	title: string;
	source?: ResultReviewSource;
}) {
	const key = props.place.key;
	codeReviewed.update((all) => ({ ...all, [reviewKey(untracked(() => props.work))]: true }));
	const back = () => closeCodeReview();
	keymap.bind("mod+[", back, { when: "always" });
	const source = props.source ?? connectedResultReview();
	return (
		<View testID="code-review" class="flex-1 bg-background">
			<If
				when={source}
				else={
					<View class="gap-3 px-6 py-6">
						<LinkAction label={`‹ ${props.title}`} testID="code-review-back" onPress={back} />
						<Text class="text-sm text-muted-foreground">Private review is unavailable in this window.</Text>
					</View>
				}
			>
				<Review {...props} source={source as ResultReviewSource} back={back} placeKey={key} />
			</If>
		</View>
	);
}

function Review(props: {
	mirror: DeliveryMirror;
	work: DeliveredWork;
	fresh: boolean;
	title: string;
	source: ResultReviewSource;
	placeKey: string;
	back: () => void;
}) {
	const key = props.placeKey;
	const review = reviewSession(
		() => props.work,
		() => props.fresh,
		props.source,
		() => {
			void props.mirror.source.readSaved();
			closeDelivery();
		},
	);
	const selected = signal("");
	const menuOpen = signal(false);
	const files = () => review.diff()?.files ?? [];
	// The first file shows once a comparison is read; a reread keeps the file chosen while it is still there.
	effect(() => {
		const list = files();
		untracked(() => {
			if (!list.some((f) => f.path === selected())) selected.set(list[0]?.path ?? "");
		});
	});
	const index = () => files().findIndex((f) => f.path === selected());
	const move = (by: number) => {
		const list = files();
		const next = list[Math.min(list.length - 1, Math.max(0, index() + by))];
		if (next) selected.set(next.path);
	};
	keymap.bind({ j: () => move(1), k: () => move(-1) }, { when: "notEditing" });
	// Escape and Back without a file shown.
	keymap.bind("escape", props.back, { when: "always" });
	const commentsOn = (f: ReviewFile) =>
		review
			.current()
			.filter(
				(e) => e.anchor.kind === "lines" && (f.before?.path === e.anchor.path || f.after?.path === e.anchor.path),
			).length;
	const count = () => review.current().length;
	const sendable = () => {
		const w = props.work;
		const state = w.verificationCurrent ? w.verification?.state : undefined;
		const view = props.mirror.view();
		return (
			!!w.deliveryId &&
			props.fresh &&
			!w.pendingOperationId &&
			state !== "done" &&
			state !== "sent_back" &&
			!view.unsettled.some((o) => o.key === key) &&
			!view.sending.includes(key)
		);
	};
	const sending = () => props.mirror.view().sending.includes(key);
	const say = (m: string) => setFor(deliveryMessages, key, m);
	/** Send back with every saved comment of this version, after any unsent Send back words. */
	const sendBack = async () => {
		const context = revisionContext(review.current());
		if (!context || !sendable()) return;
		const prior = backNotes()[key] ?? "";
		const note = [prior, context].filter(Boolean).join("\n\n");
		const size = utf8(note);
		if (size > NOTE_LIMIT) {
			review.message.set(
				`Send back holds at most ${NOTE_LIMIT} bytes, and these comments with their code need ${size}. Send back from the result page with a shorter note.`,
			);
			return;
		}
		say("");
		review.message.set("");
		const r = await props.mirror.source.assess(props.work, "send_back", note);
		if (r.status === "accepted") {
			if ((backNotes()[key] ?? "") === prior) setNote(key, "");
			props.back();
			return;
		}
		review.message.set(r.message);
	};
	const pr = () => ownPullRequests(props.work).find((r) => webLink(r));
	const openPr = () => {
		const link = pr();
		if (!link) return;
		void props.mirror.source.open(props.work, link).then((result) => {
			if (result.status === "opened")
				review.message.set(`Sent ${prName(link).split(" · ")[0]} to your browser. Nothing was recorded.`);
			else if (result.message) review.message.set(result.message);
		});
	};
	const summary = () => {
		const d = review.diff();
		return d ? `${changeLine(review)} · ${short(d.base)} → ${short(d.head)}` : "";
	};
	const shown = () => files().filter((f) => f.path === selected());
	return (
		<View class="flex-1">
			<View class="flex-row items-center gap-3 border-b border-border px-6 py-3">
				<LinkAction label={`‹ ${props.title}`} testID="code-review-back" onPress={props.back} />
				<Text role="header" class="text-base font-semibold text-foreground">
					Review code
				</Text>
				<Text class="min-w-0 flex-1 truncate text-xs text-faint">{summary()}</Text>
				<If when={(review.page()?.snapshots.length ?? 0) > 1}>
					<Picker
						testID="review-comparison"
						label="Comparison"
						placeholder="Comparison"
						items={(review.page()?.snapshots ?? []).map((id) => ({
							value: id,
							title: `Comparison ${id.slice(0, 8)}`,
						}))}
						value={review.diff()?.snapshotId ?? null}
						disabled={!props.fresh}
						onChange={(id) => void review.openDiff(id)}
					/>
				</If>
				<If when={props.mirror.view().webLinks && pr()}>
					<LinkAction label={`Open ${prShort(props.work)}`} testID="code-review-pr" onPress={openPr} />
				</If>
				<Menu
					open={menuOpen()}
					onOpenChange={menuOpen.set}
					align="end"
					agentLabel="More review commands"
					trigger={
						<MenuTrigger
							icon="more"
							testID="code-review-more"
							accessibilityLabel="More review commands"
							tooltip="More"
						/>
					}
				>
					<MenuItem
						label="Add to review queue"
						testID="review-select"
						disabled={review.disabled()}
						onSelect={() => void review.save("select")}
					/>
					<MenuItem
						label="Refresh private review"
						testID="review-refresh"
						disabled={review.busy()}
						onSelect={() => void review.read()}
					/>
					<If when={review.page()?.nextBefore}>
						<MenuItem
							label="Earlier comments"
							disabled={review.busy()}
							onSelect={() => void review.read(review.page()?.nextBefore ?? undefined)}
						/>
					</If>
					<If when={review.historyBefore() !== undefined}>
						<MenuItem label="Latest comments" disabled={review.busy()} onSelect={() => void review.read()} />
					</If>
				</Menu>
			</View>
			<If when={review.message() || review.pending().length > 0 || (review.diff()?.omissions.length ?? 0) > 0}>
				<View class="gap-2 border-b border-border px-6 py-2">
					<Each of={review.diff()?.omissions ?? []} key={(v) => v}>
						{(v) => <Text class="text-sm text-muted-foreground">{v()}</Text>}
					</Each>
					<ReviewStatus review={review} />
				</View>
			</If>
			<View class="min-h-0 flex-1 flex-row">
				<View class="w-72 gap-1 border-r border-border p-3">
					<Text class="px-3 pb-1 text-xs text-faint">Files</Text>
					<Each of={files()} key={(f) => f.path}>
						{(f) => (
							<FileRow
								file={f()}
								counts={review.counts()[files().indexOf(f())] ?? null}
								comments={commentsOn(f())}
								selected={selected() === f().path}
								onPress={() => selected.set(f().path)}
							/>
						)}
					</Each>
					<View class="pt-3">
						<EarlierDrafts work={props.work} />
					</View>
				</View>
				<View class="min-w-0 flex-1 gap-3 p-5">
					<If when={!props.fresh}>
						<Text class="text-sm text-muted-foreground">Pilot cannot show this result's code now.</Text>
					</If>
					<If when={props.fresh && !review.failed() && !review.page()}>
						<Text class="text-sm text-muted-foreground">Reading the saved code changes…</Text>
					</If>
					<If when={props.fresh && review.page()?.snapshots.length === 0}>
						<Text class="text-sm text-muted-foreground">
							No saved comparison matches this result. Pilot never shows your working copy instead.
						</Text>
					</If>
					<If
						when={
							props.fresh && (review.page()?.snapshots.length ?? 0) > 0 && !review.diff() && !review.message()
						}
					>
						<Text class="text-sm text-muted-foreground">Reading the comparison…</Text>
					</If>
					<If when={review.diff() && files().length === 0}>
						<Text class="text-sm text-muted-foreground">This comparison has no changed files.</Text>
					</If>
					<Each of={shown()} key={(f) => `${review.diff()?.snapshotId ?? ""}/${f.path}`}>
						{(f) => (
							<View class="min-h-0 flex-1 gap-3">
								<View class="flex-row items-baseline gap-2">
									<Text class="min-w-0 shrink truncate text-sm font-semibold text-foreground">
										{filePath(f())}
									</Text>
									<Text class="text-xs text-faint">{`${f().status} · ${index() + 1} of ${files().length} · J K next file`}</Text>
								</View>
								<If when={!f().reason} else={<Text class="text-sm text-muted-foreground">{f().reason}</Text>}>
									<View class="min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
										<FileDiff review={review} file={f()} snapshotId={review.diff()?.snapshotId ?? ""} />
									</View>
								</If>
							</View>
						)}
					</Each>
				</View>
			</View>
			<View class="flex-row items-center gap-3 border-t border-border px-6 py-3">
				<Text testID="review-count" class="min-w-0 flex-1 text-sm text-muted-foreground">
					{count() > 0
						? `${plural(count(), "comment")} · kept with this result, never posted to GitHub`
						: "No comments yet. Select lines to comment; comments are never posted to GitHub."}
				</Text>
				<Action
					label="Keep for later"
					testID="review-later"
					disabled={review.disabled()}
					onPress={() => void review.save("later")}
				/>
				<Action
					variant="primary"
					label={
						sending()
							? "Sending…"
							: count() > 0
								? `Send back with ${plural(count(), "comment")}`
								: "Send back with comments"
					}
					testID="review-send-back"
					disabled={count() === 0 || !sendable() || review.disabled()}
					onPress={() => void sendBack()}
				/>
			</View>
		</View>
	);
}
