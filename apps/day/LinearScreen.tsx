// The user's own Linear issues that Pilot saved for this project, and the
// cycle Pilot's last sync read. Reading never starts work. The open issue
// reuses Today's explicit start and prefill actions. A chat or mission comes from its
// saved IDs, never from a matching title or link. The page says when the
// copy was saved, says when it is not complete and never claims to show
// the team's issues or other cycles.
// A close or an update keeps the page, its project, the open issue and the
// scroll offset (windowState.ts). The restored page reads again, as opening
// it does, and shows nothing when the read is for another project.
import { effect, type JSX, keymap, Scroll, type ScrollRef, signal, View, type ViewRef } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "./day";
import { keepRead, staleLine } from "./freshness";
import { IntakeWorkControls, openMissions } from "./Incoming";
import { keepScroll } from "./kept";
import type { LinearMirror, LinearView } from "./linearFeed";
import type { LinearCycleSummary, SavedLinearRead, TrackedItem } from "./linearRead";
import {
	closeLinear,
	countLine,
	cycleLine,
	earlierLine,
	focusIssue,
	GROUPS,
	type GroupKey,
	groupOf,
	identifierOf,
	linearProject,
	linearTitle,
	openIssue,
	type Place,
	placeOf,
	placeSentence,
	placeWord,
	progressLine,
	savedLine,
	troubleLine,
} from "./linearView";
import {
	Block,
	Body,
	BodyStrong,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	ExpandableRow,
	glide,
	Link,
	Mark,
	type MarkKind,
	Notice,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Progress,
	Rows,
	Section,
} from "./ui";
import { openMission } from "./view";

// Linear's own states, as the marks say them: started is working, not started and other states are new, done and
// closed are done.
const MARK: Record<GroupKey, MarkKind> = {
	started: "working",
	todo: "new",
	done: "done",
	closed: "done",
	other: "new",
};

function missionsOf(day: Day): MissionRow[] {
	const t = day.today();
	return [...t.moving, ...t.notMoving, ...t.unreported];
}

/** The cycle Pilot's last sync read, and the user's own progress in it. */
function Cycle(props: { read: SavedLinearRead }) {
	const linear = () => props.read.source.linear;
	const cycle = (): LinearCycleSummary | null =>
		linear()?.cycleStatus === "current" ? (linear()?.currentCycle ?? null) : null;
	return (
		<Section testID="linear-cycle" title="Cycle">
			<Block>
				<If
					when={cycle()}
					else={
						<Body tone="muted">
							{linear()?.statusMessage ||
								"Linear has no active cycle for this team. Pilot saved your open issues."}
						</Body>
					}
				>
					<Body>{cycle() ? cycleLine(cycle() as LinearCycleSummary) : ""}</Body>
					<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
						<Progress
							counts={{
								done: cycle()?.done ?? 0,
								review: 0,
								active: cycle()?.inProgress ?? 0,
								blocked: 0,
								todo: cycle()?.todo ?? 0,
							}}
						/>
						<Caption tone="faint">{cycle() ? progressLine(cycle() as LinearCycleSummary) : ""}</Caption>
					</View>
				</If>
			</Block>
		</Section>
	);
}

/** What the user can do from an issue's place: go to its mission. It only moves. */
function PlaceAction(props: { place: Place; itemId: string }) {
	const p = () => props.place;
	return (
		<View class="flex-row flex-wrap items-baseline gap-x-1.5">
			<Body>{placeSentence(p())}</Body>
			<If when={p().kind === "mission" && (p() as Extract<Place, { kind: "mission" }>).title}>
				<Link
					label="Open the mission"
					testID={`linear-mission-${props.itemId}`}
					onPress={() => {
						const id = (p() as Extract<Place, { kind: "mission" }>).missionId;
						closeLinear();
						openMission(id);
					}}
				/>
			</If>
		</View>
	);
}

