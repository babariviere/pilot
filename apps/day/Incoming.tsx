// Today's New section: requests from Slack and Linear that nobody started
// in Pilot yet. A row opens in place to show where the request came from
// and what the user can do with it: start work, put it off (Later) or
// discard it. Opening a row, choosing where work goes or reading again
// records and starts nothing; only Start, Later, Discard, Bring back and
// Undo send, each once, naming the exact request and revision shown. A
// write whose answer is lost stays "not confirmed" until Check reads its
// saved receipt. The words come from outside Pilot and show as text only.
import { effect, signal, Text, View, type ViewRef } from "nsh";
import { Button, Collapsible, Radio, RadioGroup } from "nsh/base";
import type { MissionRow, Request, Today } from "pilot-day/native";
import type { Day } from "./day";
import { FeedbackIncoming, incomingFeedback, newFeedback } from "./FeedbackIncoming";
import type { IntakeMirror, IntakeOp, IntakeResult, IntakeRow, IntakeView, Triage } from "./intakeFeed";
import { openLinear } from "./linearView";
import { glide } from "./motion";
import { Action, InlineAction, Mark, SectionTitle } from "./ui";
import { dataSource, placeRow } from "./view";

/** The request open in place, by ID. One at a time; it closes when the request leaves. */
export const openRequest = signal<string | null>(null);

/**
 * A request chosen from another project's row on Today. It opens once that
 * project's requests are read here (Today switches to the project first).
 */
const pendingRequest = signal<{ projectId: string; id: string } | null>(null);

/** Opens `id` in New once `projectId`'s requests are the ones shown. Sends nothing. */
export function openRequestIn(projectId: string, id: string) {
	pendingRequest.set({ projectId, id });
}
/** Where the user chose to start each request: a mission ID, or "" for standalone work. Choosing sends nothing. */
export const routes = signal<Record<string, string>>({});
/** The Start the user is about to confirm: the exact request, revision, context and place shown. */
const confirming = signal<{ itemId: string; revision: number; contextDigest: string; missionId: string } | null>(null);
/** The newest result of the user's own write, in one sentence. */
const result = signal("");
/** The newest confirmed Discard in this window, offered for Undo. */
const undoable = signal<string | null>(null);
const showLater = signal(false);
const showDiscarded = signal(false);
/** A row that should take the keyboard focus once it shows. */
const focusRow = signal<string | null>(null);
/** A request whose Start work… button should take the keyboard focus back, after Cancel. */
const focusStart = signal<string | null>(null);

