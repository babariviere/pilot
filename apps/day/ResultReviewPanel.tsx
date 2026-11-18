import { cleanup, effect, signal, Text, untracked, View } from "nsh";
import type { DeliveredWork } from "./deliveryContract";
import { deliveryKey } from "./deliveryFeed";
import { backNotes, backOpen, setNote } from "./deliveryView";
import { keepField } from "./kept";
import {
	anchorLabel,
	connectedResultReview,
	forgetReviewDraft,
	keepReviewDraft,
	type ResultAnchor,
	type ResultDiff,
	type ResultReviewEntry,
	type ResultReviewPage,
	type ResultReviewSource,
	reviewDrafts,
	reviewKey,
	revisionContext,
	sameReviewAnchor,
} from "./resultReview";
import {
	Action,
	type DiffAnnotation,
	type DiffLineRange,
	Disclosure,
	Notice,
	ReviewDiff,
	SectionTitle,
	TextField,
} from "./ui";
import { setFor } from "./view";

/** Exact sources are one file per DiffView, so a selection cannot cross a file boundary. */
function CodeFile(props: {
	file: ResultDiff["files"][number];
	snapshotId: string;
	entries: ResultReviewEntry[];
	onAnchor: (anchor: ResultAnchor) => void;
}) {
	const selection = signal<DiffLineRange | null>(null);
	const annotations = (): DiffAnnotation[] =>
		props.entries.flatMap((e) => {
			const a = e.anchor;
			if (a.kind !== "lines" || a.snapshotId !== props.snapshotId) return [];
			const source = props.file[a.side];
			return source?.path === a.path && source.sha256 === a.blobSha256
				? [{ id: e.operationId, side: a.side === "before" ? "old" : "new", line: a.end - 1 }]
				: [];
		});
	const select = (range: DiffLineRange | null) => {
		if (!range || range.end - range.start >= 40) return;
		const side = range.side === "old" ? "before" : "after";
		const source = props.file[side];
		if (source)
			props.onAnchor({
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
			});
	};
	return (
		<View class="gap-2 border border-border rounded-lg">
			<View class="gap-1 p-3">
				<Text class="text-sm font-medium text-foreground">
					{props.file.before && props.file.after && props.file.before.path !== props.file.after.path
						? `${props.file.before.path} → ${props.file.after.path}`
						: props.file.path}
				</Text>
				<Text class="text-xs text-muted-foreground">{props.file.status}</Text>
			</View>
			<If
				when={props.file.reason}
				else={
					<View class="h-96">
						<ReviewDiff
							before={props.file.before?.text ?? ""}
							after={props.file.after?.text ?? ""}
							language={props.file.path}
							onSelection={selection.set}
							annotations={annotations()}
							onComment={select}
							renderAnnotation={(a) => (
								<View class="p-3 gap-1 bg-muted">
									<Text class="text-xs text-muted-foreground">
										Private comment · {a.side === "old" ? "old" : "new"} line {a.line + 1}
									</Text>
									<Text class="text-sm text-foreground">
										{props.entries.find((e) => e.operationId === a.id)?.body ?? ""}
									</Text>
								</View>
							)}
						/>
					</View>
				}
			>
				<Text class="p-3 text-sm text-muted-foreground">{props.file.reason}</Text>
			</If>
			<If when={!props.file.reason}>
				<View class="p-3 gap-1">
					<Text class="text-xs text-muted-foreground">
						Select line numbers (up to 40 lines), then comment. The text remains visible above.
					</Text>
					<Action
						label="Comment on selected lines…"
						disabled={!selection() || (selection()?.end ?? 0) - (selection()?.start ?? 0) >= 40}
						onPress={() => select(selection())}
					/>
				</View>
			</If>
		</View>
	);
}

