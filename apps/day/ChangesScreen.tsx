// Changes: finished work Pilot kept a snapshot of. The list groups kept
// changes by their review request; a row reopens one exact snapshot with
// its read-only diff and its saved history. The snapshot is history, the
// review request is current at the read, a landing is the last check.
// Reopening approves nothing. Later and Bring back are intents that name
// the request and revision shown; Rust fences and sends them. Read again
// only reads: it sends nothing and settles no unconfirmed answer.
import { computed, keymap, Scroll, View } from "nsh";
import type { ChangePage, ChangeRow } from "pilot-day/native";
import type { Changes } from "./changeFeed";
import {
	backFromChanges,
	changeMessages,
	changesRoute,
	changeTabs,
	detailsOpen,
	listMessage,
	showChange,
} from "./changesView";
import {
	attentionMark,
	attentionWord,
	dispositionWord,
	filesLine,
	fileWord,
	landingCheck,
	landingLine,
	landingShort,
	requestLine,
} from "./changeWords";
import { keepRead } from "./freshness";
import { keepScroll } from "./kept";
import {
	Block,
	Body,
	Button,
	Caption,
	Column,
	DiffCounts,
	DiffSplit,
	EmptyLine,
	Fact,
	Facts,
	Link,
	type MarkKind,
	Notice,
	Num,
	Page,
	PageHead,
	Panel,
	PatchDiff,
	Row,
	Rows,
	Section,
	State,
	Tab,
	Tabs,
} from "./ui";
import { setFor } from "./view";

function say(id: string, message: string) {
	setFor(changeMessages, id, message);
}

/** Opens one kept snapshot and asks Rust to read it exactly. */
async function openChange(changes: Changes, snapshotId: string) {
	showChange(snapshotId);
	say(snapshotId, "");
	const outcome = await changes.feed.open({ snapshotId });
	if (outcome.status !== "accepted") say(snapshotId, outcome.message);
}

/** Puts the review off, named with the request and revision shown. Nothing is approved. */
async function later(changes: Changes, page: ChangePage) {
	const request = page.request;
	if (request?.attention !== "waiting" || page.row.delivery !== "idle") return;
	const id = page.identity.snapshotId;
	say(id, "");
	const outcome = await changes.feed.later({
		snapshotId: id,
		requestId: request.requestId,
		revision: request.revision,
	});
	say(id, outcome.message);
}

/** Brings a review the user put off back, named with the request and revision shown. */
async function bringBack(changes: Changes, page: ChangePage) {
	const request = page.request;
	if (request?.attention !== "later" || page.row.delivery !== "idle") return;
	const id = page.identity.snapshotId;
	say(id, "");
	const outcome = await changes.feed.bringBack({
		snapshotId: id,
		requestId: request.requestId,
		revision: request.revision,
	});
	say(id, outcome.message);
}

/** Reads whether an unconfirmed Later or Bring back landed. Never resends. */
async function check(changes: Changes, page: ChangePage) {
	if (page.row.delivery !== "unknown") return;
	const id = page.identity.snapshotId;
	say(id, "");
	const outcome = await changes.feed.checkAttention({ snapshotId: id });
	say(id, outcome.message);
}

/** Reads the list again. It sends nothing; the list says what the read found. */
function readAgain(changes: Changes) {
	listMessage.set(changes.feed.refresh().message);
}

function rowMeta(row: ChangeRow): string {
	const kept =
		row.completeness === "partial" ? "partly kept" : row.completeness === "unavailable" ? "bytes not kept" : "";
	return [
		row.chat && row.chat !== row.title ? row.chat : "",
		`kept ${row.captured}`,
		row.head,
		kept,
		landingShort(row),
	]
		.filter(Boolean)
		.join(" · ");
}

/** A change's mark: its attention mark (`changeWords.ts`). */
function changeMark(row: ChangeRow): MarkKind {
	return attentionMark(row);
}

/** A change's state word: Unconfirmed while an answer is not known, else its review request's state. */
function changeWord(row: ChangeRow): string {
	return row.delivery === "unknown" ? "Unconfirmed" : attentionWord(row.attention);
}

