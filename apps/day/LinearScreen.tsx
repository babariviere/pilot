// The user's own Linear issues that Pilot saved for this project, and the
// cycle Pilot's last sync read. Read only: nothing here changes Linear,
// starts work or triages a request. Requests are triaged in New on Today;
// this page only points there. An issue's chat or mission comes from its
// saved IDs, never from a matching title or link. The page says when the
// copy was saved, says when it is not complete and never claims to show
// the team's issues or other cycles.
// A close or an update keeps the page, its project, the open issue and the
// scroll offset (updateView.ts). The restored page reads again, as opening
// it does, and shows nothing when the read is for another project.
import { effect, keymap, Scroll, type ScrollRef, signal, Text, View, type ViewRef } from "nsh";
import { Button, Collapsible } from "nsh/base";
import type { MissionRow } from "pilot-day/native";
import type { Day } from "./day";
import { openRequest } from "./Incoming";
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
import { glide } from "./motion";
import { Action, InlineAction, Mark, type MarkKind, SectionTitle } from "./ui";
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

/** A quiet note with a mark, for trouble and for what is not shown. */
function Note(props: { testID: string; text: string; detail?: string }) {
	return (
		<View testID={props.testID} class="gap-1.5 rounded-xl bg-muted px-4 py-3">
			<View class="flex-row items-center gap-2.5">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-foreground">{props.text}</Text>
			</View>
			<If when={props.detail}>
				<Text class="text-xs text-faint">{props.detail ?? ""}</Text>
			</If>
		</View>
	);
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
function Issue(props: { item: TrackedItem; group: GroupKey; place: Place }) {
	const i = () => props.item;
	const open = () => openIssue() === i().id;
	const key = () => identifierOf(i());
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
		<Collapsible
			open={open()}
			class="border-t border-border"
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
					</View>
				</View>
			}
		>
			<Button
				ref={(n: ViewRef) => node.set(n)}
				testID={`linear-issue-${i().id}`}
				accessibilityLabel={`${i().title}, ${i().status}. ${placeWord(props.place)}. ${open() ? "Hide" : "Show"} its details.`}
				onPress={() => {
					glide();
					openIssue.set(open() ? null : i().id);
					node()?.focus();
				}}
				class="group gap-1 rounded-md py-3 focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				<View class="flex-row items-center gap-2.5">
					<Mark kind={MARK[props.group]} />
					<Text class="flex-1 text-sm font-medium text-foreground group-hover:underline">{i().title}</Text>
					<Text class="text-xs text-muted-foreground">{i().status}</Text>
				</View>
				<View class="flex-row gap-2.5">
					<View class="size-2" />
					<Text class="flex-1 text-xs text-faint">
						{[key(), placeWord(props.place)].filter(Boolean).join(" · ")}
					</Text>
				</View>
			</Button>
		</Collapsible>
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
				<Note
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
							{(r) => <Issue item={r().item} group={g().key} place={r().place} />}
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
				<Note testID="linear-trouble" text={troubleLine(r())} />
			</If>
			<If
				when={configured()}
				else={
					<Note
						testID="linear-unset"
						text="Linear is not set up for this project, so Pilot saved no issues."
						detail="This is not the same as having none."
					/>
				}
			>
				<If
					when={r().configurationCurrent}
					else={
						<Note
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
			<View testID="linear" class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-10">
				<View class="gap-2">
					<Text class="text-xs text-faint">Linear · read only</Text>
					<Text role="header" class="text-3xl font-semibold leading-tight tracking-tight text-foreground">
						{linearTitle(read())}
					</Text>
					<Text class="text-base leading-relaxed text-muted-foreground">
						Your own issues that Pilot saved for this project. Not your team's other issues or other cycles.
					</Text>
					<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
						<If when={read() && savedLine(read() as SavedLinearRead)}>
							<Text testID="linear-saved" class="flex-1 text-xs text-faint">
								{read() ? savedLine(read() as SavedLinearRead) : ""}
							</Text>
						</If>
						<Action
							label={v().reading ? "Reading…" : "Read again"}
							icon="refresh"
							testID="linear-read"
							disabled={v().reading}
							accessibilityLabel="Read Pilot's saved Linear issues again. This sends nothing and does not ask Linear."
							onPress={() => void mirror.source.read()}
						/>
					</View>
				</View>
				<If when={other()}>
					<Note
						testID="linear-other-project"
						text="Pilot cannot show the issues this page showed before. Its saved copy is now for another project."
						detail="Nothing is shown. This is not the same as having none."
					/>
				</If>
				<If when={v().reason && !other()}>
					<Note
						testID="linear-off"
						text={read() ? v().reason : `Pilot cannot show your Linear issues here. ${v().reason}`}
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
					Read only. Nothing here changes Linear, starts work or triages a request.
				</Text>
			</View>
		</Scroll>
	);
}
