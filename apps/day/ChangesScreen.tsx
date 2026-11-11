// Changes: finished work Pilot kept a snapshot of. The list groups kept
// changes by their review request; a row reopens one exact snapshot with
// its read-only diff and its saved history. The snapshot is history, the
// review request is current at the read, a landing is the last check.
// Reopening approves nothing. Later and Bring back are intents that name
// the request and revision shown; Rust fences and sends them. Read again
// only reads: it sends nothing and settles no unconfirmed answer.
import { computed, keymap, Scroll, Text, View } from "nsh";
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
import { keepScroll } from "./kept";
import { TopBar } from "./TodayScreen";
import { Action, InlineAction, Mark, PatchDiff, RowLink, SectionTitle, TabItem, TabRow } from "./ui";
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

/** A change's state: its mark and words. */
function ChangeStatus(props: { row: ChangeRow }) {
	return (
		<View class="flex-row items-center gap-1.5">
			<Mark kind={attentionMark(props.row)} />
			<Text
				class="text-xs"
				classList={{
					"text-needs-ink": props.row.attention === "waiting" || props.row.delivery === "unknown",
					"text-muted-foreground": props.row.attention !== "waiting" && props.row.delivery !== "unknown",
				}}
			>
				{props.row.delivery === "unknown" ? "Unconfirmed" : attentionWord(props.row.attention)}
			</Text>
		</View>
	);
}

function Row(props: { changes: Changes; row: ChangeRow }) {
	return (
		<View class="gap-1 border-t border-border py-3">
			<RowLink
				testID={`change-${props.row.snapshotId}`}
				title={props.row.title}
				accessibilityLabel={`${props.row.title}, ${attentionWord(props.row.attention)}. Reopen the kept change.`}
				onPress={() => openChange(props.changes, props.row.snapshotId)}
			>
				<ChangeStatus row={props.row} />
			</RowLink>
			<Text class="text-xs text-faint">{rowMeta(props.row)}</Text>
		</View>
	);
}

function Group(props: { changes: Changes; title: string; rows: ChangeRow[]; empty?: string }) {
	return (
		<View class="gap-1">
			<View class="pb-1">
				<SectionTitle title={props.title} count={props.rows.length} />
			</View>
			<If when={props.rows.length === 0 && props.empty}>
				<Text class="text-sm text-muted-foreground">{props.empty ?? ""}</Text>
			</If>
			<Each of={props.rows} key={(r) => r.snapshotId}>
				{(r) => <Row changes={props.changes} row={r()} />}
			</Each>
		</View>
	);
}

function count(n: number, one: string, many: string): string {
	return n === 1 ? one : many.replace("#", String(n));
}

