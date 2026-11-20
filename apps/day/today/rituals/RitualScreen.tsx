// The start and end of the day, and the standup notes. Short and calm: they
// read Today's read model and the ritual's saved progress, and send no work
// intent. Next, Back, Done and Skip save only the ritual's own progress for
// the day it opened on; Escape and Back to Today save nothing. Decisions stay
// on Today.
// Each is a form-width page: its head says where the user is, one panel holds
// the step's sections, and the step's commands end the panel.
import { effect, type JSX, keymap, Scroll, signal, View, type ViewRef } from "nsh";
import type { DoneEntry, MissionRow } from "pilot-day/native";
import type { Day } from "../../app/day";
import { keepScroll } from "../../app/kept";
import { focusFront, queue, releaseFront, type Work } from "../../app/view";
import { provenance, stateMark, stateTone, stateWord } from "../../missions/words";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	EmptyLine,
	Link,
	type MarkKind,
	Notice,
	Num,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Row,
	RowDetail,
	Rows,
	Section,
	Spacer,
} from "../../ui";
import { decisionMark } from "../DecisionCard";
import { FreshnessNote } from "../TodayScreen";
import {
	greeting,
	itemEffort,
	itemTitle,
	missionRows,
	moreResults,
	nextLine,
	recapResults,
	resultSource,
	resultsLine,
	sinceLine,
	standup,
	things,
	waitingLine,
} from "./ritual";
import type { Rituals } from "./ritualFeed";
import { backFromStandup, closeRitual, openStandup, ritualRoute, START_STEPS, startStep } from "./ritualView";

const STEPS = ["Since you looked", "Needs you", "Coming up today"].slice(0, START_STEPS);

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

/** The step's commands, at the end of its panel: the primary first, Skip at the far end. */
function Commands(props: { children?: JSX.Element }) {
	return (
		<Block>
			<Buttons>{props.children}</Buttons>
		</Block>
	);
}

/** Results since the user looked, each with what it rests on. Results that could not be read are never "none". */
function Results(props: { day: Day; rituals: Rituals; title: string }) {
	const recap = () => props.rituals.recap(props.day.today());
	const shown = () => recapResults(recap());
	const none = () =>
		recap().state === "off"
			? "Pilot could not read results here. This is not the same as none."
			: "No results since then.";
	return (
		<Section testID="results" title={props.title}>
			<If when={shown().length > 0} else={<EmptyLine text={none()} />}>
				<Rows>
					<Each of={shown()} key={(d) => d.id}>
						{(d) => <Row mark={resultMark(d())} title={d().text} meta={resultSource(d())} wrap selectable />}
					</Each>
				</Rows>
			</If>
			<If when={moreResults(recap()) > 0}>
				<EmptyLine text={`${moreResults(recap())} more not listed here.`} />
			</If>
			<If when={recap().state === "live" && (recap() as { limited: boolean }).limited}>
				<EmptyLine text="Only the newest kept changes were read." />
			</If>
			<If when={shown().some((d) => d.basis === "reported")}>
				<EmptyLine text="Agent reports are the agents' own words. Pilot has not checked them." />
			</If>
		</Section>
	);
}

/** Where the user left off, when Today knows. */
function LeftOff(props: { day: Day }) {
	return (
		<If when={props.day.today().leftOff}>
			<Section testID="left-off" title="Where you left off">
				<Block>
					<Body measure>{props.day.today().leftOff ?? ""}</Body>
				</Block>
			</Section>
		</If>
	);
}

/** What waits for the user, in Today's order. */
function Waiting(props: { items: Work[] }) {
	return (
		<Rows>
			<Each of={props.items} key={(item) => item.id}>
				{(item) => (
					<Row
						mark={
							item().kind === "decision"
								? decisionMark((item() as Extract<Work, { kind: "decision" }>).decision)
								: "needs"
						}
						title={itemTitle(item())}
						trailing={<Num>{itemEffort(item())}</Num>}
					/>
				)}
			</Each>
		</Rows>
	);
}

