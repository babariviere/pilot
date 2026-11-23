// The user's own Linear issues that Pilot saved for this project, and the
// cycle Pilot's last sync read. Reading never starts work. The open issue
// reuses Today's explicit start and prefill actions. A chat or mission comes from its
// saved IDs, never from a matching title or link. The page says when the
// copy was saved, says when it is not complete and never claims to show
// the team's issues or other cycles.
// A close or an update keeps the page, its project, the open issue and the
// scroll offset (windowState.ts). The restored page reads again, as opening
// it does, and shows nothing when the read is for another project.
import { effect, keymap, Scroll, type ScrollRef, type Signal, signal, untracked, View, type ViewRef } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type {
	LinearCycleSummary,
	SavedLinearRead,
	TrackedItem,
} from "../../../../packages/protocol/src/sources/tracking.ts";
import type { Day } from "../../app/day";
import { keepScroll } from "../../app/kept";
import { openMission } from "../../app/view";
import { IntakeWorkControls, openMissions } from "../../today/Incoming";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	glide,
	Link,
	type MarkKind,
	Notice,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Progress,
	Row,
	Rows,
	Section,
} from "../../ui";
import { keepRead, staleLine } from "../freshness";
import type { LinearMirror } from "./linearFeed";
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
	matchesLinearRequest,
	openIssue,
	type Place,
	placeOf,
	placeSentence,
	placeWord,
	planningBlock,
	progressLine,
	savedLine,
	troubleLine,
} from "./linearView";

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

const scopeLine = "Your own issues that Pilot saved for this project. Not your team's other issues or other cycles.";

function configured(read: SavedLinearRead): boolean {
	return read.source.configured && read.source.status !== "not_configured";
}

function savedCount(read: SavedLinearRead | null): number | null {
	return read && configured(read) && read.configurationCurrent && read.complete ? read.total : null;
}

/** The mounted list owns disclosure; only the standalone page keeps it in window state. */
type LinearList = {
	open: Signal<string | null>;
	focus?: Signal<string | null>;
	leave: () => void;
};

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
function PlaceAction(props: { place: Place; itemId: string; onLeave: () => void }) {
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
						props.onLeave();
						openMission(id);
					}}
				/>
			</If>
		</View>
	);
}

/** One saved issue: opens in place to its link, parent and place in Pilot. */
function Issue(props: {
	day: Day;
	item: TrackedItem;
	group: GroupKey;
	place: Place;
	project: string;
	list: LinearList;
}) {
	const i = () => props.item;
	const open = () => props.list.open() === i().id;
	const key = () => identifierOf(i());
	const intake = props.day.intake;
	const intakeHere = () => {
		const v = intake?.view();
		return v?.availability === "live" && v.projectId === props.project && i().projectId === props.project
			? v
			: undefined;
	};
	const needsPlanning = () => i().linearSize === "needs_planning";
	const blocked = () => (needsPlanning() ? planningBlock(i()) : "");
	const request = () => (blocked() ? undefined : intakeHere()?.fresh.find((row) => matchesLinearRequest(i(), row)));
	const refreshing = signal(false);
	const refresh = async () => {
		if (refreshing() || !intake || !props.day.linear) return;
		refreshing.set(true);
		try {
			await Promise.all([intake.source.read(), props.day.linear.source.read()]);
		} finally {
			refreshing.set(false);
		}
	};
	const planningReason = () => {
		if (blocked()) return blocked();
		if (!intakeHere()) return "Pilot could not read the request list for this project.";
		if (intakeHere()?.fresh.some((row) => row.request.source === "linear" && row.request.id === i().id)) {
			return "Pilot’s saved issue and request list show different versions.";
		}
		return "This issue is not on Pilot’s list of requests ready for planning.";
	};
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
		const focus = props.list.focus;
		if (n && focus?.() === i().id) {
			focus.set(null);
			n.focus();
		}
	});
	return (
		<Row
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
				props.list.open.set(open() ? null : i().id);
				node()?.focus();
			}}
			content={
				<View testID={`linear-detail-${i().id}`} class="gap-2">
					<PlaceAction place={props.place} itemId={i().id} onLeave={props.list.leave} />
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
					<If when={needsPlanning() && !request()}>
						<Notice
							testID={`linear-planning-unavailable-${i().id}`}
							text="Planning is unavailable"
							detail={planningReason()}
							action={
								<If when={!blocked() && intake && props.day.linear}>
									<Link
										label="Refresh planning availability"
										testID={`linear-planning-refresh-${i().id}`}
										disabled={refreshing()}
										onPress={() => void refresh()}
									/>
								</If>
							}
						/>
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
										.snapshot?.projects.find((p) => p.id === props.project && p.currentness === "live")
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
								onStarted={props.list.leave}
							/>
						)}
					</Each>
				</View>
			}
		/>
	);
}