/** The list of kept changes. */
function ChangeList(props: { changes: Changes }) {
	const list = () => props.changes.list();
	const total = () => list().waiting.length + list().later.length + list().earlier.length;
	keymap.bind("escape", backFromChanges);
	const more = () => listMessage.set(props.changes.feed.more().message);
	const scroll = keepScroll("changes");
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-6">
				<TopBar />
				<View class="flex-row items-center">
					<Action label="‹ Today" accessibilityLabel="Back to Today" onPress={backFromChanges} />
					<View class="flex-1" />
					<If when={list().availability === "available"}>
						<Action
							label="Read again"
							accessibilityLabel="Read kept changes again. This sends nothing."
							onPress={() => readAgain(props.changes)}
						/>
					</If>
				</View>
				<View class="gap-2">
					<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
						Changes
					</Text>
					<Text class="text-base leading-relaxed text-muted-foreground">
						Finished work Pilot kept a snapshot of. Review it now or later, or reopen it to see what was said and
						whether it landed.
					</Text>
					<Text class="text-xs text-faint">Only kept snapshots show here, not every change in the project.</Text>
				</View>
				<If when={listMessage()}>
					<Text testID="list-message" class="text-xs text-muted-foreground">
						{listMessage()}
					</Text>
				</If>
				<If
					when={list().availability === "available"}
					else={
						<View testID="changes-unavailable" class="gap-1.5 rounded-xl bg-muted px-4 py-3">
							<View class="flex-row items-center gap-2.5">
								<Mark kind="unknown" />
								<Text class="flex-1 text-sm text-foreground">Pilot cannot show kept changes here.</Text>
							</View>
							<Text class="text-sm text-muted-foreground">{list().reason}</Text>
							<If when={list().more}>
								<Text class="text-sm text-muted-foreground">
									There are more kept changes than one read holds, so Pilot shows none of them.
								</Text>
							</If>
							<Text class="text-xs text-faint">This is not the same as having none.</Text>
							<View class="flex-row pt-1">
								<Action
									label="Read again"
									accessibilityLabel="Read kept changes again. This sends nothing."
									onPress={() => readAgain(props.changes)}
								/>
							</View>
						</View>
					}
				>
					<View class="gap-8">
						<If when={list().unreadable + list().pending + list().failed > 0}>
							<View class="gap-1">
								<If when={list().unreadable > 0}>
									<Text class="text-xs text-muted-foreground">
										{`${count(list().unreadable, "One kept change", "# kept changes")} could not be read here. Not shown, and not counted as none.`}
									</Text>
								</If>
								<If when={list().pending > 0}>
									<Text class="text-xs text-muted-foreground">
										{`${count(list().pending, "One change is", "# changes are")} still being kept.`}
									</Text>
								</If>
								<If when={list().failed > 0}>
									<Text class="text-xs text-needs-ink">
										{`Pilot could not keep ${count(list().failed, "one change", "# changes")}.`}
									</Text>
								</If>
							</View>
						</If>
						<If
							when={total() > 0}
							else={
								<Text class="text-base text-foreground">
									No kept changes yet. Pilot keeps a snapshot when an agent finishes a change.
								</Text>
							}
						>
							<View class="gap-8">
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
							</View>
						</If>
						<If when={list().more}>
							<View class="flex-row">
								<Action label="Read more" onPress={more} />
							</View>
						</If>
					</View>
				</If>
			</View>
		</Scroll>
	);
}

/** The snapshot as kept: when, which commits, and whether a newer one exists. */
function Kept(props: { changes: Changes; page: ChangePage }) {
	const identity = () => props.page.identity;
	return (
		<View testID="kept" class="gap-1.5 rounded-xl bg-muted px-4 py-3">
			<Text class="text-sm text-foreground">
				{`The snapshot Pilot kept on ${identity().capturedAt}. The files may have changed since.`}
			</Text>
			<Text class="text-xs text-muted-foreground">
				{`Head ${identity().head.slice(0, 8)} on ${identity().base.slice(0, 8)} · ${identity().scope} · ${identity().source}`}
			</Text>
			<Each of={props.page.omissions} key={(o) => o}>
				{(o) => <Text class="text-xs text-needs-ink">{`Not kept: ${o()}`}</Text>}
			</Each>
			<If when={props.page.newer}>
				<View class="flex-row flex-wrap items-baseline gap-x-1.5">
					<Text class="text-sm text-muted-foreground">A newer snapshot of this change is kept.</Text>
					<InlineAction
						label="Open the newer snapshot"
						testID="newer"
						onPress={() => openChange(props.changes, props.page.newer ?? "")}
					/>
				</View>
			</If>
		</View>
	);
}

/** The review request now, the last landing check, and what the user can do. */
function Now(props: { changes: Changes; page: ChangePage }) {
	const row = () => props.page.row;
	const id = () => props.page.identity.snapshotId;
	const idle = () => row().delivery === "idle";
	const attention = () => props.page.request?.attention;
	return (
		<View testID="now" class="gap-2">
			<Text class="text-sm text-foreground">{requestLine(row())}</Text>
			<Text class="text-sm text-muted-foreground">{landingLine(row())}</Text>
			<Text class="text-xs text-faint">
				{`Read ${props.page.read}. Reopening approves nothing; an earlier approval stays in History and does not count now.`}
			</Text>
			<If when={changeMessages()[id()]}>
				<Text role="alert" class="text-sm text-needs-ink">
					{changeMessages()[id()] ?? ""}
				</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<If when={idle() && attention() === "waiting"}>
					<Action label="Later" shortcut="L" onPress={() => later(props.changes, props.page)} />
				</If>
				<If when={idle() && attention() === "later"}>
					<Action label="Bring back" onPress={() => bringBack(props.changes, props.page)} />
				</If>
				<If when={row().delivery === "unknown" || row().delivery === "checking"}>
					<Action
						primary
						label="Check again"
						disabled={row().delivery === "checking"}
						onPress={() => check(props.changes, props.page)}
					/>
				</If>
			</View>
		</View>
	);
}

