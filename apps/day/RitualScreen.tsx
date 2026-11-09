// The start and end of the day, and the standup notes. Short, calm and
// read-only: they only read Today's read model and send no intent. Skipping
// or leaving a ritual changes nothing in Pilot; decisions stay on Today.
import { effect, keymap, Scroll, signal, Text, View, type ViewRef } from "nsh";
import type { DoneEntry, MissionRow } from "pilot-day/native";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import {
	basisWord,
	greeting,
	itemEffort,
	itemTitle,
	missionRows,
	moreResults,
	nextLine,
	recapResults,
	resultsLine,
	sinceLine,
	standup,
	things,
	waitingLine,
} from "./ritual";
import {
	backFromStandup,
	closeRitual,
	mark,
	markOf,
	openStandup,
	type RitualMark,
	ritualRoute,
	startStep,
} from "./ritualView";
import { FreshnessNote, MissionStatus, TopBar } from "./TodayScreen";
import { Action, Mark, type MarkKind, SectionTitle } from "./ui";
import { focused, focusFront, type Item, queue } from "./view";
import { freshnessLine, provenance } from "./words";

const STEPS = ["Since you looked", "Needs you", "Coming up today"];

/** The command that runs the screen's one next step, as the platform writes it. */
const NEXT_KEY = keymap.label("mod+enter");

/** Gives the keyboard focus to the primary command each time a new one appears. */
function primaryFocus(): (node: ViewRef) => void {
	const node = signal<ViewRef | null>(null);
	effect(() => node()?.focus());
	return (next) => node.set(next);
}

function resultMark(entry: DoneEntry): MarkKind {
	if (entry.evidence.some((x) => x.tone === "bad")) return "failed";
	if (entry.evidence.some((x) => x.tone === "warn")) return "needs";
	return "done";
}

function Title(props: { text: string; lead: string }) {
	return (
		<View class="gap-2">
			<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
				{props.text}
			</Text>
			<Text class="text-base leading-relaxed text-muted-foreground">{props.lead}</Text>
		</View>
	);
}

/** Results since the user looked, each with what it rests on. */
function Results(props: { day: Day; title: string }) {
	const today = () => props.day.today();
	const shown = () => recapResults(today());
	return (
		<View testID="results" class="gap-1">
			<View class="pb-1">
				<SectionTitle title={props.title} />
			</View>
			<If when={shown().length > 0} else={<Text class="text-sm text-muted-foreground">No results since then.</Text>}>
				<Each of={shown()} key={(d) => d.id}>
					{(d) => (
						<View class="flex-row gap-3 py-2">
							<View class="pt-1.5">
								<Mark kind={resultMark(d())} />
							</View>
							<View class="flex-1 gap-0.5">
								<Text class="text-sm text-foreground">{d().text}</Text>
								<Text class="text-xs text-faint">{`${d().missionTitle} · ${basisWord(d().basis)}`}</Text>
							</View>
						</View>
					)}
				</Each>
			</If>
			<If when={moreResults(today()) > 0}>
				<Text class="pt-1 text-xs text-faint">{`${moreResults(today())} more not listed here.`}</Text>
			</If>
			<If when={shown().some((d) => d.basis === "reported")}>
				<Text class="pt-1 text-xs text-faint">
					Agent reports are the agents' own words. Pilot has not checked them.
				</Text>
			</If>
		</View>
	);
}

/** Where the user left off, when Today knows. */
function LeftOff(props: { day: Day }) {
	return (
		<If when={props.day.today().leftOff}>
			<View testID="left-off" class="gap-1">
				<SectionTitle title="Where you left off" />
				<Text class="text-sm text-foreground">{props.day.today().leftOff ?? ""}</Text>
			</View>
		</If>
	);
}

