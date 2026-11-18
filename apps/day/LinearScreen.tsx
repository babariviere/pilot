// The user's own Linear issues that Pilot saved for this project, and the
// cycle Pilot's last sync read. Reading never starts work. The open issue
// reuses Today's explicit start and prefill actions. A chat or mission comes from its
// saved IDs, never from a matching title or link. The page says when the
// copy was saved, says when it is not complete and never claims to show
// the team's issues or other cycles.
// A close or an update keeps the page, its project, the open issue and the
// scroll offset (windowState.ts). The restored page reads again, as opening
// it does, and shows nothing when the read is for another project.
import { effect, keymap, Scroll, type ScrollRef, signal, Text, View, type ViewRef } from "nsh";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "./day";
import { keepRead, staleLine } from "./freshness";
import { IntakeWorkControls, openMissions, openRequest } from "./Incoming";
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
	Action,
	ExpandableRow,
	glide,
	InlineAction,
	Mark,
	type MarkKind,
	Notice,
	Page,
	PageTitle,
	SectionTitle,
} from "./ui";
import { openMission } from "./view";

const MARK: Record<GroupKey, MarkKind> = {
	started: "moving",
	todo: "still",
	done: "done",
	closed: "done",
	other: "unknown",
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
		<View testID="linear-cycle" class="gap-2">
			<If
				when={cycle()}
				else={
					<Text class="text-sm text-muted-foreground">
						{linear()?.statusMessage || "Linear has no active cycle for this team. Pilot saved your open issues."}
					</Text>
				}
			>
				<Text class="text-sm text-foreground">{cycle() ? cycleLine(cycle() as LinearCycleSummary) : ""}</Text>
				<View class="h-1 w-40 flex-row overflow-hidden rounded-full bg-track">
					<View class="h-full bg-ok" style={{ flexGrow: cycle()?.done ?? 0, flexBasis: 0 }} />
					<View class="h-full bg-progress" style={{ flexGrow: cycle()?.inProgress ?? 0, flexBasis: 0 }} />
					<View class="h-full" style={{ flexGrow: cycle()?.todo ?? 0, flexBasis: 0 }} />
				</View>
				<Text class="text-xs text-faint">{cycle() ? progressLine(cycle() as LinearCycleSummary) : ""}</Text>
			</If>
		</View>
	);
}

/** What the user can do from an issue's place: go to its mission or to New. Both only move. */
function PlaceAction(props: { place: Place; itemId: string }) {
	const p = () => props.place;
	return (
		<View class="flex-row flex-wrap items-baseline gap-x-1.5">
			<Text class="min-w-0 shrink text-sm text-foreground">{placeSentence(p())}</Text>
			<If when={p().kind === "mission" && (p() as Extract<Place, { kind: "mission" }>).title}>
				<InlineAction
					label="Open the mission"
					testID={`linear-mission-${props.itemId}`}
					onPress={() => {
						const id = (p() as Extract<Place, { kind: "mission" }>).missionId;
						closeLinear();
						openMission(id);
					}}
				/>
			</If>
			<If when={p().kind === "new"}>
				<InlineAction
					label="Show it in New"
					testID={`linear-new-${props.itemId}`}
					onPress={() => {
						closeLinear();
						glide();
						openRequest.set(props.itemId);
					}}
				/>
			</If>
		</View>
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
		<ExpandableRow
			open={open()}
			anchor={(n: ViewRef) => node.set(n)}
			testID={`linear-issue-${i().id}`}
			accessibilityLabel={`${i().title}, ${i().status}. ${placeWord(props.place)}. ${open() ? "Hide" : "Show"} its details.`}
			onToggle={() => {
				glide();
				openIssue.set(open() ? null : i().id);
				node()?.focus();
			}}
			summaryClass="gap-1 py-3"
			content={
				<View testID={`linear-detail-${i().id}`} class="flex-row gap-2.5 pb-3.5">
					<View class="size-2" />
					<View class="flex-1 gap-2">
						<PlaceAction place={props.place} itemId={i().id} />
						<If when={earlierLine(i())}>
							<Text class="text-xs text-muted-foreground">{earlierLine(i())}</Text>
						</If>
						<If when={i().linearParent}>
							<Text class="text-xs text-muted-foreground">
								{`Sub-issue of ${i().linearParent?.identifier ?? ""} · ${i().linearParent?.title ?? ""}`}
							</Text>
						</If>
						<Text class="text-xs text-faint">{i().url}</Text>
						<If when={size()}>
							<Text class="text-sm text-muted-foreground">{`Suggested size: ${size()}. You choose how to start.`}</Text>
						</If>
						<If when={sync()}>
							<Text class="text-sm text-muted-foreground">
								{sync()?.reconcilePlan
									? "Review the linked work. Linear closed the issue without changing the Pilot plan."
									: sync()?.reassigned
										? "Work is held because Linear assigned the issue to someone else."
										: sync()?.error ||
											sync()?.reason ||
											"Pilot manages progress and review. You mark the issue complete."}
							</Text>
						</If>
						<If when={management() && !!props.day.linear?.source.manage}>
							<View class="flex-row flex-wrap gap-2">
								<If when={!management()?.enabled}>
									<Action
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
									<Action
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
									<Action
										label="Resume status sync"
										disabled={managing()}
										onPress={() => void changeManagement("resume")}
									/>
								</If>
							</View>
							<If when={managementMessage()}>
								<Text class="text-sm text-needs-ink">{managementMessage()}</Text>
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
									workOnly
									fromLinearList
									onStarted={closeLinear}
								/>
							)}
						</Each>
					</View>
				</View>
			}
		>
			<View class="flex-row items-center gap-2.5">
				<Mark kind={MARK[props.group]} />
				<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{i().title}</Text>
				<Text class="text-xs text-muted-foreground">{i().status}</Text>
			</View>
			<View class="flex-row gap-2.5">
				<View class="size-2" />
				<Text class="flex-1 text-xs text-faint">{[key(), placeWord(props.place)].filter(Boolean).join(" · ")}</Text>
			</View>
		</ExpandableRow>
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
	// The open issue is no longer among the rows shown: say so, never open another.
	const lost = () => {
		const id = openIssue();
		return !!id && !props.read.items.some((item) => item.id === id);
	};
	return (
		<View class="gap-8">
			<If when={lost()}>
				<Notice
					testID="linear-issue-gone"
					text={
						props.read.complete
							? "The issue you had open is not in Pilot's saved copy now."
							: "The issue you had open is not among the issues shown here."
					}
				/>
			</If>
			<If when={props.read.items.length === 0}>
				<Text testID="linear-empty" class="text-base text-muted-foreground">
					{props.read.total === 0 ? "Pilot saved no issues of yours here." : ""}
				</Text>
			</If>
			<Each of={groups()} key={(g) => g.key}>
				{(g) => (
					<View testID={`linear-group-${g().key}`} class="gap-0.5">
						<View class="pb-1">
							<SectionTitle title={g().title} count={g().rows.length} />
						</View>
						<Each of={g().rows} key={(r) => r.item.id}>
							{(r) => <Issue day={props.day} item={r().item} group={g().key} place={r().place} />}
						</Each>
					</View>
				)}
			</Each>
			<If when={countLine(props.read)}>
				<Text testID={props.read.complete ? "linear-complete" : "linear-more"} class="text-xs text-faint">
					{countLine(props.read)}
				</Text>
			</If>
		</View>
	);
}