/** The exact kept patch, read-only, with what it does not show. The diff fills the rest of the page. */
function Diff(props: { page: ChangePage }) {
	const files = () => props.page.files;
	const noted = () => files().filter((f) => f.note);
	const empty = () =>
		props.page.diffNote || (files().length === 0 ? "No file changed in this snapshot." : "No lines to show.");
	return (
		<View class="min-h-0 flex-1 gap-2">
			<Each of={noted()} key={(f) => f.name}>
				{(f) => (
					<Text class="text-xs text-muted-foreground">{`${fileWord(f().status)} ${f().name}: ${f().note}`}</Text>
				)}
			</Each>
			<If when={props.page.patch} else={<Text class="text-sm text-muted-foreground">{empty()}</Text>}>
				<PatchDiff testID="diff" patch={props.page.patch} />
			</If>
		</View>
	);
}

function Detail(props: { label: string; value: string }) {
	return (
		<View class="flex-row flex-wrap gap-x-3 py-0.5">
			<Text class="w-32 text-xs text-faint">{props.label}</Text>
			<Text class="flex-1 font-mono text-xs text-foreground">{props.value || "None"}</Text>
		</View>
	);
}

/** What was saved about this snapshot: reviews, landing checks, requests and its identity. */
function History(props: { page: ChangePage }) {
	const p = () => props.page;
	const id = () => p().identity.snapshotId;
	return (
		<Scroll class="flex-1">
			<View testID="history" class="gap-8 pb-12">
				<View class="gap-2">
					<SectionTitle title="Reviews" count={p().reviews.length} />
					<If when={p().reviews.length === 0}>
						<Text class="text-sm text-muted-foreground">No saved review of this snapshot.</Text>
					</If>
					<Each of={p().reviews} key={(r) => r.id}>
						{(r) => (
							<View class="gap-1 border-t border-border py-2.5">
								<View class="flex-row items-baseline gap-2">
									<Text class="flex-1 text-sm font-medium text-foreground">
										{dispositionWord(r().disposition)}
									</Text>
									<Text class="text-xs text-faint">{r().age}</Text>
								</View>
								<Text class="text-sm leading-relaxed text-muted-foreground">{r().body}</Text>
							</View>
						)}
					</Each>
					<If when={p().reviews.some((r) => r.disposition === "approve")}>
						<Text class="text-xs text-faint">
							An approval here is of this snapshot, at that time. It does not count now.
						</Text>
					</If>
					<If when={p().reviewsMore}>
						<Text class="text-xs text-faint">Later reviews are not shown here.</Text>
					</If>
				</View>

				<View class="gap-2">
					<SectionTitle title="Landing checks" count={p().landings.length} />
					<If when={p().landings.length === 0}>
						<Text class="text-sm text-muted-foreground">No landing check saved.</Text>
					</If>
					<Each of={p().landings} key={(l) => l.id}>
						{(l) => <Text class="text-sm text-muted-foreground">{landingCheck(l())}</Text>}
					</Each>
					<If when={p().landingsMore}>
						<Text class="text-xs text-faint">Later checks are not shown here.</Text>
					</If>
				</View>

				<View class="gap-2">
					<SectionTitle title="Review requests" count={p().requests.length} />
					<If when={p().requests.length === 0}>
						<Text class="text-sm text-muted-foreground">No review request.</Text>
					</If>
					<Each of={p().requests} key={(r) => r.requestId}>
						{(r) => (
							<Text class="text-sm text-muted-foreground">
								{`${attentionWord(r().attention)} · revision ${r().revision} · ${r().age}`}
							</Text>
						)}
					</Each>
					<If when={p().requestsMore}>
						<Text class="text-xs text-faint">More requests exist than this read holds.</Text>
					</If>
				</View>

				<If when={p().reported.length > 0}>
					<View class="gap-2">
						<SectionTitle title="Agent reports" count={p().reported.length} />
						<Each of={p().reported} key={(r) => `${r.task} ${r.commit}`}>
							{(r) => (
								<Text class="text-sm text-muted-foreground">
									{`Task ${r().task} reported ${r().commit} · ${r().age}`}
								</Text>
							)}
						</Each>
						<Text class="text-xs text-faint">An agent's report, not proof that it landed.</Text>
					</View>
				</If>

				<View class="gap-2">
					<View class="flex-row">
						<Action
							label={detailsOpen()[id()] ? "Hide snapshot details" : "Snapshot details"}
							onPress={() => setFor(detailsOpen, id(), !detailsOpen()[id()])}
						/>
					</View>
					<If when={detailsOpen()[id()]}>
						<View testID="details" class="gap-0.5">
							<Detail label="Snapshot" value={p().identity.snapshotId} />
							<Detail label="Sequence" value={String(p().identity.sequence)} />
							<Detail label="Change" value={p().identity.changeId} />
							<Detail label="Base" value={p().identity.base} />
							<Detail label="Head" value={p().identity.head} />
							<Detail label="Scope" value={p().identity.scope} />
							<Detail label="Source" value={p().identity.source} />
							<Detail label="Patch SHA-256" value={p().identity.diff} />
							<Detail label="Kept" value={p().identity.capturedAt} />
						</View>
					</If>
				</View>
			</View>
		</Scroll>
	);
}