// LIBRARY GAP: Row has no form that opens in place (MissionWork.tsx needs the same). An issue's row shows its details
// below it when pressed, with the expanded state for screen readers, and keeps the keyboard focus. The library should
// offer an "open in place" Row (an `open` prop, `onToggle` and the content under it). Until then this helper builds
// one from ExpandableRow, with Row's slots (mark, title, meta, a state word) and Row's spacing.
function OpenRow(props: {
	open: boolean;
	testID: string;
	accessibilityLabel: string;
	mark: MarkKind;
	title: string;
	meta: string;
	state: string;
	anchor: (node: ViewRef) => void;
	onToggle: () => void;
	content: JSX.Element;
}) {
	return (
		<ExpandableRow
			open={props.open}
			anchor={props.anchor}
			testID={props.testID}
			accessibilityLabel={props.accessibilityLabel}
			onToggle={props.onToggle}
			summaryClass="flex-row items-start gap-2.5 px-4 py-1.5 hover:bg-accent"
			content={<View class="gap-2 pb-2.5 pl-10 pr-4">{props.content}</View>}
		>
			<View class="h-4.5 w-3.5 items-center justify-center">
				<Mark kind={props.mark} />
			</View>
			<View class="min-w-0 flex-1">
				<BodyStrong truncate>{props.title}</BodyStrong>
				<Caption tone="faint" truncate>
					{props.meta}
				</Caption>
			</View>
			<Caption>{props.state}</Caption>
		</ExpandableRow>
	);
}

/** One saved issue: opens in place to its link, parent and place in Pilot. */
function Issue(props: { day: Day; item: TrackedItem; group: GroupKey; place: Place }) {
	const i = () => props.item;
	const open = () => openIssue() === i().id;
	const key = () => identifierOf(i());
	const intake = props.day.intake;
	const request = () =>
		intake?.view().projectId === linearProject()
			? intake?.view().fresh.find((row) => row.request.id === i().id && row.revision === i().revision)
			: undefined;
	const size = () =>
		i().linearSize === "quick_fix" ? "Quick fix" : i().linearSize === "needs_planning" ? "Needs planning" : "";
	const management = () => i().linearManagement;
	const sync = () => management()?.status;
	const managing = signal(false);
	const managementMessage = signal("");
	const changeManagement = async (action: "manage" | "stop" | "resume") => {
		const seen = management();
		const source = props.day.linear?.source;
		if (!seen || managing() || !source?.manage) return;
		managing.set(true);
		managementMessage.set("");
		try {
			managementMessage.set(await source.manage(i().id, seen.pin, action));
		} finally {
			managing.set(false);
		}
	};
	const node = signal<ViewRef | null>(null);
	// A restored window's open issue takes the keyboard focus once.
	effect(() => {
		const n = node();
		if (n && focusIssue() === i().id) {
			focusIssue.set(null);
			n.focus();
		}
	});
	return (
		<OpenRow
			open={open()}
			anchor={(n: ViewRef) => node.set(n)}
			testID={`linear-issue-${i().id}`}
			accessibilityLabel={`${i().title}, ${i().status}. ${placeWord(props.place)}. ${open() ? "Hide" : "Show"} its details.`}
			mark={MARK[props.group]}
			title={i().title}
			meta={[key(), placeWord(props.place)].filter(Boolean).join(" · ")}
			state={i().status}
			onToggle={() => {
				glide();
				openIssue.set(open() ? null : i().id);
				node()?.focus();
			}}
			content={
				<View testID={`linear-detail-${i().id}`} class="gap-2">
					<PlaceAction place={props.place} itemId={i().id} />
					<If when={earlierLine(i())}>
						<Caption>{earlierLine(i())}</Caption>
					</If>
					<If when={i().linearParent}>
						<Caption>
							{`Sub-issue of ${i().linearParent?.identifier ?? ""} · ${i().linearParent?.title ?? ""}`}
						</Caption>
					</If>
					<Caption tone="faint">{i().url}</Caption>
					<If when={size()}>
						<Body tone="muted">{`Suggested size: ${size()}. You choose how to start.`}</Body>
					</If>
					<If when={sync()}>
						<Body tone="muted">
							{sync()?.reconcilePlan
								? "Review the linked work. Linear closed the issue without changing the Pilot plan."
								: sync()?.reassigned
									? "Work is held because Linear assigned the issue to someone else."
									: sync()?.error ||
										sync()?.reason ||
										"Pilot manages progress and review. You mark the issue complete."}
						</Body>
					</If>
					<If when={management() && !!props.day.linear?.source.manage}>
						<Buttons>
							<If when={!management()?.enabled}>
								<Button
									small
									label="Manage status"
									disabled={managing()}
									onPress={() => void changeManagement("manage")}
								/>
							</If>
							<If
								when={
									management()?.sessionId &&
									management()?.enabled &&
									!sync()?.reassigned &&
									!sync()?.reconcilePlan
								}
							>
								<Button
									small
									label="Stop managing status"
									disabled={managing()}
									onPress={() => void changeManagement("stop")}
								/>
							</If>
							<If
								when={
									management()?.enabled &&
									!sync()?.reassigned &&
									(sync()?.state === "paused" || sync()?.state === "error")
								}
							>
								<Button
									small
									label="Resume status sync"
									disabled={managing()}
									onPress={() => void changeManagement("resume")}
								/>
							</If>
						</Buttons>
						<If when={managementMessage()}>
							<Body role="alert" tone="muted">
								{managementMessage()}
							</Body>
						</If>
					</If>
					<Each of={intake && request() ? [request()!] : []} key={(row) => row.request.id}>
						{(row) => (
							<IntakeWorkControls
								mirror={intake!}
								row={row()}
								missions={openMissions(
									props.day.scope
										?.view()
										.snapshot?.projects.find((p) => p.id === linearProject() && p.currentness === "live")
										?.today ??
										(props.day.scope
											? { ...props.day.today(), moving: [], notMoving: [], unreported: [] }
											: props.day.today()),
								)}
								busy={
									intake!.view().sending.includes(i().id) ||
									intake!.view().unsettled.some((o) => o.itemId === i().id)
								}
								fromLinearList
								onStarted={closeLinear}
							/>
						)}
					</Each>
				</View>
			}
		/>
	);
}