/** "Slack", "Slack and Linear", "Slack, Linear and Jira". */
function joined(names: string[]): string {
	if (names.length < 2) return names[0] ?? "";
	return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** Where a request came from, in one line: "Slack · #client-northwind · 20 min ago". */
export function requestLine(request: Request): string {
	return [request.sourceLabel, request.place, request.age].filter(Boolean).join(" · ");
}

function toggle(id: string) {
	glide();
	confirming.set(null);
	openRequest.set(openRequest() === id ? null : id);
}

/** Missions a request can start in: those of this project that run now. */
function openMissions(today: Today): MissionRow[] {
	return [...today.moving, ...today.notMoving, ...today.unreported].filter(
		(m) => m.control.state === "running" && !m.control.held,
	);
}

function quoted(title: string): string {
	return title ? `“${title}”` : "a request";
}

/** What an unsettled write asked, as the start of a sentence. */
function unsettledLine(op: IntakeOp): string {
	const title = quoted(op.title);
	switch (op.kind === "start" ? "start" : op.asked) {
		case "start":
			return `Starting work on ${title} is not confirmed.`;
		case "later":
			return `Later for ${title} is not confirmed.`;
		case "discarded":
			return `Discarding ${title} is not confirmed.`;
		default:
			return `Bringing back ${title} is not confirmed.`;
	}
}

/** What a settled write did, or "" when the rows already say it. */
function settledLine(op: IntakeOp, missions: MissionRow[]): string {
	const title = quoted(op.title);
	const reason = op.reason ? ` ${op.reason.replace(/\.?$/, ".")}` : "";
	if (op.kind === "start") {
		if (op.delivery === "rejected") return `Pilot did not start ${title}.${reason} Nothing ran.`;
		const mission = missions.find((m) => m.id === op.missionId)?.title;
		const place = op.missionId ? ` in ${mission ?? "the chosen mission"}` : " as standalone work";
		return `Started ${title}${place}: one Build chat was created. That is not progress or a result yet.`;
	}
	return op.delivery === "rejected" ? `Pilot did not change ${title}.${reason}` : "";
}

/** A row's button: opens or closes it in place. The pressed row keeps the keyboard focus. */
function RequestButton(props: { request: Request; mark: "new" | "still"; word: string; open: boolean }) {
	const r = () => props.request;
	const node = signal<ViewRef | null>(null);
	effect(() => {
		const n = node();
		if (n && focusRow() === r().id) {
			focusRow.set(null);
			n.focus();
		}
	});
	return (
		<Button
			ref={(n: ViewRef) => node.set(n)}
			testID={`request-${r().id}`}
			accessibilityLabel={`${r().title}, ${props.word.toLowerCase()} from ${r().sourceLabel}. ${props.open ? "Hide" : "Show"} what you can do with it.`}
			onPress={() => {
				toggle(r().id);
				node()?.focus();
			}}
			class="group gap-1 rounded-md py-3.5 focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<View class="flex-row items-center gap-2.5">
				<Mark kind={props.mark} />
				<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{r().title}</Text>
				<Text class="text-xs text-muted-foreground">{props.word}</Text>
			</View>
			<View class="flex-row gap-2.5">
				<View class="size-2" />
				<Text class="flex-1 text-xs text-faint">{requestLine(r())}</Text>
			</View>
		</Button>
	);
}

/** Where the request came from: what it is and its link, as text. */
function Origin(props: { request: Request }) {
	return (
		<View class="gap-2">
			<If when={props.request.kind}>
				<Text class="text-sm text-foreground">{props.request.kind}</Text>
			</If>
			<If when={props.request.link}>
				<Text class="text-xs text-faint">{props.request.link}</Text>
			</If>
		</View>
	);
}

/** The read-only Linear page's entry, offered where Linear's requests already show. Opening it changes nothing. */
function LinearEntry(props: { day: Day; sources: string[] }) {
	const place = placeRow("linear-open", openLinear);
	const shown = () =>
		!!props.day.linear && (props.sources.includes("Linear") || !!props.day.linear.view().read?.source.configured);
	return (
		<If when={shown()}>
			<Action
				label="Your Linear issues"
				testID="linear-open"
				accessibilityLabel="Your Linear issues. Opens Pilot's saved copy; it changes nothing."
				anchor={place.anchor}
				onPress={place.press}
			/>
		</If>
	);
}

/** One write, sent once. Its result shows in the section; the rows follow the newer read. */
async function send(id: string, run: () => Promise<IntakeResult>, after?: (r: IntakeResult) => void) {
	result.set("");
	const r = await run();
	if (r.status !== "accepted") result.set(r.message);
	after?.(r);
	if (r.status === "accepted" && openRequest() === id) openRequest.set(null);
}

/** The row's next neighbour in `rows`, to take the focus when it leaves. */
function neighbour(rows: IntakeRow[], id: string): string | null {
	const i = rows.findIndex((r) => r.request.id === id);
	if (i < 0) return null;
	return rows[i + 1]?.request.id ?? rows[i - 1]?.request.id ?? null;
}

function triage(mirror: IntakeMirror, row: IntakeRow, state: Triage, rows: IntakeRow[]) {
	const v = mirror.view();
	const next = neighbour(rows, row.request.id);
	return send(
		row.request.id,
		() =>
			mirror.source.triage({
				itemId: row.request.id,
				revision: row.revision,
				contextDigest: v.contextDigest,
				state,
			}),
		(r) => {
			if (r.status !== "accepted") return;
			undoable.set(state === "discarded" ? row.request.id : null);
			focusRow.set(next);
		},
	);
}

/** Choose where work goes, then Start, Later or Discard. Start asks once more and names the exact place. */
function NewControls(props: { mirror: IntakeMirror; row: IntakeRow; missions: MissionRow[]; busy: boolean }) {
	const id = () => props.row.request.id;
	const route = () => routes()[id()] ?? "";
	const offered = () => route() === "" || props.missions.some((m) => m.id === route());
	const place = (missionId: string) =>
		missionId
			? `in ${props.missions.find((m) => m.id === missionId)?.title ?? "the chosen mission"}`
			: "as standalone work";
	const pinned = () => {
		const c = confirming();
		return c && c.itemId === id() ? c : null;
	};
	// The Start shown is the one sent: a newer revision, project change or a
	// mission that stopped running closes it instead of starting another.
	const current = () => {
		const c = pinned();
		return (
			!!c &&
			c.revision === props.row.revision &&
			c.contextDigest === props.mirror.view().contextDigest &&
			(c.missionId === "" || props.missions.some((m) => m.id === c.missionId))
		);
	};
	const startNode = signal<ViewRef | null>(null);
	effect(() => {
		const n = startNode();
		if (n && focusStart() === id()) {
			focusStart.set(null);
			n.focus();
		}
	});
	const cancel = () => {
		confirming.set(null);
		focusStart.set(id());
	};
	const start = () => {
		const c = pinned();
		if (!c || !current() || props.busy) return;
		const next = neighbour(props.mirror.view().fresh, id());
		void send(
			id(),
			() =>
				props.mirror.source.start({
					itemId: c.itemId,
					revision: c.revision,
					contextDigest: c.contextDigest,
					missionId: c.missionId || null,
				}),
			(r) => {
				confirming.set(null);
				if (r.status === "accepted") focusRow.set(next);
			},
		);
	};
	return (
		<View class="gap-3">
			<If
				when={props.missions.length > 0}
				else={<Text class="text-sm text-muted-foreground">Work on it starts as standalone work.</Text>}
			>
				<View class="gap-1">
					<Text class="text-xs text-faint">Where should the work go?</Text>
					<RadioGroup class="gap-0.5">
						<Each of={[{ id: "", title: "Standalone work" }, ...props.missions]} key={(m) => m.id}>
							{(m) => (
								<Radio
									testID={`route-${id()}-${m().id || "standalone"}`}
									checked={route() === m().id}
									disabled={props.busy || !!pinned()}
									onChange={() => routes.set({ ...routes(), [id()]: m().id })}
									class="group flex-row items-center gap-2.5 rounded-lg px-2 py-1.5 checked:bg-selection hover:bg-accent checked:hover:bg-selection disabled:opacity-70 focus-visible:ring-2 focus-visible:ring-ring/40"
								>
									<View class="size-3.5 items-center justify-center rounded-full border border-input group-checked:border-primary">
										<View class="size-1.5 rounded-full group-checked:bg-primary" />
									</View>
									<Text class="text-sm text-foreground">{m().title}</Text>
								</Radio>
							)}
						</Each>
					</RadioGroup>
				</View>
			</If>
			<If when={!offered()}>
				<Text class="text-sm text-needs-ink">That mission is not running now. Choose again.</Text>
			</If>
			<If
				when={pinned()}
				else={
					<View class="flex-row flex-wrap gap-1">
						<Action
							label="Start work…"
							primary
							testID={`start-${id()}`}
							anchor={(n) => startNode.set(n)}
							disabled={props.busy || !offered()}
							onPress={() =>
								confirming.set({
									itemId: id(),
									revision: props.row.revision,
									contextDigest: props.mirror.view().contextDigest,
									missionId: route(),
								})
							}
						/>
						<Action
							label="Later"
							testID={`later-${id()}`}
							disabled={props.busy}
							onPress={() => void triage(props.mirror, props.row, "later", props.mirror.view().fresh)}
						/>
						<Action
							label="Discard"
							testID={`discard-${id()}`}
							disabled={props.busy}
							onPress={() => void triage(props.mirror, props.row, "discarded", props.mirror.view().fresh)}
						/>
					</View>
				}
			>
				<View testID={`confirm-${id()}`} class="gap-2 rounded-xl bg-muted px-4 py-3">
					<Text class="text-sm text-foreground">
						{`Start one Build chat for ${quoted(props.row.request.title)} ${place(pinned()?.missionId ?? "")}?`}
					</Text>
					<Text class="text-xs leading-relaxed text-faint">
						It uses this project's task model and its existing limits. Pilot also marks the request as started in
						Slack or Linear. Nothing else starts.
					</Text>
					<If when={!current()}>
						<Text class="text-xs text-needs-ink">
							This changed since you chose to start it. Cancel and look again.
						</Text>
					</If>
					<View class="flex-row gap-2">
						<Action
							label={props.busy ? "Starting…" : "Start"}
							primary
							testID={`confirm-start-${id()}`}
							disabled={props.busy || !current()}
							onPress={start}
						/>
						<Action label="Cancel" disabled={props.busy} onPress={cancel} />
					</View>
				</View>
			</If>
		</View>
	);
}

/** A new request: opens in place to its origin and controls. */
function NewRow(props: { mirror: IntakeMirror; row: IntakeRow; missions: MissionRow[]; busy: boolean }) {
	const r = () => props.row.request;
	const open = () => openRequest() === r().id;
	return (
		<Collapsible
			open={open()}
			class="border-t border-border"
			content={
				<View testID={`request-detail-${r().id}`} class="flex-row gap-2.5 pb-3.5">
					<View class="size-2" />
					<View class="flex-1 gap-2">
						<Origin request={r()} />
						<If when={props.busy}>
							<Text class="text-sm text-muted-foreground">Waiting for Pilot's answer about this request.</Text>
						</If>
						<NewControls mirror={props.mirror} row={props.row} missions={props.missions} busy={props.busy} />
					</View>
				</View>
			}
		>
			<RequestButton request={r()} mark="new" word="New" open={open()} />
		</Collapsible>
	);
}

/** A request put off or discarded: its title and the one way back. */
function KeptRow(props: {
	mirror: IntakeMirror;
	row: IntakeRow;
	rows: IntakeRow[];
	state: "later" | "discarded";
	busy: boolean;
}) {
	const r = () => props.row.request;
	return (
		<View testID={`${props.state}-row-${r().id}`} class="flex-row items-center gap-2.5 border-t border-border py-2.5">
			<Mark kind="still" />
			<View class="flex-1 gap-0.5">
				<Text class="text-sm text-foreground">{r().title}</Text>
				<Text class="text-xs text-faint">{requestLine(r())}</Text>
			</View>
			<Action
				label={props.state === "later" ? "Bring back" : "Undo"}
				testID={`${props.state === "later" ? "bring-back" : "undo"}-${r().id}`}
				disabled={props.busy}
				onPress={() => void triage(props.mirror, props.row, "new", props.rows)}
			/>
			<If when={props.state === "later"}>
				<Action
					label="Discard"
					testID={`discard-${r().id}`}
					disabled={props.busy}
					onPress={() => void triage(props.mirror, props.row, "discarded", props.rows)}
				/>
			</If>
		</View>
	);
}

/** A folded list of put-off or discarded requests. Showing it sends nothing. */
function Kept(props: {
	mirror: IntakeMirror;
	state: "later" | "discarded";
	rows: IntakeRow[];
	busy: (id: string) => boolean;
}) {
	const shown = props.state === "later" ? showLater : showDiscarded;
	const title = props.state === "later" ? "Later" : "Discarded";
	return (
		<If when={props.rows.length > 0}>
			<View testID={`intake-${props.state}`} class="gap-0.5 pt-3">
				<View class="flex-row items-center gap-2">
					<Text class="text-xs text-faint">{`${title}  ${props.rows.length}`}</Text>
					<View class="flex-1" />
					<Action
						label={shown() ? "Hide" : "Show"}
						accessibilityLabel={`${shown() ? "Hide" : "Show"} ${title.toLowerCase()} requests`}
						onPress={() => {
							glide();
							shown.set(!shown());
						}}
					/>
				</View>
				<If when={shown()}>
					<Each of={props.rows} key={(r) => r.request.id}>
						{(r) => (
							<KeptRow
								mirror={props.mirror}
								row={r()}
								rows={props.rows}
								state={props.state}
								busy={props.busy(r().request.id)}
							/>
						)}
					</Each>
				</If>
			</View>
		</If>
	);
}

/** One write whose result is not known, and its read-only Check. */
function Unsettled(props: { mirror: IntakeMirror; op: IntakeOp }) {
	const checking = () => props.op.delivery === "checking";
	return (
		<View testID={`unsettled-${props.op.operationId}`} class="gap-1.5 rounded-xl bg-muted px-4 py-3">
			<View class="flex-row items-center gap-2.5">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-foreground">{unsettledLine(props.op)}</Text>
				<Action
					label={checking() ? "Checking…" : "Check"}
					testID={`check-${props.op.operationId}`}
					accessibilityLabel="Check whether it happened. This reads Pilot's saved answer and sends nothing."
					disabled={checking()}
					onPress={() => {
						result.set("");
						void props.mirror.source.check(props.op.operationId).then((r) => {
							if (r.status === "unknown") result.set(r.message);
						});
					}}
				/>
			</View>
			<Text class="text-xs text-faint">Pilot will not send it again. Check only reads its saved answer.</Text>
		</View>
	);
}

/** The New section over the connected window's requests. */
function LiveIncoming(props: { day: Day; mirror: IntakeMirror }) {
	const v = (): IntakeView => props.mirror.view();
	const missions = () => openMissions(props.day.today());
	const busy = (id: string) => v().sending.includes(id) || v().unsettled.some((o) => o.itemId === id);
	// A request that left (started, put off, read again) closes, and so does its Start.
	effect(() => {
		const pending = pendingRequest();
		if (pending && v().projectId === pending.projectId) {
			pendingRequest.set(null);
			if (v().fresh.some((r) => r.request.id === pending.id)) openRequest.set(pending.id);
		}
		const id = openRequest();
		if (id && !v().fresh.some((r) => r.request.id === id)) openRequest.set(null);
		const c = confirming();
		if (c && c.itemId !== openRequest()) confirming.set(null);
		const u = undoable();
		if (u && !v().discarded.some((r) => r.request.id === u)) undoable.set(null);
	});
	const undoRow = () => v().discarded.find((r) => r.request.id === undoable()) ?? null;
	const notes = () =>
		v()
			.settled.map((op) => ({ id: op.operationId, text: settledLine(op, missions()) }))
			.filter((n) => n.text)
			.slice(-3);
	const visible = () =>
		v().intake.watched ||
		v().availability !== "live" ||
		v().unsettled.length + v().later.length + v().discarded.length > 0;
	const empty = () =>
		v().intake.trouble.length > 0 || v().intake.more
			? "No new requests in what Pilot read."
			: `No new requests. ${joined(v().intake.sources)} ${v().intake.sources.length === 1 ? "is" : "are"} quiet.`;
	const reading = signal(false);
	const readAgain = async () => {
		if (reading()) return;
		reading.set(true);
		try {
			await props.mirror.source.read();
		} finally {
			reading.set(false);
		}
	};
	return (
		<If
			when={
				visible() ||
				incomingFeedback(props.day).length > 0 ||
				!!props.day.feedback?.view().reason ||
				!!props.day.feedback?.view().more
			}
		>
			<View testID="incoming" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="New" count={v().fresh.length + newFeedback(props.day).length}>
						<If when={v().intake.sources.length > 0}>
							<Text class="text-xs text-faint">{`From ${joined(v().intake.sources)}`}</Text>
						</If>
						<LinearEntry day={props.day} sources={v().intake.sources} />
					</SectionTitle>
				</View>
				<If when={v().reason}>
					<View testID="incoming-off" class="mb-2 gap-1.5 rounded-xl bg-muted px-4 py-3">
						<View class="flex-row items-center gap-2.5">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-foreground">
								{v().availability === "live"
									? v().reason
									: `Pilot cannot show new requests here. ${v().reason}`}
							</Text>
						</View>
						<If when={v().availability !== "live"}>
							<Text class="text-xs text-faint">This is not the same as having none.</Text>
						</If>
						<View class="flex-row pt-1">
							<Action
								label={reading() ? "Reading…" : "Read again"}
								icon="refresh"
								testID="incoming-read"
								disabled={reading()}
								accessibilityLabel="Read new requests again. This sends nothing."
								onPress={() => void readAgain()}
							/>
						</View>
					</View>
				</If>
				<Each of={v().intake.trouble} key={(t) => t}>
					{(t) => (
						<View class="mb-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-foreground">{t()}</Text>
						</View>
					)}
				</Each>
				<Each of={v().unsettled} key={(o) => o.operationId}>
					{(o) => (
						<View class="mb-2">
							<Unsettled mirror={props.mirror} op={o()} />
						</View>
					)}
				</Each>
				<If when={result()}>
					<Text testID="incoming-result" role="alert" class="pb-1 text-sm text-muted-foreground">
						{result()}
					</Text>
				</If>
				<Each of={notes()} key={(n) => n.id}>
					{(n) => (
						<View class="flex-row items-center gap-2.5 pb-1">
							<Mark kind="done" />
							<Text class="flex-1 text-sm text-muted-foreground">{n().text}</Text>
						</View>
					)}
				</Each>
				<If when={undoRow()}>
					<View testID="incoming-undo" class="flex-row flex-wrap items-baseline gap-x-1.5 pb-1">
						<Text class="text-sm text-muted-foreground">{`Discarded ${quoted(undoRow()?.request.title ?? "")}.`}</Text>
						<InlineAction
							label="Undo"
							testID="undo-last"
							onPress={() => {
								const row = undoRow();
								if (row && !busy(row.request.id)) void triage(props.mirror, row, "new", v().discarded);
							}}
						/>
					</View>
				</If>
				<If when={v().availability === "live"}>
					<If when={v().fresh.length > 0} else={<Text class="text-sm text-muted-foreground">{empty()}</Text>}>
						<Each of={v().fresh} key={(r) => r.request.id}>
							{(r) => (
								<NewRow mirror={props.mirror} row={r()} missions={missions()} busy={busy(r().request.id)} />
							)}
						</Each>
					</If>
				</If>
				<If when={v().intake.more}>
					<Text testID="incoming-more" class="pt-1 text-xs text-faint">
						{`${v().intake.more} Pilot reads up to 100 requests from each source.`}
					</Text>
				</If>
				<FeedbackIncoming day={props.day} />
				<Kept mirror={props.mirror} state="later" rows={v().later} busy={busy} />
				<Kept mirror={props.mirror} state="discarded" rows={v().discarded} busy={busy} />
			</View>
		</If>
	);
}

/** An example row in the mock window: opens in place and offers nothing. */
function ExampleRow(props: { request: Request }) {
	const r = () => props.request;
	const open = () => openRequest() === r().id;
	return (
		<Collapsible
			open={open()}
			class="border-t border-border"
			content={
				<View testID={`request-detail-${r().id}`} class="flex-row gap-2.5 pb-3.5">
					<View class="size-2" />
					<View class="flex-1 gap-2">
						<Origin request={r()} />
						<Text class="text-sm text-muted-foreground">
							This window shows examples, so nothing here can start, put off or discard a request.
						</Text>
					</View>
				</View>
			}
		>
			<RequestButton request={r()} mark="new" word="New" open={open()} />
		</Collapsible>
	);
}

/** The mock window's New section: Today's example rows, read only. */
function ExampleIncoming(props: { day: Day }) {
	const intake = () => props.day.today().intake;
	effect(() => {
		const id = openRequest();
		if (id && !intake().requests.some((r) => r.id === id)) openRequest.set(null);
	});
	const shown = () => intake().requests;
	const empty = () =>
		intake().trouble.length > 0
			? "No new requests in what Pilot read."
			: `No new requests. ${joined(intake().sources)} ${intake().sources.length === 1 ? "is" : "are"} quiet.`;
	return (
		<If
			when={
				intake().watched ||
				incomingFeedback(props.day).length > 0 ||
				!!props.day.feedback?.view().more ||
				!!props.day.feedback?.view().reason
			}
		>
			<View testID="incoming" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="New" count={shown().length + newFeedback(props.day).length}>
						<Text class="text-xs text-faint">{`From ${joined(intake().sources)}`}</Text>
						<LinearEntry day={props.day} sources={intake().sources} />
					</SectionTitle>
				</View>
				<Each of={intake().trouble} key={(t) => t}>
					{(t) => (
						<View class="mb-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-foreground">{t()}</Text>
						</View>
					)}
				</Each>
				<FeedbackIncoming day={props.day} />
				<If when={shown().length > 0} else={<Text class="text-sm text-muted-foreground">{empty()}</Text>}>
					<Each of={shown()} key={(r) => r.id}>
						{(r) => <ExampleRow request={r()} />}
					</Each>
				</If>
				<If when={intake().more}>
					<Text testID="incoming-more" class="pt-1 text-xs text-faint">
						{intake().more}
					</Text>
				</If>
			</View>
		</If>
	);
}

/**
 * New requests, newest first. Hidden when no request source is set up and
 * nothing waits. A source that cannot be read says so; rows a read does not
 * hold are counted, so the list never looks complete when it is not. The
 * connected window reads the selected project's request pages. Without a
 * request source it shows nothing; only the test-only mock windows show
 * Today's examples, and they offer no writes.
 */
export function Incoming(props: { day: Day }) {
	const mirror = props.day.intake;
	if (mirror) return <LiveIncoming day={props.day} mirror={mirror} />;
	return (
		<If when={dataSource() === "mock"}>
			<ExampleIncoming day={props.day} />
		</If>
	);
}