function Body(props: { changes: Changes; page: ChangePage }) {
	const id = () => props.page.identity.snapshotId;
	const tab = () => changeTabs()[id()] ?? "diff";
	// The snapshot's facts stay put above the diff: scrolling, selecting or
	// focusing in the diff never moves or hides them.
	return (
		<View class="min-h-0 flex-1 gap-4">
			<View class="gap-2">
				<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
					{props.page.row.title}
				</Text>
				<ChangeStatus row={props.page.row} />
			</View>
			<Kept changes={props.changes} page={props.page} />
			<Now changes={props.changes} page={props.page} />
			<View class="flex-row items-center gap-3">
				<TabRow>
					<TabItem label="Diff" selected={tab() === "diff"} onPress={() => setFor(changeTabs, id(), "diff")} />
					<TabItem
						label="History"
						selected={tab() === "history"}
						onPress={() => setFor(changeTabs, id(), "history")}
					/>
				</TabRow>
				<If when={tab() === "diff" && props.page.files.length > 0}>
					<Text class="text-xs text-muted-foreground">{filesLine(props.page.files)}</Text>
				</If>
			</View>
			<If when={tab() === "diff"} else={<History page={props.page} />}>
				<Diff page={props.page} />
			</If>
		</View>
	);
}

/** A reopened snapshot that cannot show now: why, and a read of that same snapshot again. */
function NotShown(props: { changes: Changes; snapshotId: string }) {
	const message = () => changeMessages()[props.snapshotId] ?? "";
	const off = () => props.changes.list().availability !== "available";
	return (
		<View testID="change-not-shown" class="gap-2">
			<Text class="text-base text-muted-foreground">
				{message() || (off() ? "Pilot cannot show this kept snapshot now." : "Reading the kept snapshot.")}
			</Text>
			<If when={off()}>
				<Text class="text-sm text-muted-foreground">{props.changes.list().reason}</Text>
			</If>
			<If when={message() || off()}>
				<View class="flex-row">
					<Action
						label="Read again"
						accessibilityLabel="Read this kept snapshot again. This sends nothing."
						onPress={() => openChange(props.changes, props.snapshotId)}
					/>
				</View>
			</If>
		</View>
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
		<View class="flex-1 bg-background">
			<View class="min-h-0 w-full max-w-5xl flex-1 self-center gap-5 px-6 pb-6 pt-6">
				<TopBar />
				<View class="flex-row">
					<Action label="‹ Changes" accessibilityLabel="Back to Changes" onPress={backFromChanges} />
				</View>
				<If when={page()} else={<NotShown changes={props.changes} snapshotId={props.snapshotId} />}>
					<Each of={page() ? [page() as ChangePage] : []} key={(p) => p.identity.snapshotId}>
						{(p) => <Body changes={props.changes} page={p()} />}
					</Each>
				</If>
			</View>
		</View>
	);
}

/** The Changes list, or the kept snapshot the user reopened. */
export function ChangesScreen(props: { changes: Changes }) {
	const at = () => changesRoute();
	return (
		<If when={at()?.kind === "change"} else={<ChangeList changes={props.changes} />}>
			<Each of={at()?.kind === "change" ? [(at() as { snapshotId: string }).snapshotId] : []} key={(id) => id}>
				{(id) => <ChangeScreen changes={props.changes} snapshotId={id()} />}
			</Each>
		</If>
	);
}