/** One mission and its agent's next step, with where that comes from. */
function MissionPlan(props: { row: MissionRow }) {
	return (
		<Row
			mark={stateMark(props.row)}
			title={props.row.title}
			meta={nextLine(props.row)}
			state={stateWord(props.row)}
			stateTone={stateTone(props.row)}
			wrap
			detail={
				<If when={props.row.report}>
					<RowDetail>
						<Caption tone="faint">{props.row.report ? provenance(props.row.report) : ""}</Caption>
					</RowDetail>
				</If>
			}
		/>
	);
}

/** A titled list of missions, each with its next step. */
function MissionList(props: { title: string; rows: MissionRow[]; empty?: string }) {
	return (
		<Section title={props.title} count={props.rows.length}>
			<If when={props.rows.length > 0} else={<EmptyLine text={props.empty ?? ""} />}>
				<Rows>
					<Each of={props.rows} key={(m) => m.id}>
						{(m) => <MissionPlan row={m()} />}
					</Each>
				</Rows>
			</If>
		</Section>
	);
}

/** What happens next by time, as Today lists it. Shown, never started here. */
function Scheduled(props: { day: Day }) {
	return (
		<If when={props.day.today().comingUp.length > 0}>
			<Section title="Scheduled">
				<Rows>
					<Each of={props.day.today().comingUp} key={(s) => s.id}>
						{(s) => <Row title={s().text} trailing={<Num>{s().when}</Num>} wrap />}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}

/**
 * What the ritual's saved progress says beside its commands: a refusal, a
 * save Pilot could not confirm (with Read again, which only reads), or a
 * day that changed since the ritual opened. Nothing here sends again.
 */
function SavedNote(props: { rituals: Rituals; context: string }) {
	const r = props.rituals;
	const moved = () => {
		const now = r.progress();
		return now.availability === "available" && now.context !== props.context;
	};
	const line = () =>
		moved()
			? "The day changed since you opened this, so Pilot saves nothing here. Back to Today shows the new day."
			: r.message();
	return (
		<If when={line()}>
			<Notice
				testID="ritual-note"
				placement="section"
				text={line()}
				action={
					<If when={r.uncertain()}>
						<Link label="Read again" icon="refresh" testID="ritual-read" onPress={() => void r.refresh()} />
					</If>
				}
			/>
		</If>
	);
}

/**
 * The start of the day in three short steps: what happened since the user
 * looked, what needs them, and what comes up today. Each step can be
 * skipped; skipping marks only this ritual for the day. Next and Back save
 * where the user is, so the ritual resumes there; a saved step is not Done.
 */
function StartDay(props: { day: Day; rituals: Rituals }) {
	const today = () => props.day.today();
	const r = props.rituals;
	// Every save names the day this ritual opened on; a later day refuses it.
	const context = r.progress().context;
	const step = () => startStep();
	const items = () => queue(today());
	const first = () => items()[0];
	const anchor = primaryFocus();

	/** Saves Done or Skip, and leaves only once it is saved. */
	const finish = async (how: "done" | "skipped") => {
		if (r.saving()) return false;
		const saved = await r.save("start", how, step(), context);
		if (saved) closeRitual();
		return saved;
	};
	/** Shows `to` and saves it as the step to resume at. */
	const go = (to: number) => {
		if (to === step()) return;
		startStep.set(to);
		void r.save("start", "unmarked", to, context);
	};
	const next = () => go(Math.min(STEPS.length - 1, step() + 1));
	const back = () => go(Math.max(0, step() - 1));
	// Brings Today's first item to the front with the keyboard focus. It
	// answers nothing: the user decides on Today's card.
	const decideNow = async () => {
		if (!(await finish("done"))) return;
		releaseFront();
		focusFront.set(true);
	};
	const primary = () => {
		if (step() === 1 && first()) void decideNow();
		else if (step() < STEPS.length - 1) next();
		else void finish("done");
	};
	const primaryLabel = () => {
		if (step() === 1 && first()) return first()?.kind === "decision" ? "Decide now" : "Open it";
		return step() < STEPS.length - 1 ? "Next" : "Start the day";
	};
	keymap.bind({ escape: closeRitual, "mod+enter": primary });

	return (
		<View testID="start-of-day">
			<PageHead
				pre={<Caption>{`Step ${step() + 1} of ${STEPS.length} · ${STEPS[step()]}`}</Caption>}
				title={
					step() === 0
						? greeting(today())
						: step() === 1
							? items().length > 0
								? `${things(items().length)} ${items().length === 1 ? "needs" : "need"} you.`
								: "Nothing needs you."
							: "Coming up today"
				}
				text={
					step() === 0
						? sinceLine(today())
						: step() === 1
							? items().length > 0
								? "Each waits on Today with its context and Pilot's recommendation. They stay there until you answer them."
								: "Pilot keeps going on its own."
							: "From each mission's latest agent report. These are the agents' own plans; Pilot has not checked them."
				}
			/>
			<Panel
				testID="ritual-panel"
				notice={
					<If when={step() === 0}>
						<FreshnessNote day={props.day} placement="panel" />
					</If>
				}
			>
				<Column>
					<If when={step() === 0}>
						<LeftOff day={props.day} />
						<If when={today().visit !== "first"}>
							<Results day={props.day} rituals={r} title="Results" />
						</If>
					</If>
					<If when={step() === 1 && items().length > 0}>
						<Section title="Needs you" count={items().length}>
							<Waiting items={items()} />
						</Section>
					</If>
					<If when={step() === 2}>
						<MissionList title="Missions" rows={missionRows(today())} empty="No active missions." />
						<Scheduled day={props.day} />
					</If>
					<SavedNote rituals={r} context={context} />
					<Commands>
						<Button kind="primary" label={primaryLabel()} shortcut={NEXT_KEY} anchor={anchor} onPress={primary} />
						<If when={step() === 1 && items().length > 0}>
							<Button label="Next" onPress={next} />
						</If>
						<If when={step() === 2}>
							<Button label="Standup notes" onPress={() => openStandup("start")} />
						</If>
						<If when={step() > 0}>
							<Button label="Back" onPress={back} />
						</If>
						<Spacer />
						<Button label="Skip for today" onPress={() => void finish("skipped")} />
					</Commands>
				</Column>
			</Panel>
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
		<View testID="day-closed">
			<PageHead title="Done for today." text="Moving missions keep going. Pilot tells you if something needs you." />
			<Panel>
				<Column>
					<If when={cue()}>
						<Section title="Tomorrow">
							<Block>
								<Body measure>{cue()}</Body>
							</Block>
						</Section>
					</If>
					<Commands>
						<Button
							kind="primary"
							label="Back to Today"
							testID="closed-today"
							anchor={props.anchor}
							onPress={closeRitual}
						/>
						<Button label="Standup notes" onPress={() => openStandup("end")} />
					</Commands>
				</Column>
			</Panel>
		</View>
	);
}

/**
 * The end of the day on one page: results since the user looked, what still
 * waits, missions that are not moving and what comes up. Closing the day
 * saves only that the user closed it; it changes nothing else in Pilot.
 */
function EndDay(props: { day: Day; rituals: Rituals }) {
	const today = () => props.day.today();
	const r = props.rituals;
	// Every save names the day this ritual opened on; a later day refuses it.
	const context = r.progress().context;
	const items = () => queue(today());
	// Only the saved mark closes the day, never the press itself.
	const closed = () => {
		const now = r.progress();
		return now.context === context && now.end.mark === "done";
	};
	const stopped = () => [...today().notMoving, ...today().unreported];
	const anchor = primaryFocus();
	const close = () => {
		if (!r.saving()) void r.save("end", "done", 0, context);
	};
	const skip = async () => {
		if (r.saving()) return;
		if (await r.save("end", "skipped", 0, context)) closeRitual();
	};
	keymap.bind({ escape: closeRitual, "mod+enter": () => (closed() ? closeRitual() : close()) });

	return (
		<View testID="end-of-day">
			<If when={!closed()} else={<Closed day={props.day} anchor={anchor} />}>
				<PageHead title="Wrapping up." text={`${resultsLine(today(), r.recap(today()))} ${waitingLine(today())}`} />
				<Panel testID="ritual-panel" notice={<FreshnessNote day={props.day} placement="panel" />}>
					<Column>
						<Results day={props.day} rituals={r} title="Done since you looked" />
						<If when={items().length > 0}>
							<Section title="Still waiting" count={items().length}>
								<Block>
									<Caption>They stay on Today until you answer them.</Caption>
								</Block>
								<Waiting items={items()} />
							</Section>
						</If>
						<If when={stopped().length > 0}>
							<MissionList title="Not moving or no current report" rows={stopped()} />
						</If>
						<If when={today().moving.length > 0}>
							<MissionList title="Keeps moving" rows={today().moving} />
						</If>
						<Scheduled day={props.day} />
						<SavedNote rituals={r} context={context} />
						<Commands>
							<Button kind="primary" label="Close the day" shortcut={NEXT_KEY} anchor={anchor} onPress={close} />
							<Button label="Standup notes" onPress={() => openStandup("end")} />
							<Spacer />
							<Button label="Skip for today" onPress={() => void skip()} />
						</Commands>
					</Column>
				</Panel>
			</If>
		</View>
	);
}

/** Standup notes from Today's read and the recap's results: done, next and waiting. Select the text to copy it. */
function Standup(props: { day: Day; rituals: Rituals }) {
	const today = () => props.day.today();
	keymap.bind("escape", backFromStandup);
	return (
		<>
			<PageHead title="Standup notes" text="Written from Pilot's latest read. Select the text to copy it." />
			<Panel notice={<FreshnessNote day={props.day} placement="panel" />}>
				<Column>
					<View testID="standup-notes" selectable>
						<Each of={standup(today(), props.rituals.recap(today()))} key={(part) => part.title}>
							{(part) => (
								<Section title={part().title}>
									<Block gap={1}>
										<If when={part().lines.length > 0} else={<Body tone="muted">- Nothing</Body>}>
											<Each of={part().lines.map((line, at) => ({ line, at }))} key={(l) => String(l.at)}>
												{(l) => <Body>{`- ${l().line}`}</Body>}
											</Each>
										</If>
									</Block>
								</Section>
							)}
						</Each>
					</View>
				</Column>
			</Panel>
			<PageFoot text="Each line keeps where it comes from. Agent reports are the agents' own words; Pilot has not checked them." />
		</>
	);
}

/** The ritual or standup notes the user opened. */
export function RitualScreen(props: { day: Day; rituals: Rituals }) {
	const at = () => ritualRoute();
	const readable = () => props.day.today().freshness.state !== "unreadable";
	const scroll = keepScroll("ritual");
	return (
		<Scroll class="flex-1" contentOffset={scroll.contentOffset} scrollEventThrottle={100} onScroll={scroll.onScroll}>
			<Page width="form">
				<If
					when={readable()}
					else={
						<PageHead
							title="Nothing to recap."
							text="Pilot could not read Today, so it shows no recap. Nothing here is guessed."
						/>
					}
				>
					<If when={at()?.kind === "start"}>
						<StartDay day={props.day} rituals={props.rituals} />
					</If>
					<If when={at()?.kind === "end"}>
						<EndDay day={props.day} rituals={props.rituals} />
					</If>
					<If when={at()?.kind === "standup"}>
						<Standup day={props.day} rituals={props.rituals} />
					</If>
				</If>
			</Page>
		</Scroll>
	);
}