/** Whether a change waits for the user: a review to do, or an answer to check. */
function waits(row: ChangeRow): boolean {
	return row.attention === "waiting" || row.delivery === "unknown";
}

function ChangeLine(props: { changes: Changes; row: ChangeRow }) {
	return (
		<Row
			testID={`change-${props.row.snapshotId}`}
			mark={changeMark(props.row)}
			title={props.row.title}
			meta={rowMeta(props.row)}
			state={changeWord(props.row)}
			stateTone={waits(props.row) ? "needs" : "quiet"}
			accessibilityLabel={`${props.row.title}, ${attentionWord(props.row.attention)}. Reopen the kept change.`}
			onPress={() => openChange(props.changes, props.row.snapshotId)}
		/>
	);
}

function Group(props: { changes: Changes; title: string; rows: ChangeRow[]; empty?: string }) {
	return (
		<Section title={props.title} count={props.rows.length}>
			<If when={props.rows.length === 0 && props.empty}>
				<EmptyLine text={props.empty ?? ""} />
			</If>
			<Rows>
				<Each of={props.rows} key={(r) => r.snapshotId}>
					{(r) => <ChangeLine changes={props.changes} row={r()} />}
				</Each>
			</Rows>
		</Section>
	);
}

function count(n: number, one: string, many: string): string {
	return n === 1 ? one : many.replace("#", String(n));
}

/** The list of kept changes. */
function ChangeList(props: { changes: Changes; onBackFromJump?: () => boolean }) {
	const list = () => props.changes.list();
	const total = () => list().waiting.length + list().later.length + list().earlier.length;
	const available = () => list().availability === "available";
	keymap.bind("escape", () => {
		if (!props.onBackFromJump?.()) backFromChanges();
	});
	const more = () => listMessage.set(props.changes.feed.more().message);
	// Pilot reads the list again on its own while it cannot show it, and when the window comes back.
	const reads = keepRead(
		async () => readAgain(props.changes),
		() => list().availability !== "available",
		() => list().availability === "available",
	);
	const scroll = keepScroll("changes");
	return (
		<Scroll class="flex-1" contentOffset={scroll.contentOffset} scrollEventThrottle={100} onScroll={scroll.onScroll}>
			<Page>
				<PageHead
					title="Changes"
					text="Finished work Pilot kept a snapshot of. Review it now or later, or reopen it to see what was said and whether it landed."
				>
					<Caption tone="faint">Only kept snapshots show here, not every change in the project.</Caption>
					<If when={listMessage()}>
						<Caption testID="list-message">{listMessage()}</Caption>
					</If>
				</PageHead>
				<Panel
					testID="changes-panel"
					notice={
						<>
							<If when={!available()}>
								<Notice
									testID="changes-unavailable"
									placement="panel"
									text="Pilot cannot show kept changes here."
									detail={[
										list().reason,
										list().more
											? "There are more kept changes than one read holds, so Pilot shows none of them."
											: "",
									]
										.filter(Boolean)
										.join(" ")}
									action={
										<If when={reads.warn()}>
											<Link
												label="Try now"
												accessibilityLabel="Read kept changes again. This sends nothing."
												onPress={() => void reads.now()}
											/>
										</If>
									}
								/>
							</If>
							<If when={available() && list().failed > 0}>
								<Notice
									kind="failed"
									placement="panel"
									text={`Pilot could not keep ${count(list().failed, "one change", "# changes")}.`}
								/>
							</If>
						</>
					}
				>
					<Column>
						<If
							when={available()}
							else={
								<Section title="Kept changes">
									<EmptyLine text="This is not the same as having none." />
								</Section>
							}
						>
							<If
								when={total() > 0}
								else={
									<Section title="Kept changes">
										<EmptyLine text="No kept changes yet. Pilot keeps a snapshot when an agent finishes a change." />
									</Section>
								}
							>
								<Group
									changes={props.changes}
									title="To review"
									rows={list().waiting}
									empty="Nothing waits for your review."
								/>
								<If when={list().later.length > 0}>
									<Group changes={props.changes} title="Later" rows={list().later} />
								</If>
								<If when={list().earlier.length > 0}>
									<Group changes={props.changes} title="Earlier" rows={list().earlier} />
								</If>
							</If>
							{/* What the list does not show, said under it; never counted as none. */}
							<If when={list().unreadable > 0}>
								<EmptyLine
									text={`${count(list().unreadable, "One kept change", "# kept changes")} could not be read here. Not shown, and not counted as none.`}
								/>
							</If>
							<If when={list().pending > 0}>
								<EmptyLine
									text={`${count(list().pending, "One change is", "# changes are")} still being kept.`}
								/>
							</If>
							<If when={list().more}>
								<Block>
									<Link label="Read more" onPress={more} />
								</Block>
							</If>
						</If>
					</Column>
				</Panel>
			</Page>
		</Scroll>
	);
}