export function ResultReviewPanel(props: {
	work: DeliveredWork;
	fresh: boolean;
	source?: ResultReviewSource;
	onLater?: () => void;
}) {
	const source = props.source ?? connectedResultReview();
	if (!source) return <Text class="text-sm text-muted-foreground">Private review is unavailable in this window.</Text>;
	const page = signal<ResultReviewPage | null>(null);
	const diff = signal<ResultDiff | null>(null);
	const selectedFile = signal("");
	const message = signal("");
	const pending = signal<string[]>([]);
	const busy = signal(false);
	const readable = signal(false);
	const historyBefore = signal<number | undefined>(undefined);
	const key = reviewKey(props.work);
	// Earlier-version drafts cannot change from this fixed-version panel. Read once, disclose in pages.
	const prefix = `${deliveryKey(props.work.subject)}#`;
	const earlierDrafts = Object.entries(reviewDrafts())
		.filter(([id, d]) => id !== key && id.startsWith(prefix) && d.body !== "")
		.map(([id, draft]) => ({ deliveryId: id.slice(prefix.length), draft }));
	const earlierOpen = signal(false),
		earlierPage = signal(0);
	const editor = signal(!!reviewDrafts()[key]?.body);
	let alive = true,
		readVersion = 0,
		diffVersion = 0;
	cleanup(() => {
		alive = false;
	});
	const draft = () =>
		reviewDrafts()[key] ?? { kind: "comment" as const, body: "", anchor: { kind: "general" as const } };
	const comments = () => page()?.entries.filter((e) => e.kind === "comment") ?? [];
	const disabled = () => !source || !readable() || !props.fresh || busy() || pending().length > 0;
	const field = keepField(
		`review:${key}`,
		() => `delivery/${deliveryKey(props.work.subject)}`,
		() => draft().body,
	);
	const read = async (before?: number) => {
		if (!source) return;
		const version = ++readVersion;
		try {
			const result = await source.read(props.work, before);
			if (!alive || version !== readVersion) return;
			if (result.data.deliveryId !== props.work.deliveryId) throw Error("stale");
			page.set(result.data);
			historyBefore.set(before);
			pending.set(result.pending);
			readable.set(true);
		} catch {
			if (alive && version === readVersion) {
				readable.set(false);
				diff.set(null);
				message.set("Private review could not be read. Saved comments stay; refresh before editing.");
			}
		}
	};
	const openDiff = async (snapshotId: string, anchor?: Extract<ResultAnchor, { kind: "lines" }>) => {
		if (!source || !props.fresh) return;
		const version = ++diffVersion;
		diff.set(null);
		try {
			const result = await source.diff(props.work, snapshotId);
			if (alive && version === diffVersion) {
				selectedFile.set(
					(anchor ? result.files.find((f) => f[anchor.side]?.path === anchor.path)?.path : undefined) ??
						result.files[0]?.path ??
						"",
				);
				diff.set(result);
				message.set("");
			}
		} catch {
			if (alive && version === diffVersion)
				message.set("This saved comparison is unavailable. Pilot did not substitute live files.");
		}
	};
	const start = (anchor: ResultAnchor, kind: "comment" | "note" = "comment") => {
		if (disabled()) return;
		if (draft().body && (JSON.stringify(draft().anchor) !== JSON.stringify(anchor) || draft().kind !== kind)) {
			editor.set(true);
			message.set("Save or cancel the current draft before changing its location.");
			return;
		}
		const body =
			kind === "note" && draft().kind !== "note"
				? (page()?.personalNote ??
					page()
						?.entries.filter((e) => e.kind === "note")
						.at(-1)?.body ??
					"")
				: draft().body;
		keepReviewDraft(key, { kind, anchor, body });
		editor.set(true);
		message.set("");
	};
	const save = async (kind: "comment" | "note" | "later" | "select" = draft().kind) => {
		if (disabled() || !source || !page()) return;
		busy.set(true);
		message.set("");
		const submitted = JSON.stringify(draft());
		const edit = {
			deliveryId: props.work.deliveryId!,
			expectedRevision: page()!.revision,
			kind,
			body: kind === "comment" || kind === "note" ? draft().body : "",
			anchor: kind === "comment" ? draft().anchor : { kind: "general" as const },
		};
		try {
			const result = await source.save(props.work, edit);
			if (!alive) return;
			const id = result.operationId;
			if (result.state === "rejected") {
				await read();
				message.set(
					"Not saved. The review changed or this save was refused. Your words stay; refresh before trying again.",
				);
				return;
			}
			if (
				result.state !== "saved" ||
				result.receipt?.operationId !== id ||
				result.receipt.body !== edit.body ||
				result.receipt.deliveryId !== edit.deliveryId ||
				result.receipt.kind !== edit.kind
			) {
				pending.set([id]);
				message.set("Save not confirmed. Check only reads its receipt; nothing will be resent.");
			} else {
				if ((kind === "comment" || kind === "note") && JSON.stringify(draft()) === submitted) {
					forgetReviewDraft(key);
					editor.set(false);
				}
				await read();
				if (kind === "later" && alive) props.onLater?.();
				else if (kind === "select") message.set("This older result was explicitly added to your review queue.");
			}
		} catch (error) {
			if (!alive) return;
			const id = (error as { operationId?: string }).operationId;
			if (id) {
				pending.set([id]);
				message.set("Save not confirmed. Your words stay. Check reads only; no resend.");
			} else message.set("The save could not be prepared. Nothing was sent; your words stay.");
		} finally {
			if (alive) busy.set(false);
		}
	};
	const check = async (id: string) => {
		if (!source || busy()) return;
		busy.set(true);
		try {
			const result = await source.check(id);
			if (!alive) return;
			if (result.state === "saved" && result.receipt?.operationId === id) {
				if (
					result.receipt.deliveryId === props.work.deliveryId &&
					result.receipt.body === draft().body &&
					result.receipt.kind === draft().kind &&
					sameReviewAnchor(result.receipt.anchor, draft().anchor)
				) {
					forgetReviewDraft(key);
					editor.set(false);
				}
				message.set("Saved. Nothing was resent.");
				await read();
				if (result.receipt.kind === "later" && result.receipt.deliveryId === props.work.deliveryId && alive)
					props.onLater?.();
			} else if (result.state === "rejected" && result.receipt?.operationId === id) {
				await read();
				message.set("Not saved. Your words stay; nothing was resent.");
			} else message.set("Still unconfirmed. Nothing was resent.");
		} catch {
			if (alive) message.set("Receipt unavailable. Nothing was resent.");
		} finally {
			if (alive) busy.set(false);
		}
	};
	const requestChanges = (entries: ResultReviewEntry[]) => {
		const context = revisionContext(entries);
		if (!context) {
			message.set("Save a comment first, or use Send back below for a general revision request.");
			return;
		}
		const resultKey = deliveryKey(props.work.subject);
		// Do not overwrite an unsent Send back note.
		const prior = backNotes()[resultKey] ?? "";
		const note = [prior, context].filter(Boolean).join("\n\n");
		if (new TextEncoder().encode(note).length > 8000) {
			message.set("These comments exceed the revision-request limit. Use one comment at a time.");
			return;
		}
		setNote(resultKey, note);
		setFor(backOpen, resultKey, true);
		message.set(
			"Revision request prepared in Send back below. Review it before sending. Personal notes are excluded.",
		);
	};
	effect(() => {
		const fresh = props.fresh;
		untracked(() => {
			if (!fresh) {
				readVersion++;
				diffVersion++;
				readable.set(false);
				diff.set(null);
				return;
			}
			void read().then(() => {
				const first = page()?.snapshots[0];
				if (alive && first && !diff()) void openDiff(first);
			});
		});
	});
	return (
		<View testID="result-review" class="gap-6">
			<View class="gap-3">
				<SectionTitle title="Code changes" />
				<Text class="text-sm text-muted-foreground">
					Saved sources for this result, never the current working copy.
				</Text>
				<If when={page()?.snapshots.length === 0}>
					<Text class="text-sm text-muted-foreground">
						No matching saved comparison was found in the bounded read. General and section comments remain
						available.
					</Text>
				</If>
				<Each of={page()?.snapshots ?? []} key={(id) => id}>
					{(id) => (
						<Action
							label={`Comparison ${id().slice(0, 8)}`}
							disabled={!props.fresh}
							onPress={() => void openDiff(id())}
						/>
					)}
				</Each>
				<If when={props.fresh && readable() && diff()}>
					<View class="gap-3">
						<Text class="text-xs text-muted-foreground">{`${diff()!.base} → ${diff()!.head} · ${diff()!.status}`}</Text>
						<Each of={diff()?.omissions ?? []} key={(v) => v}>
							{(v) => <Text class="text-sm text-muted-foreground">{v()}</Text>}
						</Each>
						<If when={(diff()?.files.length ?? 0) > 1}>
							<View class="flex-row flex-wrap gap-2">
								<Each of={diff()?.files ?? []} key={(f) => f.path}>
									{(f) => (
										<Action
											label={f().path}
											variant={selectedFile() === f().path ? "outline" : "plain"}
											onPress={() => selectedFile.set(f().path)}
										/>
									)}
								</Each>
							</View>
						</If>
						<Each
							of={diff()?.files.filter((f) => f.path === selectedFile()) ?? []}
							key={(f) => `${diff()?.snapshotId}:${f.path}`}
						>
							{(f) => (
								<CodeFile
									file={f()}
									snapshotId={diff()!.snapshotId}
									entries={comments()}
									onAnchor={(a) => start(a)}
								/>
							)}
						</Each>
					</View>
				</If>
			</View>
			<View class="gap-3">
				<SectionTitle title="Private comments" />
				<View class="flex-row gap-2">
					<If when={page()?.nextBefore}>
						<Action label="Earlier comments" disabled={busy()} onPress={() => void read(page()!.nextBefore!)} />
					</If>
					<If when={historyBefore() !== undefined}>
						<Action label="Latest comments" disabled={busy()} onPress={() => void read()} />
					</If>
				</View>
				<Text class="text-sm text-muted-foreground">
					Kept with this result. Never posted to GitHub. Saving a comment does not request changes.
				</Text>
				<Each of={comments()} key={(e) => e.operationId}>
					{(e) => (
						<View class="border-t border-border py-3 gap-2">
							<Text class="text-xs text-muted-foreground">{anchorLabel(e().anchor)}</Text>
							<Text class="text-xs text-muted-foreground">{`Original result ${e().deliveryId.slice(0, 12)}`}</Text>
							<If when={e().deliveryId !== props.work.deliveryId}>
								<Text class="text-sm text-muted-foreground">
									Earlier result version. Location uncertain in this version; the original anchor is kept.
								</Text>
							</If>
							<View selectable>
								<Text class="text-sm text-foreground">{e().body}</Text>
							</View>
							<If when={e().anchor.kind === "lines"}>
								<View selectable>
									<Text class="text-xs font-mono text-muted-foreground">
										{(e().anchor as Extract<ResultAnchor, { kind: "lines" }>).excerpt}
									</Text>
								</View>
								<Action
									label="Open original code context"
									disabled={!props.fresh}
									onPress={() =>
										void openDiff(
											(e().anchor as Extract<ResultAnchor, { kind: "lines" }>).snapshotId,
											e().anchor as Extract<ResultAnchor, { kind: "lines" }>,
										)
									}
								/>
							</If>
							<Action
								label="Use in revision request"
								disabled={disabled()}
								onPress={() => requestChanges([e()])}
							/>
						</View>
					)}
				</Each>
				<View class="flex-row flex-wrap gap-2">
					<Action label="General comment…" disabled={disabled()} onPress={() => start({ kind: "general" })} />
					<Each of={["changes", "checks", "risks", "remaining"] as const} key={(s) => s}>
						{(s) => (
							<Action
								label={`Comment on ${s()}…`}
								disabled={disabled()}
								onPress={() => start({ kind: "section", section: s() })}
							/>
						)}
					</Each>
					<Action label="My notes…" disabled={disabled()} onPress={() => start({ kind: "general" }, "note")} />
				</View>
				<If when={editor()}>
					<View class="gap-2">
						<Text class="text-sm font-medium text-foreground">
							{draft().kind === "note"
								? "My note. Only for me; not sent with revision requests."
								: anchorLabel(draft().anchor)}
						</Text>
						<If when={draft().anchor.kind === "lines"}>
							<View selectable>
								<Text class="text-xs font-mono text-muted-foreground">
									{(draft().anchor as Extract<ResultAnchor, { kind: "lines" }>).excerpt}
								</Text>
							</View>
						</If>
						<TextField
							ref={field.ref}
							onFocus={field.focus}
							onSelectionChange={field.select}
							testID="review-body"
							accessibilityLabel="Private review text"
							multiline
							rows={4}
							value={draft().body}
							disabled={busy() || pending().length > 0}
							onChange={({ value }) => keepReviewDraft(key, { ...draft(), body: value })}
						/>
						<View class="flex-row gap-2">
							<Action
								label={busy() ? "Saving…" : "Save privately"}
								variant="primary"
								disabled={
									disabled() ||
									(draft().kind === "comment" && !draft().body.trim()) ||
									new TextEncoder().encode(draft().body).length > 8000
								}
								onPress={() => void save()}
							/>
							<Action label="Close editor" disabled={busy()} onPress={() => editor.set(false)} />
							<Action
								label="Discard draft"
								disabled={busy() || pending().length > 0}
								onPress={() => {
									forgetReviewDraft(key);
									editor.set(false);
								}}
							/>
						</View>
					</View>
				</If>
				<If when={page()?.personalNote || page()?.entries.some((e) => e.kind === "note")}>
					<View selectable class="gap-1 bg-muted rounded-lg p-3">
						<Text class="text-xs text-muted-foreground">My saved note · only for me</Text>
						<Text class="text-sm text-foreground">
							{page()?.personalNote ??
								page()
									?.entries.filter((e) => e.kind === "note")
									.at(-1)?.body ??
								""}
						</Text>
					</View>
				</If>
				<If when={earlierDrafts.length > 0}>
					<Disclosure
						label={`Earlier unsent drafts (${earlierDrafts.length})`}
						testID="review-earlier-drafts"
						open={earlierOpen()}
						onToggle={() => earlierOpen.set(!earlierOpen())}
					>
						<Text class="text-xs text-muted-foreground">
							Read-only original words. Nothing was moved to this result or sent.
						</Text>
						<Each of={earlierDrafts.slice(earlierPage(), earlierPage() + 20)} key={(d) => d.deliveryId}>
							{(d) => (
								<View selectable class="gap-1 border-t border-border pt-3">
									<Text class="text-xs text-muted-foreground">{`Unsent · original result ${d().deliveryId.slice(0, 12)} · ${d().draft.kind === "note" ? "My note" : anchorLabel(d().draft.anchor)}`}</Text>
									<If when={d().draft.anchor.kind === "lines"}>
										<View class="gap-1">
											<Text class="text-xs text-muted-foreground">
												Location uncertain in this result. Original anchor kept.
											</Text>
											<Text class="text-xs font-mono text-muted-foreground">
												{(d().draft.anchor as Extract<ResultAnchor, { kind: "lines" }>).excerpt}
											</Text>
										</View>
									</If>
									<Text class="text-sm text-foreground">{d().draft.body}</Text>
								</View>
							)}
						</Each>
						<View class="flex-row gap-2">
							<If when={earlierPage() > 0}>
								<Action label="Newer drafts" onPress={() => earlierPage.set(Math.max(0, earlierPage() - 20))} />
							</If>
							<If when={earlierPage() + 20 < earlierDrafts.length}>
								<Action label="Older drafts" onPress={() => earlierPage.set(earlierPage() + 20)} />
							</If>
						</View>
					</Disclosure>
				</If>
				<View class="flex-row flex-wrap gap-2">
					<Action
						label="Prepare revision request"
						disabled={disabled()}
						onPress={() => requestChanges(comments().filter((e) => e.deliveryId === props.work.deliveryId))}
					/>
					<Action label="Later" disabled={disabled()} onPress={() => void save("later")} />
					<Action label="Add to review queue" disabled={disabled()} onPress={() => void save("select")} />
					<Action label="Refresh private review" disabled={busy()} onPress={() => void read()} />
				</View>
			</View>
			<Each of={pending()} key={(id) => id}>
				{(id) => (
					<Notice
						text="Private save not confirmed"
						detail="Only this result is held. Independent work continues."
						action={<Action label="Check saved comment" disabled={busy()} onPress={() => void check(id())} />}
					/>
				)}
			</Each>
			<If when={message()}>
				<Text class="text-sm text-muted-foreground">{message()}</Text>
			</If>
		</View>
	);
}