/** The saved issues, grouped by their Linear state, with what is not shown counted. */
function Issues(props: { day: Day; read: SavedLinearRead }) {
	// The requests New on Today lists now: the connected read, or the mock window's examples.
	const fresh = () =>
		props.day.intake
			? props.day.intake.view().fresh.map((r) => r.request.id)
			: props.day.today().intake.requests.map((r) => r.id);
	const groups = () => {
		const missions = missionsOf(props.day);
		const ids = fresh();
		return GROUPS.map((g) => ({
			...g,
			rows: props.read.items
				.filter((item) => groupOf(item) === g.key)
				.map((item) => ({ item, place: placeOf(item, missions, ids) })),
		})).filter((g) => g.rows.length > 0);
	};
	return (
		<>
			<If when={props.read.items.length === 0}>
				<Section title="Your issues">
					<EmptyLine
						testID="linear-empty"
						text={props.read.total === 0 ? "Pilot saved no issues of yours here." : ""}
					/>
				</Section>
			</If>
			<Each of={groups()} key={(g) => g.key}>
				{(g) => (
					<Section testID={`linear-group-${g().key}`} title={g().title} count={g().rows.length}>
						{/* Rows hides the first row's hairline under the heading. */}
						<Rows>
							<Each of={g().rows} key={(r) => r.item.id}>
								{(r) => <Issue day={props.day} item={r().item} group={g().key} place={r().place} />}
							</Each>
						</Rows>
					</Section>
				)}
			</Each>
			<If when={countLine(props.read)}>
				<EmptyLine testID={props.read.complete ? "linear-complete" : "linear-more"} text={countLine(props.read)} />
			</If>
		</>
	);
}

/**
 * A read Pilot could show: the source's state as notices across the top of the panel, then the cycle and the issues
 * when they are current.
 */
function Saved(props: { day: Day; read: SavedLinearRead }) {
	const r = () => props.read;
	const configured = () => r().source.configured && r().source.status !== "not_configured";
	const shown = () => configured() && r().configurationCurrent;
	// The open issue is no longer among the rows shown: say so, never open another.
	const lost = () => {
		const id = openIssue();
		return shown() && !!id && !r().items.some((item) => item.id === id);
	};
	return (
		<>
			<If when={troubleLine(r())}>
				<Notice testID="linear-trouble" placement="panel" text={troubleLine(r())} />
			</If>
			<If when={!configured()}>
				<Notice
					testID="linear-unset"
					placement="panel"
					text="Linear is not set up for this project, so Pilot saved no issues."
					detail="This is not the same as having none."
				/>
			</If>
			<If when={configured() && !r().configurationCurrent}>
				<Notice
					testID="linear-not-current"
					placement="panel"
					text="Pilot has not saved issues for this project's current Linear settings yet."
					detail="Nothing is shown. This is not the same as having none."
				/>
			</If>
			<If when={lost()}>
				<Notice
					testID="linear-issue-gone"
					placement="panel"
					text={
						r().complete
							? "The issue you had open is not in Pilot's saved copy now."
							: "The issue you had open is not among the issues shown here."
					}
				/>
			</If>
			<If when={shown()}>
				<Column>
					<Cycle read={r()} />
					<Issues day={props.day} read={r()} />
				</Column>
			</If>
		</>
	);
}