/** The snapshot as kept: when, which commits, what was not kept, and whether a newer one exists. */
function Kept(props: { changes: Changes; page: ChangePage }) {
	const identity = () => props.page.identity;
	return (
		<View testID="kept" class="gap-0.5">
			<Body>{`The snapshot Pilot kept on ${identity().capturedAt}. The files may have changed since.`}</Body>
			<Num>
				{`Head ${identity().head.slice(0, 8)} on ${identity().base.slice(0, 8)} · ${identity().scope} · ${identity().source}`}
			</Num>
			<Each of={props.page.omissions} key={(o) => o}>
				{(o) => <Caption>{`Not kept: ${o()}`}</Caption>}
			</Each>
			<If when={props.page.newer}>
				<View class="flex-row flex-wrap items-baseline gap-x-1.5">
					<Caption>A newer snapshot of this change is kept.</Caption>
					<Link
						label="Open the newer snapshot"
						testID="newer"
						onPress={() => openChange(props.changes, props.page.newer ?? "")}
					/>
				</View>
			</If>
		</View>
	);
}

/** The review request now and the last landing check. What the user can do sits beside the title (`NowActions`). */
function Now(props: { page: ChangePage }) {
	const row = () => props.page.row;
	const id = () => props.page.identity.snapshotId;
	return (
		<View testID="now" class="gap-0.5">
			<Body>{requestLine(row())}</Body>
			<Body tone="muted">{landingLine(row())}</Body>
			<Caption tone="faint">
				{`Read ${props.page.read}. Reopening approves nothing; an earlier approval stays in History and does not count now.`}
			</Caption>
			<If when={changeMessages()[id()]}>
				<Body role="alert" tone="needs">
					{changeMessages()[id()] ?? ""}
				</Body>
			</If>
		</View>
	);
}

/** Later, Bring back or Check again: the one thing the user can do with this review now. */
function NowActions(props: { changes: Changes; page: ChangePage }) {
	const row = () => props.page.row;
	const idle = () => row().delivery === "idle";
	const attention = () => props.page.request?.attention;
	return (
		<>
			<If when={idle() && attention() === "waiting"}>
				<Button label="Later" shortcut="L" onPress={() => later(props.changes, props.page)} />
			</If>
			<If when={idle() && attention() === "later"}>
				<Button label="Bring back" onPress={() => bringBack(props.changes, props.page)} />
			</If>
			<If when={row().delivery === "unknown" || row().delivery === "checking"}>
				<Button
					label="Check again"
					disabled={row().delivery === "checking"}
					onPress={() => check(props.changes, props.page)}
				/>
			</If>
		</>
	);
}

/** A file's folder, or "" at the top of the repository. */
function folderOf(path: string): string {
	const at = path.lastIndexOf("/");
	return at < 0 ? "" : path.slice(0, at);
}

/** The changed files as rows: name, folder, how it changed and why it shows no lines, and its line counts. */
function Files(props: { page: ChangePage }) {
	return (
		<Section title="Files" count={props.page.files.length} footnote={filesLine(props.page.files)}>
			<Rows>
				<Each of={props.page.files} key={(f) => f.name}>
					{(f) => (
						<Row
							testID={`change-file-${f().name}`}
							title={f().name.split("/").pop() ?? f().name}
							meta={[folderOf(f().name), fileWord(f().status), f().note].filter(Boolean).join(" · ")}
							trailing={
								<If when={!f().binary} else={<Num>binary</Num>}>
									<DiffCounts added={f().added} removed={f().removed} />
								</If>
							}
						/>
					)}
				</Each>
			</Rows>
		</Section>
	);
}