/** A read Pilot could show: the source's state, then the cycle and the issues when they are current. */
function Saved(props: { day: Day; read: SavedLinearRead }) {
	const r = () => props.read;
	const configured = () => r().source.configured && r().source.status !== "not_configured";
	return (
		<View class="gap-8">
			<If when={troubleLine(r())}>
				<Notice testID="linear-trouble" text={troubleLine(r())} />
			</If>
			<If
				when={configured()}
				else={
					<Notice
						testID="linear-unset"
						text="Linear is not set up for this project, so Pilot saved no issues."
						detail="This is not the same as having none."
					/>
				}
			>
				<If
					when={r().configurationCurrent}
					else={
						<Notice
							testID="linear-not-current"
							text="Pilot has not saved issues for this project's current Linear settings yet."
							detail="Nothing is shown. This is not the same as having none."
						/>
					}
				>
					<Cycle read={r()} />
					<Issues day={props.day} read={r()} />
				</If>
			</If>
		</View>
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
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={(e) => {
				if (waiting === null) scroll.onScroll(e);
			}}
		>
			<Page testID="linear" gap={8}>
				<View class="gap-2">
					<Text class="text-xs text-faint">Linear</Text>
					<PageTitle title={linearTitle(read())} />
					<Text class="text-base leading-relaxed text-muted-foreground">
						Your own issues that Pilot saved for this project. Not your team's other issues or other cycles.
					</Text>
					<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
						<If when={read() && savedLine(read() as SavedLinearRead)}>
							<Text testID="linear-saved" class="flex-1 text-xs text-faint">
								{read() ? savedLine(read() as SavedLinearRead) : ""}
							</Text>
						</If>
						<If when={reads.warn()}>
							<Action
								label={v().reading ? "Reading…" : "Try now"}
								icon="refresh"
								testID="linear-read"
								disabled={v().reading}
								accessibilityLabel="Read Pilot's saved Linear issues again. This sends nothing and does not ask Linear."
								onPress={() => void reads.now()}
							/>
						</If>
					</View>
				</View>
				<If when={other()}>
					<Notice
						testID="linear-other-project"
						text="Pilot cannot show the issues this page showed before. Its saved copy is now for another project."
						detail="Nothing is shown. This is not the same as having none."
					/>
				</If>
				{/* With issues shown, a failed read says nothing until the shared old-data rule does. */}
				<If when={v().reason && !other() && (!read() || reads.stale())}>
					<Notice
						testID="linear-off"
						text={
							read()
								? staleLine(reads.readAt() ?? 0)
								: `Pilot cannot show your Linear issues here. ${v().reason}`
						}
						detail={read() ? undefined : "This is not the same as having none."}
					/>
				</If>
				<If
					when={read()}
					else={
						<If when={!v().reason && !other()}>
							<Text class="text-base text-muted-foreground">Reading your saved Linear issues…</Text>
						</If>
					}
				>
					<Each of={read() ? [read() as SavedLinearRead] : []} key={(r) => r.contextDigest}>
						{(r) => <Saved day={props.day} read={r()} />}
					</Each>
				</If>
				<Text class="border-t border-border pt-5 text-xs text-faint">
					Reading the list never starts work or changes Linear.
				</Text>
			</Page>
		</Scroll>
	);
}