/**
 * The Linear page over the connected window's saved issues. Opening it and
 * Read again read Pilot's saved copy; neither asks Linear for anything.
 */
export function LinearScreen(props: { day: Day }) {
	const mirror = props.day.linear as LinearMirror;
	const v = (): LinearView => mirror.view();
	void mirror.source.read();
	// A request started, linked or triaged on Today changes an issue's place: read again, once per change.
	const intakeKey = () => {
		const i = props.day.intake?.view();
		return i ? `${i.fresh.map((r) => r.request.id).join(",")}|${i.started.length}|${i.settled.length}` : "";
	};
	let seen = intakeKey();
	effect(() => {
		const now = intakeKey();
		if (now === seen) return;
		seen = now;
		void mirror.source.read();
	});
	keymap.bind(
		"escape",
		() => {
			if (openIssue()) {
				glide();
				openIssue.set(null);
			} else closeLinear();
		},
		{ when: "always" },
	);
	const scroll = keepScroll("linear");
	// The page's project: its first read names it, unless a restored window already did.
	effect(() => {
		const r = v().read;
		if (r && linearProject() === null) linearProject.set(r.projectId);
	});
	/** The newest read, when it is for the page's project. */
	const read = () => {
		const r = v().read;
		return r && r.projectId === linearProject() ? r : null;
	};
	/** A read for another project than the one the page showed before. */
	const other = () => {
		const r = v().read;
		return !!r && linearProject() !== null && r.projectId !== linearProject();
	};
	// Pilot reads again on its own while the last read failed, and when the window comes back.
	const reads = keepRead(
		() => mirror.source.read(),
		() => !!v().reason && !other(),
		() => !!read(),
	);
	// A restored offset waits for the rows it scrolled through; until then the kept offset stays.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		if (waiting === null || !node || !read()) return;
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
				if (waiting === null) scroll.onScroll(e);
			}}
		>
			<Page testID="linear">
				<PageHead
					pre={<Caption tone="faint">Linear</Caption>}
					title={linearTitle(read())}
					text="Your own issues that Pilot saved for this project. Not your team's other issues or other cycles."
					actions={
						<If when={reads.warn()}>
							<Button
								label={v().reading ? "Reading…" : "Try now"}
								icon="refresh"
								testID="linear-read"
								disabled={v().reading}
								accessibilityLabel="Read Pilot's saved Linear issues again. This sends nothing and does not ask Linear."
								onPress={() => void reads.now()}
							/>
						</If>
					}
				>
					<If when={read() && savedLine(read() as SavedLinearRead)}>
						<Caption testID="linear-saved" tone="faint">
							{read() ? savedLine(read() as SavedLinearRead) : ""}
						</Caption>
					</If>
				</PageHead>
				<Panel
					testID="linear-panel"
					notice={
						<>
							<If when={other()}>
								<Notice
									testID="linear-other-project"
									placement="panel"
									text="Pilot cannot show the issues this page showed before. Its saved copy is now for another project."
									detail="Nothing is shown. This is not the same as having none."
								/>
							</If>
							{/* With issues shown, a failed read says nothing until the shared old-data rule does. */}
							<If when={v().reason && !other() && (!read() || reads.stale())}>
								<Notice
									testID="linear-off"
									placement="panel"
									text={
										read()
											? staleLine(reads.readAt() ?? 0)
											: `Pilot cannot show your Linear issues here. ${v().reason}`
									}
									detail={read() ? undefined : "This is not the same as having none."}
								/>
							</If>
						</>
					}
				>
					<If
						when={read()}
						else={
							<If when={!v().reason && !other()}>
								<Column>
									<Section title="Your issues">
										<EmptyLine text="Reading your saved Linear issues…" />
									</Section>
								</Column>
							</If>
						}
					>
						<Each of={read() ? [read() as SavedLinearRead] : []} key={(r) => r.contextDigest}>
							{(r) => <Saved day={props.day} read={r()} />}
						</Each>
					</If>
				</Panel>
				<PageFoot text="Reading the list never starts work or changes Linear." />
			</Page>
		</Scroll>
	);
}