/** The exact kept patch, read-only, beside its files. The diff fills the rest of the panel and scrolls its own rows. */
function Diff(props: { page: ChangePage }) {
	const empty = () =>
		props.page.diffNote ||
		(props.page.files.length === 0 ? "No file changed in this snapshot." : "No lines to show.");
	return (
		<DiffSplit
			list={props.page.files.length > 0}
			files={<Files page={props.page} />}
			diff={
				<If
					when={props.page.patch}
					else={
						<Block>
							<Body tone="muted">{empty()}</Body>
						</Block>
					}
				>
					<PatchDiff testID="diff" patch={props.page.patch} />
				</If>
			}
		/>
	);
}

/** What was saved about this snapshot: reviews, landing checks, requests and its identity. */
function History(props: { page: ChangePage }) {
	const p = () => props.page;
	const id = () => p().identity.snapshotId;
	return (
		<Scroll class="min-h-0 flex-1">
			<Column testID="history">
				<Section
					title="Reviews"
					count={p().reviews.length}
					footnote={
						p().reviews.some((r) => r.disposition === "approve")
							? "An approval here is of this snapshot, at that time. It does not count now."
							: undefined
					}
				>
					<If when={p().reviews.length === 0}>
						<EmptyLine text="No saved review of this snapshot." />
					</If>
					<Rows>
						<Each of={p().reviews} key={(r) => r.id}>
							{(r) => (
								<Row
									title={dispositionWord(r().disposition)}
									meta={r().body}
									wrap
									selectable
									trailing={<Num>{r().age}</Num>}
								/>
							)}
						</Each>
					</Rows>
					<If when={p().reviewsMore}>
						<EmptyLine text="Later reviews are not shown here." />
					</If>
				</Section>
				<Section title="Landing checks" count={p().landings.length}>
					<If when={p().landings.length === 0}>
						<EmptyLine text="No landing check saved." />
					</If>
					<Rows>
						<Each of={p().landings} key={(l) => l.id}>
							{(l) => <Row title={landingCheck(l())} wrap />}
						</Each>
					</Rows>
					<If when={p().landingsMore}>
						<EmptyLine text="Later checks are not shown here." />
					</If>
				</Section>
				<Section title="Review requests" count={p().requests.length}>
					<If when={p().requests.length === 0}>
						<EmptyLine text="No review request." />
					</If>
					<Rows>
						<Each of={p().requests} key={(r) => r.requestId}>
							{(r) => <Row title={`${attentionWord(r().attention)} · revision ${r().revision} · ${r().age}`} />}
						</Each>
					</Rows>
					<If when={p().requestsMore}>
						<EmptyLine text="More requests exist than this read holds." />
					</If>
				</Section>
				<If when={p().reported.length > 0}>
					<Section
						title="Agent reports"
						count={p().reported.length}
						footnote="An agent's report, not proof that it landed."
					>
						<Rows>
							<Each of={p().reported} key={(r) => `${r.task} ${r.commit}`}>
								{(r) => <Row title={`Task ${r().task} reported ${r().commit} · ${r().age}`} />}
							</Each>
						</Rows>
					</Section>
				</If>
				<Section
					title="Snapshot"
					action={
						<Link
							label={detailsOpen()[id()] ? "Hide snapshot details" : "Snapshot details"}
							onPress={() => setFor(detailsOpen, id(), !detailsOpen()[id()])}
						/>
					}
				>
					<If when={detailsOpen()[id()]}>
						<Block>
							<Facts testID="details">
								<Fact label="Snapshot">{p().identity.snapshotId || "None"}</Fact>
								<Fact label="Sequence">{String(p().identity.sequence)}</Fact>
								<Fact label="Change">{p().identity.changeId || "None"}</Fact>
								<Fact label="Base">{p().identity.base || "None"}</Fact>
								<Fact label="Head">{p().identity.head || "None"}</Fact>
								<Fact label="Scope">{p().identity.scope || "None"}</Fact>
								<Fact label="Source">{p().identity.source || "None"}</Fact>
								<Fact label="Patch SHA-256">{p().identity.diff || "None"}</Fact>
								<Fact label="Kept">{p().identity.capturedAt || "None"}</Fact>
							</Facts>
						</Block>
					</If>
				</Section>
			</Column>
		</Scroll>
	);
}