/** The saved issues, grouped by their Linear state, with what is not shown counted. */
function Issues(props: { day: Day; read: SavedLinearRead; list: LinearList }) {
	const fresh = () => {
		const intake = props.day.intake?.view();
		if (intake) return intake.projectId === props.read.projectId ? intake.fresh.map((r) => r.request.id) : [];
		return props.day.today().intake.requests.map((r) => r.id);
	};
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
								{(r) => (
									<Issue
										day={props.day}
										item={r().item}
										group={g().key}
										place={r().place}
										project={props.read.projectId}
										list={props.list}
									/>
								)}
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
function Saved(props: { day: Day; read: SavedLinearRead; list: LinearList; embedded?: boolean }) {
	const r = () => props.read;
	const shown = () => configured(r()) && r().configurationCurrent;
	const placement = () => (props.embedded ? "section" : "panel");
	// The open issue is no longer among the rows shown: say so, never open another.
	const lost = () => {
		const id = props.list.open();
		return shown() && !!id && !r().items.some((item) => item.id === id);
	};
	return (
		<>
			<If when={troubleLine(r())}>
				<Notice testID="linear-trouble" placement={placement()} text={troubleLine(r())} />
			</If>
			<If when={!configured(r())}>
				<Notice
					testID="linear-unset"
					placement={placement()}
					text="Linear is not set up for this project, so Pilot saved no issues."
					detail="This is not the same as having none."
				/>
			</If>
			<If when={configured(r()) && !r().configurationCurrent}>
				<Notice
					testID="linear-not-current"
					placement={placement()}
					text="Pilot has not saved issues for this project's current Linear settings yet."
					detail="Nothing is shown. This is not the same as having none."
				/>
			</If>
			<If when={lost()}>
				<Notice
					testID="linear-issue-gone"
					placement={placement()}
					text={
						r().complete
							? "The issue you had open is not in Pilot's saved copy now."
							: "The issue you had open is not among the issues shown here."
					}
				/>
			</If>
			<If when={shown()}>
				<Cycle read={r()} />
				<Issues day={props.day} read={r()} list={props.list} />
			</If>
		</>
	);
}

/** A read for the visible project only. A failed refresh keeps that project's saved copy. */
function linearRead(mirror: LinearMirror, project: () => string | null) {
	const view = mirror.view;
	const read = () => {
		const saved = view().read;
		const id = project();
		return saved && (id === null || saved.projectId === id) ? saved : null;
	};
	const other = () => !!view().read && !read();
	const reads = keepRead(
		() => mirror.source.read(),
		() => !!view().reason && !other(),
		() => !!read(),
	);
	return { view, read, other, reads };
}

type LinearRead = ReturnType<typeof linearRead>;

/** Re-read when intake changes an issue's place, even while Today's badge is offscreen. */
function followIntake(day: Day, refresh: () => void) {
	const intakeKey = () => {
		const i = day.intake?.view();
		return i
			? `${i.fresh.map((r) => `${r.request.id}/${r.revision}`).join(",")}|${i.started.length}|${i.settled.length}`
			: "";
	};
	let seen = intakeKey();
	effect(() => {
		const now = intakeKey();
		if (now === seen) return;
		seen = now;
		untracked(refresh);
	});
}

/** Today's tab and its badge use the same passive saved read as the standalone page. */
export function todayLinear(day: Day, ownProject: () => string | null, showsOwn: () => boolean) {
	const mirror = day.linear;
	const project = () => ownProject() ?? (day.intake?.view().projectId || null);
	const sourceKnown = () => {
		const intake = day.intake?.view();
		const sources =
			intake?.availability === "live" && intake.projectId === project()
				? intake.intake.sources
				: day.today().intake.sources;
		return sources.includes("Linear");
	};
	const read = () => {
		const saved = mirror?.view().read;
		const id = project();
		return saved && (id === null || saved.projectId === id) ? saved : null;
	};
	const shown = () => {
		const r = read();
		return !!mirror && showsOwn() && (r ? configured(r) : sourceKnown());
	};
	if (mirror) {
		let previous: { id: string | null; known: boolean } | undefined;
		effect(() => {
			if (!showsOwn()) return;
			const id = project();
			const known = sourceKnown();
			const before = previous;
			previous = { id, known };
			untracked(() => {
				if (
					before
						? id !== before.id || known !== before.known
						: mirror.view().availability === "idle" || (!!mirror.view().read && !read())
				) {
					void mirror.source.read();
				}
			});
		});
		followIntake(day, () => {
			if (showsOwn() && shown()) void mirror.source.read();
		});
	}
	return { shown, count: () => savedCount(read()), project };
}

function ReadAgain(props: { state: LinearRead; section?: boolean }) {
	const reading = () => props.state.view().reading;
	const label = () => (reading() ? "Reading…" : "Try now");
	const accessibilityLabel = "Read Pilot's saved Linear issues again. This sends nothing and does not ask Linear.";
	const onPress = () => void props.state.reads.now();
	return (
		<If when={props.state.reads.warn()}>
			<If
				when={props.section}
				else={
					<Button
						label={label()}
						icon="refresh"
						testID="linear-read"
						disabled={reading()}
						accessibilityLabel={accessibilityLabel}
						onPress={onPress}
					/>
				}
			>
				<Link
					label={label()}
					testID="linear-read"
					disabled={reading()}
					accessibilityLabel={accessibilityLabel}
					onPress={onPress}
				/>
			</If>
		</If>
	);
}

function ReadNotice(props: { state: LinearRead; embedded?: boolean }) {
	const { view, read, other, reads } = props.state;
	const placement = () => (props.embedded ? "section" : "panel");
	return (
		<>
			<If when={other()}>
				<Notice
					testID="linear-other-project"
					placement={placement()}
					text={
						props.embedded
							? "Pilot has not read the saved Linear issues for this project yet."
							: "Pilot cannot show the issues this page showed before. Its saved copy is now for another project."
					}
					detail="Nothing is shown. This is not the same as having none."
				/>
			</If>
			{/* With issues shown, a failed read says nothing until the shared old-data rule does. */}
			<If when={view().reason && !other() && (!read() || reads.stale())}>
				<Notice
					testID="linear-off"
					placement={placement()}
					text={
						read()
							? staleLine(reads.readAt() ?? 0)
							: `Pilot cannot show your Linear issues here. ${view().reason}`
					}
					detail={read() ? undefined : "This is not the same as having none."}
				/>
			</If>
		</>
	);
}

function SavedAt(props: { read: SavedLinearRead | null }) {
	return (
		<If when={props.read && savedLine(props.read)}>
			<Caption testID="linear-saved" tone="faint">
				{props.read ? savedLine(props.read) : ""}
			</Caption>
		</If>
	);
}

function LinearSections(props: { day: Day; state: LinearRead; list: LinearList; embedded?: boolean }) {
	const { read, view, other } = props.state;
	return (
		<If
			when={read()}
			else={
				<If when={!view().reason && !other()}>
					<Section title="Your issues">
						<EmptyLine text="Reading your saved Linear issues…" />
					</Section>
				</If>
			}
		>
			<Each of={read() ? [read()!] : []} key={(r) => r.projectId}>
				{(r) => <Saved day={props.day} read={r()} list={props.list} embedded={props.embedded} />}
			</Each>
		</If>
	);
}

/** Today already supplies the page, panel and scrolling. */
export function LinearTabContent(props: { day: Day; project: () => string | null }) {
	const open = signal<string | null>(null);
	const leave = () => open.set(null);
	const list: LinearList = { open, leave };
	const state = linearRead(props.day.linear!, props.project);
	let project = props.project();
	effect(() => {
		const next = props.project();
		if (next !== project) leave();
		project = next;
	});
	keymap.bind(
		"escape",
		() => {
			if (!open()) return;
			glide();
			leave();
		},
		{ when: "always" },
	);
	return (
		<Column centered testID="today-linear">
			<Section
				title={linearTitle(state.read())}
				count={savedCount(state.read())}
				action={<ReadAgain state={state} section />}
			>
				<Block>
					<Body tone="muted">{scopeLine}</Body>
					<SavedAt read={state.read()} />
				</Block>
				<ReadNotice state={state} embedded />
			</Section>
			<LinearSections day={props.day} state={state} list={list} embedded />
		</Column>
	);
}

/**
 * The standalone Linear page. Opening it and Try now read Pilot's saved copy;
 * neither asks Linear for anything.
 */
export function LinearScreen(props: { day: Day }) {
	const mirror = props.day.linear!;
	void mirror.source.read();
	followIntake(props.day, () => void mirror.source.read());
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
		const r = mirror.view().read;
		if (r && linearProject() === null) linearProject.set(r.projectId);
	});
	const state = linearRead(mirror, linearProject);
	const list: LinearList = { open: openIssue, focus: focusIssue, leave: closeLinear };
	// A restored offset waits for the rows it scrolled through; until then the kept offset stays.
	let waiting = scroll.contentOffset.y > 0 ? scroll.contentOffset.y : null;
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const node = scroller();
		if (waiting === null || !node || !state.read()) return;
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
					title={linearTitle(state.read())}
					text={scopeLine}
					actions={<ReadAgain state={state} />}
				>
					<SavedAt read={state.read()} />
				</PageHead>
				<Panel testID="linear-panel" notice={<ReadNotice state={state} />}>
					<Column>
						<LinearSections day={props.day} state={state} list={list} />
					</Column>
				</Panel>
				<PageFoot text="Reading the list never starts work or changes Linear." />
			</Page>
		</Scroll>
	);
}