/** What waits for the user, in Today's order. */
function Waiting(props: { items: Item[] }) {
	return (
		<View class="gap-0.5">
			<Each of={props.items} key={(item) => item.id}>
				{(item) => (
					<View class="flex-row items-center gap-2.5 py-1.5">
						<Mark
							kind={
								item().kind === "decision"
									? decisionMark((item() as Extract<Item, { kind: "decision" }>).decision)
									: "needs"
							}
						/>
						<Text class="flex-1 text-sm text-foreground">{itemTitle(item())}</Text>
						<Text class="text-xs text-faint">{itemEffort(item())}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

/** One mission and its agent's next step, with where that comes from. */
function MissionPlan(props: { row: MissionRow }) {
	return (
		<View class="gap-1 border-t border-border py-3">
			<View class="flex-row items-baseline gap-3">
				<Text class="flex-1 text-sm font-medium text-foreground">{props.row.title}</Text>
				<MissionStatus row={props.row} />
			</View>
			<Text class="text-sm text-muted-foreground">{nextLine(props.row)}</Text>
			<If when={props.row.report}>
				<Text class="text-xs text-faint">{props.row.report ? provenance(props.row.report) : ""}</Text>
			</If>
		</View>
	);
}

function Missions(props: { rows: MissionRow[] }) {
	return (
		<View class="gap-1">
			<View class="pb-1">
				<SectionTitle title="Missions" count={props.rows.length} />
			</View>
			<If when={props.rows.length > 0} else={<Text class="text-sm text-muted-foreground">No active missions.</Text>}>
				<Each of={props.rows} key={(m) => m.id}>
					{(m) => <MissionPlan row={m()} />}
				</Each>
			</If>
		</View>
	);
}

/** What happens next by time, as Today lists it. Shown, never started here. */
function Scheduled(props: { day: Day }) {
	return (
		<If when={props.day.today().comingUp.length > 0}>
			<View class="gap-1">
				<View class="pb-1">
					<SectionTitle title="Scheduled" />
				</View>
				<Each of={props.day.today().comingUp} key={(s) => s.id}>
					{(s) => (
						<View class="flex-row gap-3 py-1.5">
							<Text class="flex-1 text-sm text-foreground">{s().text}</Text>
							<Text class="text-xs text-faint">{s().when}</Text>
						</View>
					)}
				</Each>
			</View>
		</If>
	);
}

function Back(props: { label?: string; onPress: () => void }) {
	return (
		<View class="flex-row">
			<Action
				label={`‹ ${props.label ?? "Today"}`}
				accessibilityLabel={`Back to ${props.label ?? "Today"}`}
				onPress={props.onPress}
			/>
		</View>
	);
}

/**
 * The start of the day in three short steps: what happened since the user
 * looked, what needs them, and what comes up today. Each step can be
 * skipped; skipping marks only this ritual for the day.
 */
function StartDay(props: { day: Day }) {
	const today = () => props.day.today();
	const step = () => startStep();
	const items = () => queue(today());
	const first = () => items()[0];
	const anchor = primaryFocus();

	const finish = (how: RitualMark) => {
		mark(today(), "start", how);
		closeRitual();
	};
	const next = () => startStep.set(Math.min(STEPS.length - 1, step() + 1));
	const back = () => startStep.set(Math.max(0, step() - 1));
	// Brings Today's first item to the front with the keyboard focus. It
	// answers nothing: the user decides on Today's card.
	const decideNow = () => {
		mark(today(), "start", "done");
		closeRitual();
		focused.set(null);
		focusFront.set(true);
	};
	const primary = () => {
		if (step() === 1 && first()) decideNow();
		else if (step() < STEPS.length - 1) next();
		else finish("done");
	};
	const primaryLabel = () => {
		if (step() === 1 && first()) return first()?.kind === "decision" ? "Decide now" : "Open it";
		return step() < STEPS.length - 1 ? "Next" : "Start the day";
	};
	keymap.bind({ escape: closeRitual, "mod+enter": primary });

	return (
		<View testID="start-of-day" class="gap-8">
			<Back onPress={closeRitual} />
			<Text class="text-xs text-muted-foreground">{`Step ${step() + 1} of ${STEPS.length} · ${STEPS[step()]}`}</Text>
			<If when={step() === 0}>
				<View class="gap-8">
					<View class="gap-3">
						<Title text={greeting(today())} lead={sinceLine(today())} />
						<FreshnessNote day={props.day} />
					</View>
					<LeftOff day={props.day} />
					<If when={today().visit !== "first"}>
						<Results day={props.day} title="Results" />
					</If>
				</View>
			</If>
			<If when={step() === 1}>
				<View class="gap-6">
					<Title
						text={
							items().length > 0
								? `${things(items().length)} ${items().length === 1 ? "needs" : "need"} you.`
								: "Nothing needs you."
						}
						lead={
							items().length > 0
								? "Each waits on Today with its context and Pilot's recommendation. They stay there until you answer them."
								: "Pilot keeps going on its own."
						}
					/>
					<Waiting items={items()} />
				</View>
			</If>
			<If when={step() === 2}>
				<View class="gap-8">
					<Title
						text="Coming up today"
						lead="From each mission's latest agent report. These are the agents' own plans; Pilot has not checked them."
					/>
					<Missions rows={missionRows(today())} />
					<Scheduled day={props.day} />
				</View>
			</If>
			<View class="flex-row flex-wrap items-center gap-2 border-t border-border pt-5">
				<Action primary label={primaryLabel()} shortcut={NEXT_KEY} anchor={anchor} onPress={primary} />
				<If when={step() === 1 && items().length > 0}>
					<Action label="Next" onPress={next} />
				</If>
				<If when={step() === 2}>
					<Action label="Standup notes" onPress={() => openStandup("start")} />
				</If>
				<If when={step() > 0}>
					<Action label="Back" onPress={back} />
				</If>
				<View class="flex-1" />
				<Action label="Skip for today" onPress={() => finish("skipped")} />
			</View>
		</View>
	);
}

/** The day closed: where tomorrow starts, and the way back. */
function Closed(props: { day: Day; anchor: (node: ViewRef) => void }) {
	const today = () => props.day.today();
	const cue = () => {
		const first = queue(today())[0];
		if (first) return `Tomorrow starts with: ${itemTitle(first)}.`;
		return today().leftOff ? `Where you left off: ${today().leftOff}` : "";
	};
	return (
		<View testID="day-closed" class="gap-6 pt-6">
			<Title text="Done for today." lead="Moving missions keep going. Pilot tells you if something needs you." />
			<If when={cue()}>
				<Text class="text-sm text-foreground">{cue()}</Text>
			</If>
			<View class="flex-row flex-wrap items-center gap-2">
				<Action primary label="Back to Today" testID="closed-today" anchor={props.anchor} onPress={closeRitual} />
				<Action label="Standup notes" onPress={() => openStandup("end")} />
			</View>
		</View>
	);
}

/**
 * The end of the day on one page: results since the user looked, what still
 * waits, missions that are not moving and what comes up. Closing the day
 * changes nothing in Pilot.
 */
function EndDay(props: { day: Day }) {
	const today = () => props.day.today();
	const items = () => queue(today());
	const closed = () => markOf(today(), "end") === "done";
	const stopped = () => [...today().notMoving, ...today().unreported];
	const anchor = primaryFocus();
	const close = () => mark(today(), "end", "done");
	keymap.bind({ escape: closeRitual, "mod+enter": () => (closed() ? closeRitual() : close()) });

	return (
		<View testID="end-of-day" class="gap-8">
			<Back onPress={closeRitual} />
			<If when={!closed()} else={<Closed day={props.day} anchor={anchor} />}>
				<View class="gap-10">
					<View class="gap-3">
						<Title text="Wrapping up." lead={`${resultsLine(today())} ${waitingLine(today())}`} />
						<FreshnessNote day={props.day} />
					</View>
					<Results day={props.day} title="Done since you looked" />
					<If when={items().length > 0}>
						<View class="gap-1">
							<SectionTitle title="Still waiting" count={items().length} />
							<Text class="pb-1 text-xs text-muted-foreground">They stay on Today until you answer them.</Text>
							<Waiting items={items()} />
						</View>
					</If>
					<If when={stopped().length > 0}>
						<View class="gap-1">
							<View class="pb-1">
								<SectionTitle title="Not moving or no current report" count={stopped().length} />
							</View>
							<Each of={stopped()} key={(m) => m.id}>
								{(m) => <MissionPlan row={m()} />}
							</Each>
						</View>
					</If>
					<If when={today().moving.length > 0}>
						<View class="gap-1">
							<View class="pb-1">
								<SectionTitle title="Keeps moving" count={today().moving.length} />
							</View>
							<Each of={today().moving} key={(m) => m.id}>
								{(m) => <MissionPlan row={m()} />}
							</Each>
						</View>
					</If>
					<Scheduled day={props.day} />
					<View class="flex-row flex-wrap items-center gap-2 border-t border-border pt-5">
						<Action primary label="Close the day" shortcut={NEXT_KEY} anchor={anchor} onPress={close} />
						<Action label="Standup notes" onPress={() => openStandup("end")} />
						<View class="flex-1" />
						<Action
							label="Skip for today"
							onPress={() => {
								mark(today(), "end", "skipped");
								closeRitual();
							}}
						/>
					</View>
				</View>
			</If>
		</View>
	);
}

/** Standup notes from Today's read: done, next and waiting. Select the text to copy it. */
function Standup(props: { day: Day }) {
	const today = () => props.day.today();
	const note = () => freshnessLine(today().freshness);
	const from = () => {
		const at = ritualRoute();
		return at?.kind === "standup" ? at.from : null;
	};
	keymap.bind("escape", backFromStandup);
	return (
		<View testID="standup-notes" class="gap-6">
			<Back label={from() ? "Back" : "Today"} onPress={backFromStandup} />
			<Title text="Standup notes" lead="Written from Pilot's latest read. Select the text to copy it." />
			<View selectable class="gap-5 rounded-2xl border border-border bg-card px-6 py-5">
				<If when={note()}>
					<Text class="text-sm text-muted-foreground">{note()}</Text>
				</If>
				<Each of={standup(today())} key={(part) => part.title}>
					{(part) => (
						<View class="gap-1">
							<Text class="text-sm font-semibold text-card-foreground">{part().title}</Text>
							<If
								when={part().lines.length > 0}
								else={<Text class="text-sm text-muted-foreground">- Nothing</Text>}
							>
								<Each of={part().lines.map((line, at) => ({ line, at }))} key={(l) => String(l.at)}>
									{(l) => <Text class="text-sm text-card-foreground">{`- ${l().line}`}</Text>}
								</Each>
							</If>
						</View>
					)}
				</Each>
			</View>
			<Text class="text-xs text-faint">
				Each line keeps where it comes from. Agent reports are the agents' own words; Pilot has not checked them.
			</Text>
		</View>
	);
}

/** The ritual or standup notes the user opened. */
export function RitualScreen(props: { day: Day }) {
	const at = () => ritualRoute();
	const readable = () => props.day.today().freshness.state !== "unreadable";
	return (
		<Scroll class="flex-1 bg-background">
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-6">
				<TopBar />
				<If
					when={readable()}
					else={
						<View class="gap-6">
							<Back onPress={closeRitual} />
							<Title
								text="Nothing to recap."
								lead="Pilot could not read Today, so it shows no recap. Nothing here is guessed."
							/>
						</View>
					}
				>
					<If when={at()?.kind === "start"}>
						<StartDay day={props.day} />
					</If>
					<If when={at()?.kind === "end"}>
						<EndDay day={props.day} />
					</If>
					<If when={at()?.kind === "standup"}>
						<Standup day={props.day} />
					</If>
				</If>
			</View>
		</Scroll>
	);
}