function ChangeView(props: { changes: Changes; page: ChangePage }) {
	const id = () => props.page.identity.snapshotId;
	const tab = () => changeTabs()[id()] ?? "diff";
	// The snapshot's facts stay put above the panel: scrolling, selecting or
	// focusing in the diff never moves or hides them.
	return (
		<>
			<PageHead
				title={props.page.row.title}
				state={<State kind={changeMark(props.page.row)} label={changeWord(props.page.row)} />}
				actions={<NowActions changes={props.changes} page={props.page} />}
			>
				<Now page={props.page} />
				<Kept changes={props.changes} page={props.page} />
			</PageHead>
			<Panel
				fill
				testID="change-panel"
				tabs={
					<Tabs>
						<Tab label="Diff" selected={tab() === "diff"} onPress={() => setFor(changeTabs, id(), "diff")} />
						<Tab
							label="History"
							selected={tab() === "history"}
							onPress={() => setFor(changeTabs, id(), "history")}
						/>
					</Tabs>
				}
			>
				<If when={tab() === "diff"} else={<History page={props.page} />}>
					<Diff page={props.page} />
				</If>
			</Panel>
		</>
	);
}

/** A reopened snapshot that cannot show now: why, and a read of that same snapshot again. */
function NotShown(props: { changes: Changes; snapshotId: string }) {
	const message = () => changeMessages()[props.snapshotId] ?? "";
	const off = () => props.changes.list().availability !== "available";
	// Pilot reads this snapshot again on its own while it cannot show it.
	const reads = keepRead(
		async () => openChange(props.changes, props.snapshotId),
		() => !!message() || off(),
		() => false,
	);
	return (
		<PageHead
			testID="change-not-shown"
			title={message() || (off() ? "Pilot cannot show this kept snapshot now." : "Reading the kept snapshot.")}
			text={off() ? props.changes.list().reason : undefined}
			actions={
				<If when={reads.warn()}>
					<Button
						label="Try now"
						accessibilityLabel="Read this kept snapshot again. This sends nothing."
						onPress={() => void reads.now()}
					/>
				</If>
			}
		/>
	);
}

/** One kept snapshot, read again on every change. */
function ChangeScreen(props: { changes: Changes; snapshotId: string }) {
	const page = computed(() => {
		props.changes.list();
		return props.changes.feed.change(props.snapshotId) ?? null;
	});
	keymap.bind({
		escape: backFromChanges,
		l: () => {
			const p = page();
			if (p) later(props.changes, p);
		},
	});
	return (
		<Page fill>
			<If when={page()} else={<NotShown changes={props.changes} snapshotId={props.snapshotId} />}>
				<Each of={page() ? [page() as ChangePage] : []} key={(p) => p.identity.snapshotId}>
					{(p) => <ChangeView changes={props.changes} page={p()} />}
				</Each>
			</If>
		</Page>
	);
}

/** The Changes list, or the kept snapshot the user reopened. */
export function ChangesScreen(props: { changes: Changes; onBackFromJump?: () => boolean }) {
	const at = () => changesRoute();
	return (
		<If
			when={at()?.kind === "change"}
			else={<ChangeList changes={props.changes} onBackFromJump={props.onBackFromJump} />}
		>
			<Each of={at()?.kind === "change" ? [(at() as { snapshotId: string }).snapshotId] : []} key={(id) => id}>
				{(id) => <ChangeScreen changes={props.changes} snapshotId={id()} />}
			</Each>
		</If>
	);
}
