// Today: what needs the user, which missions move, what landed and what
// comes next. Read-only over the Rust read model, except through intents.
// Movement comes only from agents' reports; a mission without a current
// report is shown as such, never as not moving.
// One panel under the page's head. Its tabs filter it: Overview shows every
// section in two columns (what needs the user at the left, what moves at the
// right); Needs you, New, Linear, Working and Missions show one part.
import { effect, keymap, Scroll, type ScrollRef, signal } from "nsh";
import type { Decision, MissionRow } from "pilot-day/native";
import { ActionCard } from "./ActionCard";
import { CyberSuggestions } from "./CyberSuggestions";
import { commit, later, pickNth, toggleHelp, writeReply } from "./commands";
import { DayActions, DayDate, DayNotes, visitToday } from "./DayLine";
import { DecisionCard, decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { FeedbackIncoming, feedbackFocus, incomingFeedback, newFeedback } from "./FeedbackIncoming";
import { FinishedToday } from "./FinishedToday";
import { everRead, todayWarning } from "./freshness";
import { RequestNotes, requestChecks, requestLine, todayRequests } from "./Incoming";
import { todayScrollTo } from "./kept";
import { LinearTabContent, todayLinear } from "./LinearScreen";
import { goSchedules } from "./nav";
import { PlannerInterviewCards, type PlannerInterviews, plannerInterviews } from "./PlannerInterviews";
import { stageMark, stageWord } from "./PlanScreen";
import { Problems } from "./Problems";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { RequestCard } from "./RequestCard";
import { ResultCard } from "./ResultCard";
import type { Rituals } from "./ritualFeed";
import {
	bindScopeReads,
	OtherMissions,
	OtherNeeds,
	OtherNotShown,
	OtherPlanning,
	OtherToCheck,
	otherMissionsCount,
	otherNeedsCount,
	otherRequestsCount,
	otherResultsCount,
	ProjectLabel,
	ScopeControl,
	ScopeNote,
	type TodayScope,
	todayScope,
} from "./ScopeRows";
import { resultTitle, ToCheck, todayResults, unsettledCount } from "./ToCheck";
import { attentionCounts, attentionHeadline } from "./todayHeadline";
import {
	Arrive,
	Button,
	Caption,
	Column,
	Columns,
	EmptyLine,
	Link,
	Notice,
	Num,
	Page,
	PageFoot,
	PageHead,
	Panel,
	Progress,
	Quote,
	Row,
	RowDetail,
	RowGroup,
	Rows,
	Section,
	State,
	Tab,
	Tabs,
} from "./ui";
import { focused, focusFront, front, type Item, move, openMission, placeRow, queue, todayPlace } from "./view";
import { type WorkingList, WorkingNow, workingList } from "./WorkingNow";
import { provenance, rowLine, stateMark, stateTone, stateWord } from "./words";

function actionFor(decision: Decision | undefined): string {
	if (!decision) return "";
	if (decision.kind === "review") return "Review it";
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "Check it";
	return "Decide";
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** "Two", or "12" past nine. */
function countWord(n: number): string {
	return WORDS[n] ?? String(n);
}

/**
 * The cards Needs you queues that Rust's headline and summary do not count:
 * results to check and new Slack requests.
 */
function waiting(day: Day): { results: number; requests: number } {
	return { results: todayResults(day).length, requests: todayRequests(day).length };
}

/** The headline: the coordinators' summary, until the user starts answering. */
function headline(day: Day, additional: number, interviewsKnown: boolean): string {
	const today = day.today();
	if (today.problems.length > 0) return "Some work needs a look.";
	if (!today.problemsKnown) return "Your last read.";
	// What needs the user was never read: an all-clear headline would be a guess.
	if (!everRead(today.attention.state) && (today.headline.startsWith("Nothing needs you") || today.notes.length > 0)) {
		return "Your last read.";
	}
	const left = today.decisions.length + today.actions.length;
	const w = waiting(day);
	const extra = w.results + additional;
	if (left + extra + newFeedback(day).length === 0 && !interviewsKnown) return "What needs you is not fully known.";
	if (newFeedback(day).length > 0 && left + extra === 0) return "Feedback needs a look.";
	if (today.notes.length === 0) {
		if (extra === 0) return today.headline;
		// Count every card Needs you holds, as its count does, not only the coordinators' questions.
		const n = left + extra + newFeedback(day).length;
		return n === 1 ? "One thing needs you." : `${countWord(n)} things need you.`;
	}
	const rest = left + extra;
	if (rest === 0) return "That was everything. Pilot is back on it.";
	if (rest === 1) return "One thing left.";
	return `${countWord(rest)} things left.`;
}

/** The coordinators' summary, then the results and Slack requests it does not count. */
function summary(day: Day, interviews: number): string {
	const today = day.today();
	const w = waiting(day);
	const some = (n: number, one: string, many: string) =>
		n > 0 ? `${countWord(n).toLowerCase()} ${n === 1 ? one : many}` : "";
	const parts = [
		some(w.results, "result to check", "results to check"),
		some(w.requests, "Slack request", "Slack requests"),
		some(interviews, "planner interview", "planner interviews"),
	].filter(Boolean);
	if (parts.length === 0) return today.summary;
	const words = parts.join(" and ");
	const also = today.decisions.length + today.actions.length > 0 ? "also " : "";
	const line = `${words[0].toUpperCase()}${words.slice(1)} ${also}${w.results + w.requests + interviews === 1 ? "waits" : "wait"} for you.`;
	return today.summary ? `${today.summary} ${line}` : line;
}

/** A mission's state: its mark and words. */
export function MissionStatus(props: { row: MissionRow }) {
	return <State kind={stateMark(props.row)} label={stateWord(props.row)} plain />;
}

function MissionLine(props: { day: Day; row: MissionRow; plans?: Plans }) {
	const decision = () => props.day.today().decisions.find((d) => d.id === props.row.decisionId);
	const place = placeRow(`mission-${props.row.id}`, () => openMission(props.row.id));
	// Old missions are the active ones a complete planning read does not list.
	// Unknown planning shows no label rather than a guess.
	const old = () => {
		const p = props.plans?.planning();
		return p?.availability === "live" && !p.plans.some((plan) => plan.missionId === props.row.id);
	};
	const source = () =>
		[props.row.report ? provenance(props.row.report) : "", props.row.stage, old() ? "Old plan" : ""]
			.filter(Boolean)
			.join(" · ");
	return (
		<Row
			testID={`mission-${props.row.id}`}
			mark={stateMark(props.row)}
			title={props.row.title}
			meta={rowLine(props.row)}
			state={stateWord(props.row)}
			stateTone={stateTone(props.row)}
			trailing={<Progress counts={props.row.progress} />}
			accessibilityLabel={`${props.row.title}, ${stateWord(props.row)}. Open the mission.`}
			anchor={place.anchor}
			onPress={place.press}
			detail={
				<RowDetail>
					<If when={source()}>
						<Caption tone="faint">{source()}</Caption>
					</If>
					<If when={decision()}>
						<Link
							label={actionFor(decision())}
							onPress={() => {
								focused.set(props.row.decisionId ?? null);
								focusFront.set(true);
								todayTab.set("overview");
							}}
						/>
					</If>
				</RowDetail>
			}
		/>
	);
}

function itemTitle(day: Day, item: Item): string {
	if (item.kind === "result") return resultTitle(day, item.entry);
	if (item.kind === "request") return item.row.request.title;
	return item.kind === "decision" ? item.decision.title : item.action.title;
}

/** The words before a queued item's title. */
function upNext(item: Item): string {
	if (item.kind === "result") return "Up next, result to check: ";
	if (item.kind === "request") return `Up next, ${item.row.request.sourceLabel} request: `;
	return item.kind === "decision" ? "Up next: " : "Up next, action for you: ";
}

/** An item's effort, when it has one. */
function effortOf(item: Item): string {
	if (item.kind === "decision") return item.decision.effort;
	return item.kind === "action" ? item.action.effort : "";
}

/** Deferred chat questions wait behind fresh feedback questions, without sending anything. */
function feedbackTurn(day: Day): boolean {
	return (
		newFeedback(day).length > 0 &&
		(newFeedback(day).some((i) => i.id === feedbackFocus()) ||
			queue(day.today()).every((item) => item.kind === "decision" && item.decision.draft.later))
	);
}

/** One card of Needs you, drawn for its kind. */
function QueueCard(props: { day: Day; item: Item; index: number; count: number; later: boolean }) {
	const item = () => props.item;
	return (
		<If
			when={item().kind === "decision"}
			else={
				<If
					when={item().kind === "result"}
					else={
						<If
							when={item().kind === "request" && props.day.intake}
							else={
								<ActionCard
									day={props.day}
									action={(item() as Extract<Item, { kind: "action" }>).action}
									index={props.index}
									count={props.count}
								/>
							}
						>
							<RequestCard
								day={props.day}
								mirror={props.day.intake as NonNullable<Day["intake"]>}
								row={(item() as Extract<Item, { kind: "request" }>).row}
								index={props.index}
								count={props.count}
							/>
						</If>
					}
				>
					<ResultCard
						day={props.day}
						entry={(item() as Extract<Item, { kind: "result" }>).entry}
						index={props.index}
						count={props.count}
					/>
				</If>
			}
		>
			<DecisionCard
				day={props.day}
				decision={(item() as Extract<Item, { kind: "decision" }>).decision}
				index={props.index}
				count={props.count}
				later={props.later}
			/>
		</If>
	);
}

/** Every item Needs you holds for this window, as its count says: cards, checks, other projects, interviews. */
function needsCount(day: Day, ctx: TodayScope, interviews: PlannerInterviews): number {
	const items = queue(day.today(), todayResults(day), todayRequests(day));
	const checks = unsettledCount(day) + requestChecks(day);
	return items.length + newFeedback(day).length + checks + otherNeedsCount(ctx) + interviews.rows().length;
}

/** What waits for the user: one question in front, the rest queued as rows under it. */
function NeedsYou(props: { day: Day; ctx: TodayScope; interviews: PlannerInterviews }) {
	// Results to check queue behind the questions and actions, as cards of their own.
	const results = () => todayResults(props.day);
	// New Slack requests queue last: decisions, actions and results to check come first.
	const requests = () => todayRequests(props.day);
	const items = () => queue(props.day.today(), results(), requests());
	const first = () => (feedbackTurn(props.day) ? undefined : front(props.day.today(), results(), requests()));
	const rest = () => items().filter((item) => item.id !== first()?.id);
	const decisions = () => props.day.today().decisions;
	// What needs the user has its own read. While a refresh runs or after a
	// failed one, the cards from the last good read stay, answerable: Rust
	// checks each answer again before it sends. Only a read that never worked
	// says so, so an unread list never looks empty.
	const readable = () => everRead(props.day.today().attention.state);
	// Checks and request writes whose answer Pilot could not confirm count here too; they show as notices below the cards.
	const checks = () => unsettledCount(props.day) + requestChecks(props.day);
	// A focus request with no card to take it lapses, so a later arrival
	// never takes the focus on its own.
	effect(() => {
		if (focusFront() && !first()) focusFront.set(false);
	});
	const quiet = () =>
		readable() &&
		incomingFeedback(props.day).length === 0 &&
		props.interviews.rows().length === 0 &&
		props.interviews.known() &&
		otherNeedsCount(props.ctx) === 0;
	return (
		<Section title="Needs you" count={needsCount(props.day, props.ctx, props.interviews)}>
			<If
				when={
					props.ctx.tagged() &&
					(items().length > 0 ||
						checks() > 0 ||
						!readable() ||
						props.day.today().notes.length > 0 ||
						incomingFeedback(props.day).length > 0 ||
						props.interviews.rows().some((r) => r.projectId === props.ctx.own()))
				}
			>
				<ProjectLabel name={props.ctx.name(props.ctx.own() ?? "")} own />
			</If>
			{/* Only a connected window can read project setup; mock worlds have no model controls. */}
			<If when={props.day.models}>
				<CyberSuggestions />
			</If>
			<Rows>
				<Each of={props.day.today().notes} key={(note) => note}>
					{(note) => <Row mark="done" title={note()} wrap />}
				</Each>
			</Rows>
			<If
				when={first()}
				else={
					<If
						when={readable()}
						else={
							<Notice
								testID="attention-unread"
								placement="section"
								text="Pilot has not read what needs you yet. It keeps trying; nothing here is guessed."
							/>
						}
					>
						<If when={quiet()}>
							<If when={checks() > 0} else={<EmptyLine testID="today-no-attention" text="Nothing needs you." />}>
								<EmptyLine text="Nothing else waits for you. Check the notes below." />
							</If>
						</If>
					</If>
				}
			>
				<Each of={first() ? [first() as Item] : []} key={(item) => item.id}>
					{(item) => (
						<Arrive>
							<QueueCard
								day={props.day}
								item={item()}
								index={items().findIndex((i) => i.id === item().id)}
								count={items().length}
								later={decisions().length > 1}
							/>
						</Arrive>
					)}
				</Each>
			</If>
			<Rows>
				<Each of={rest()} key={(item) => item.id}>
					{(item) => (
						<Row
							mark={
								item().kind === "decision"
									? decisionMark((item() as Extract<Item, { kind: "decision" }>).decision)
									: item().kind === "request"
										? "new"
										: "needs"
							}
							title={`${upNext(item())}${itemTitle(props.day, item())}`}
							titleLines={item().kind === "request" ? 2 : undefined}
							trailing={<Num>{effortOf(item())}</Num>}
						/>
					)}
				</Each>
				<PlannerInterviewCards interviews={props.interviews} />
			</Rows>
			<If when={items().length + otherNeedsCount(props.ctx) + newFeedback(props.day).length === 0}>
				<InterviewReadNote interviews={props.interviews} />
			</If>
			<FeedbackIncoming day={props.day} active={!first()} />
			<ToCheck day={props.day} nested queued />
			<OtherNeeds ctx={props.ctx} day={props.day} />
			<OtherToCheck ctx={props.ctx} day={props.day} nested />
		</Section>
	);
}

/**
 * New Slack requests also wait in Needs you, as cards in its queue. A press brings one forward there.
 */
function New(props: { day: Day; filtered: boolean }) {
	const requests = () => (props.filtered ? todayRequests(props.day) : []);
	const waiting = () => todayRequests(props.day).length;
	const live = () => props.day.intake?.view().availability === "live";
	return (
		<If when={props.filtered || props.day.intake}>
			<Section testID="today-new" title="New" count={props.filtered ? requests().length : null} note="Slack">
				<Rows>
					<Each of={requests()} key={(r) => r.request.id}>
						{(r) => (
							<Row
								testID={`new-${r().request.id}`}
								mark="new"
								title={r().request.title}
								titleLines={2}
								meta={requestLine(r().request)}
								accessibilityLabel={`${r().request.title}. Bring it forward in Needs you.`}
								onPress={() => {
									focused.set(`request:${r().request.id}`);
									focusFront.set(true);
									todayTab.set("needs");
								}}
							/>
						)}
					</Each>
				</Rows>
				<RequestNotes day={props.day} />
				<If when={!props.filtered && waiting() > 0}>
					<EmptyLine
						text={`${waiting() === 1 ? "One Slack request waits" : `${countWord(waiting())} Slack requests wait`} in Needs you.`}
					/>
				</If>
				<If when={live() && waiting() === 0}>
					<EmptyLine text="No new requests from Slack." />
				</If>
				<If when={!props.day.intake}>
					<EmptyLine text="Slack requests are not available here." />
				</If>
			</Section>
		</If>
	);
}

/**
 * Keyboard triage while Today shows: J and K bring the next or previous item
 * forward, 1 to 9 pick an option, S, C, V and Q open help, L puts the item
 * off and Command-Return takes its one next action. Letters and digits never
 * fire while a text field has the focus; help keys never pick or send. New
 * (Command-N) belongs to the top bar, which every screen shares.
 * While Today shows only another project, or a tab without the question in
 * front, the keys do nothing: the item they would act on is not on screen.
 */
function bindTriage(day: Day, shown: () => boolean) {
	const results = () => todayResults(day);
	const requests = () => todayRequests(day);
	const decision = (): Decision | undefined => {
		const item = front(day.today(), results(), requests());
		return item?.kind === "decision" ? item.decision : undefined;
	};
	const keys: Record<string, () => void> = {
		j: () => move(day.today(), 1, results(), requests()),
		k: () => move(day.today(), -1, results(), requests()),
		l: () => later(day, front(day.today(), results(), requests())),
		"mod+enter": () => commit(day, front(day.today(), results(), requests())),
		s: () => {
			const d = decision();
			if (d) toggleHelp(d, "simpler");
		},
		c: () => {
			const d = decision();
			if (d) toggleHelp(d, "more");
		},
		v: () => {
			const d = decision();
			if (d?.visual) toggleHelp(d, "visual");
		},
		q: () => {
			const d = decision();
			if (d) toggleHelp(d, "ask");
		},
		"0": () => {
			const d = decision();
			if (d) writeReply(d);
		},
	};
	for (let n = 1; n <= 9; n++) {
		keys[String(n)] = () => {
			const d = decision();
			if (d) {
				pickNth(day, d, n);
				focusFront.set(true);
			}
		};
	}
	const guarded: Record<string, () => void> = {};
	for (const [key, run] of Object.entries(keys)) {
		guarded[key] = () => {
			if (shown() && (!decision()?.interviewRoundId || key === "l")) run();
		};
	}
	keymap.bind(guarded);
}

function missionsCount(day: Day, ctx: TodayScope): number {
	const today = day.today();
	return today.moving.length + today.notMoving.length + today.unreported.length + otherMissionsCount(ctx);
}

/** How many missions Missions lists before Show all, on Overview. */
const MISSIONS_SHOWN = 5;

function Missions(props: { day: Day; ctx: TodayScope; plans?: Plans; all: boolean }) {
	const today = () => props.day.today();
	const own = () => [
		...today().moving.map((row) => ({ row, group: "Moving" })),
		...today().notMoving.map((row) => ({ row, group: "Not moving" })),
		...today().unreported.map((row) => ({ row, group: "No current report" })),
	];
	const shown = () => (props.all ? own() : own().slice(0, MISSIONS_SHOWN));
	const groups = () =>
		["Moving", "Not moving", "No current report"]
			.map((group) => ({
				group,
				rows: shown()
					.filter((m) => m.group === group)
					.map((m) => m.row),
			}))
			.filter((g) => g.rows.length > 0);
	const count = (group: string) => own().filter((m) => m.group === group).length;
	return (
		<Section
			title="Missions"
			count={missionsCount(props.day, props.ctx)}
			more={
				!props.all && own().length > MISSIONS_SHOWN
					? { label: `Show all ${own().length}`, onPress: () => todayTab.set("missions") }
					: undefined
			}
		>
			<If when={props.ctx.tagged() && own().length > 0}>
				<ProjectLabel name={props.ctx.name(props.ctx.own() ?? "")} own />
			</If>
			<If
				when={
					missionsCount(props.day, props.ctx) === 0 &&
					props.ctx.others().every((p) => p.today && p.currentness !== "unavailable" && !p.errors.today)
				}
			>
				<EmptyLine text="No active missions." />
			</If>
			<Each of={groups()} key={(g) => g.group}>
				{(g) => (
					<>
						<RowGroup label={`${g().group} · ${count(g().group)}`} />
						<Rows>
							<Each of={g().rows} key={(m) => m.id}>
								{(m) => <MissionLine day={props.day} row={m()} plans={props.plans} />}
							</Each>
						</Rows>
					</>
				)}
			</Each>
			<OtherMissions ctx={props.ctx} day={props.day} />
		</Section>
	);
}

/**
 * The one old-data warning (freshness.ts). Nothing shows while reads work or
 * a normal refresh runs: the last good read stays and updates in place.
 * On Today it spans the top of the panel; other pages show it in their flow.
 */
export function FreshnessNote(props: { day: Day; placement?: "panel" | "flow" }) {
	const warning = () => todayWarning(props.day.freshness, props.day.today().freshness);
	return (
		<If when={warning()}>
			<Notice
				testID="freshness"
				kind="failed"
				placement={props.placement ?? "flow"}
				text={warning()}
				action={
					<If when={props.day.freshness}>
						<Link
							label="Try now"
							testID="freshness-try"
							accessibilityLabel="Read from Pilot's service now. This sends nothing."
							onPress={() => void props.day.freshness?.now()}
						/>
					</If>
				}
			/>
		</If>
	);
}

/**
 * Missions in planning, those waiting for the user first. Hidden when the
 * list is read and empty; a list that could not be read says so and shows
 * no rows, so it never looks like having none. Pilot reads it again on its
 * own; an earlier read stays, with no note, while a newer one comes.
 */
function Planning(props: { plans: Plans; ctx: TodayScope }) {
	const planning = () => props.plans.planning();
	const off = () => planning().availability === "unavailable";
	const rows = () => {
		if (off()) return [];
		const all = planning().plans;
		return [...all.filter((p) => p.needsYou), ...all.filter((p) => !p.needsYou)];
	};
	const readInventory = props.plans.feed.readInventory?.bind(props.plans.feed);
	// Only while nothing could be read; not offered when reading again cannot
	// help: the service changed, or Pilot is closing.
	const canReadAgain = () => {
		planning();
		return !!readInventory && (props.plans.feed.canReadInventory?.() ?? true);
	};
	const reading = signal(false);
	const readAgain = async () => {
		if (!readInventory || reading()) return;
		reading.set(true);
		try {
			await readInventory();
		} finally {
			reading.set(false);
		}
	};
	return (
		<If when={planning().availability !== "mock" || rows().length > 0}>
			<Section testID="planning" title="Planning" count={rows().length} note={off() ? "Unavailable" : undefined}>
				<If when={off()}>
					<Notice
						testID="planning-off"
						placement="section"
						text="Pilot cannot show missions in planning here."
						detail={planning().reason}
						action={
							<If when={canReadAgain()}>
								<Link
									label={reading() ? "Reading…" : "Read again"}
									disabled={reading()}
									accessibilityLabel="Read missions in planning again. This sends nothing."
									onPress={() => void readAgain()}
								/>
							</If>
						}
					/>
					<EmptyLine text="This is not the same as having none." />
				</If>
				<If when={!off() && rows().length === 0}>
					<EmptyLine testID="planning-note" text="No missions in planning." />
				</If>
				<Rows>
					<Each of={rows()} key={(p) => p.missionId}>
						{(p) => {
							const id = p().missionId;
							const place = placeRow(`plan-${id}`, () => openPlan(id));
							return (
								<Row
									testID={`plan-${id}`}
									mark={stageMark(p().stage)}
									title={p().title}
									meta={p().line}
									state={stageWord(p().stage)}
									stateTone={p().needsYou ? "needs" : "quiet"}
									accessibilityLabel={`${p().title}, ${stageWord(p().stage)}. Open its planning.`}
									anchor={place.anchor}
									onPress={place.press}
									detail={
										<If when={p().plannerSays || p().reply}>
											<RowDetail>
												<If when={p().plannerSays}>
													<Quote testID={`plan-says-${id}`} text={p().plannerSays ?? ""} />
												</If>
												<If when={p().reply}>
													<Button
														small
														testID={`plan-reply-${id}`}
														label="Reply or continue"
														accessibilityLabel={`Open the planning of ${p().title} to reply to Pilot's planning agent or ask it to continue.`}
														onPress={() => openPlan(id)}
													/>
												</If>
											</RowDetail>
										</If>
									}
								/>
							);
						}}
					</Each>
				</Rows>
				<OtherPlanning ctx={props.ctx} />
			</Section>
		</If>
	);
}

function ComingUp(props: { day: Day; ctx: TodayScope }) {
	const rows = () =>
		[
			...(props.ctx.showsOwn()
				? props.day.today().comingUp.map((row) => ({ row, project: props.ctx.name(props.ctx.own() ?? "") }))
				: []),
			...props.ctx.others().flatMap((p) => (p.today?.comingUp ?? []).map((row) => ({ row, project: p.name }))),
		]
			.sort((a, b) => (a.row.at ?? Infinity) - (b.row.at ?? Infinity))
			.slice(0, 5);
	return (
		<If when={rows().length > 0}>
			<Section
				title="Coming up"
				action={
					<If when={props.day.schedules}>
						<Link label="Schedules…" onPress={goSchedules} />
					</If>
				}
			>
				<Rows>
					<Each of={rows()} key={(s) => s.row.id}>
						{(s) => (
							<Row
								title={s().row.text}
								meta={[props.ctx.tagged() ? s().project : "", s().row.note ?? ""].filter(Boolean).join(" · ")}
								trailing={<Num>{s().row.when}</Num>}
								wrap
							/>
						)}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}

function unreadProblems(ctx: TodayScope) {
	return ctx
		.others()
		.filter((p) => !p.today?.problemsKnown || p.currentness !== "live")
		.map((p) => p.name);
}

function InterviewReadNote(props: { interviews: PlannerInterviews }) {
	return (
		<If when={!props.interviews.known() && props.interviews.rows().length === 0}>
			<EmptyLine
				testID="planner-interviews-unconfirmed"
				text="Pilot has not confirmed which planner interviews need answers."
			/>
		</If>
	);
}

/** Today while it shows only another project: the same panel, in two columns. */
function OtherProject(props: { day: Day; ctx: TodayScope; interviews: PlannerInterviews; working: WorkingList }) {
	return (
		<If
			when={props.ctx.others().length > 0}
			else={
				<Column>
					<WorkingNow day={props.day} ctx={props.ctx} list={props.working} />
				</Column>
			}
		>
			<Columns
				main={
					<>
						<Problems
							rows={props.ctx.others().flatMap((p) => p.today?.problems ?? [])}
							known
							unreadProjects={unreadProblems(props.ctx)}
							project={props.ctx.name}
						/>
						<Section title="Needs you" count={otherNeedsCount(props.ctx) + props.interviews.rows().length}>
							<Rows>
								<PlannerInterviewCards interviews={props.interviews} />
							</Rows>
							<If when={otherNeedsCount(props.ctx) === 0}>
								<InterviewReadNote interviews={props.interviews} />
							</If>
							<OtherNeeds ctx={props.ctx} day={props.day} />
							<OtherToCheck ctx={props.ctx} day={props.day} nested />
						</Section>
						<FinishedToday day={props.day} ctx={props.ctx} />
					</>
				}
				side={
					<>
						<OtherNotShown ctx={props.ctx} />
						<WorkingNow day={props.day} ctx={props.ctx} list={props.working} />
						<If when={props.ctx.others().some((p) => (p.planning?.plans.length ?? 0) > 0 || p.errors.planning)}>
							<Section title="Planning">
								<OtherPlanning ctx={props.ctx} />
							</Section>
						</If>
						<Section title="Missions" count={otherMissionsCount(props.ctx)}>
							<OtherMissions ctx={props.ctx} day={props.day} />
						</Section>
					</>
				}
			/>
		</If>
	);
}

/** Today's tabs: Overview shows every section; the others filter the panel to one part. */
export type TodayTab = "overview" | "needs" | "new" | "linear" | "working" | "missions";

/** The tab this window's Today shows. Kept while the window lives; a new window starts on Overview. */
export const todayTab = signal<TodayTab>("overview");

/** The whole Today screen for `props.day`. */
export function TodayScreen(props: { day: Day; rituals: Rituals; plans?: Plans }) {
	const today = () => props.day.today();
	const plans = props.plans;
	// The window's project scope: All projects unless the user chose one. Reading only.
	const ctx = todayScope(props.day, plans);
	const interviews = plannerInterviews(props.day);
	const working = workingList(props.day, ctx);
	const title = () => {
		const own = ctx.showsOwn();
		const others = ctx.others();
		// Keep the local answered-card wording when there is no cross-project summary.
		if (!ctx.on() && today().problems.length === 0 && todayRequests(props.day).length === 0)
			return headline(props.day, interviews.rows().length, interviews.known());
		const counts = own ? attentionCounts(today()) : { stopped: 0, other: 0 };
		const requests = otherRequestsCount(ctx) + (own ? todayRequests(props.day).length : 0);
		let other =
			counts.other +
			interviews.rows().length +
			otherResultsCount(ctx) +
			(own ? todayResults(props.day).length + newFeedback(props.day).length : 0);
		for (const p of others) {
			if (!p.today) continue;
			const next = attentionCounts(p.today);
			counts.stopped += next.stopped;
			other += next.other;
		}
		const scope = props.day.scope?.view();
		const snapshot = scope?.snapshot;
		const complete =
			interviews.known() &&
			(!own ||
				(today().problemsKnown &&
					today().attention.state === "live" &&
					today().freshness.state === "live" &&
					!today().intake.trouble.length &&
					(!props.day.intake ||
						(props.day.intake.view().availability === "live" &&
							!props.day.intake.view().intake.trouble.length)))) &&
			(!ctx.on() ||
				(scope?.state === "live" &&
					snapshot?.scope === ctx.scope() &&
					snapshot.catalogComplete &&
					snapshot.complete &&
					!snapshot.partial)) &&
			others.every(
				(p) =>
					p.currentness === "live" &&
					p.today?.problemsKnown &&
					p.today.attention.state === "live" &&
					p.needsYou.complete &&
					!p.errors.today &&
					!p.errors.attention &&
					!p.errors.planning &&
					!p.errors.intake &&
					!p.today.intake.trouble.length &&
					p.results?.complete !== false,
			);
		return attentionHeadline({ stopped: counts.stopped, other, requests, complete: !!complete });
	};
	const linear = todayLinear(
		props.day,
		() => (ctx.on() ? ctx.own() : props.day.today().project || null),
		ctx.showsOwn,
	);
	const tab = () => (ctx.showsOwn() && (todayTab() !== "linear" || linear.shown()) ? todayTab() : "overview");
	bindScopeReads(props.day, ctx);
	visitToday(props.day, props.rituals);
	bindTriage(
		props.day,
		() =>
			ctx.showsOwn() &&
			(tab() === "overview" || tab() === "needs") &&
			!feedbackTurn(props.day) &&
			!!front(props.day.today(), todayResults(props.day), todayRequests(props.day)),
	);
	// A restored offset for a Today already on screen: scrolled to once, without animation.
	const scroller = signal<ScrollRef | null>(null);
	effect(() => {
		const y = todayScrollTo();
		const node = scroller();
		if (y === null || !node) return;
		todayScrollTo.set(null);
		node.scrollTo({ y, animated: false });
	});
	const problems = () => (
		<Problems
			rows={[...today().problems, ...ctx.others().flatMap((p) => p.today?.problems ?? [])]}
			known={today().problemsKnown}
			unreadProjects={unreadProblems(ctx)}
			chat={props.day.chat?.source}
			actionProject={ctx.on() ? ctx.own() : undefined}
			earlier={
				todayWarning(props.day.freshness, today().freshness) !== "" ||
				ctx.others().some((p) => p.currentness === "stale")
			}
			project={ctx.tagged() ? ctx.name : undefined}
		/>
	);
	const missionSide = (all: boolean) => (
		<>
			<If when={plans}>
				<Planning plans={plans as Plans} ctx={ctx} />
			</If>
			<Missions day={props.day} ctx={ctx} plans={plans} all={all} />
			<ComingUp day={props.day} ctx={ctx} />
		</>
	);
	return (
		<Scroll
			testID="today-page"
			ref={(node) => scroller.set(node)}
			class="flex-1"
			contentOffset={{ y: todayPlace.y }}
			scrollEventThrottle={100}
			onScroll={(e) => {
				todayPlace.y = e.offset.y;
			}}
		>
			<Page>
				<If
					when={ctx.on() || today().freshness.state !== "unreadable"}
					else={
						<PageHead
							testID="unreadable"
							title="Today could not be read."
							text={`${today().freshness.reason} Pilot shows Today again once it can read it. Nothing here is guessed.`}
						/>
					}
				>
					<PageHead
						pre={<DayDate day={props.day} />}
						title={title()}
						text={ctx.showsOwn() ? summary(props.day, interviews.rows().length) : undefined}
						actions={
							<>
								<DayActions day={props.day} rituals={props.rituals} />
								<ScopeControl ctx={ctx} />
							</>
						}
					>
						<If when={ctx.showsOwn() && today().leftOff && today().decisions.length === 0}>
							<Caption tone="accent">{today().leftOff ?? ""}</Caption>
						</If>
						<DayNotes day={props.day} rituals={props.rituals} />
						<ScopeNote day={props.day} ctx={ctx} />
					</PageHead>
					<Panel
						testID="today-panel"
						notice={
							<If when={ctx.showsOwn()}>
								<FreshnessNote day={props.day} placement="panel" />
							</If>
						}
						tabs={
							<If when={ctx.showsOwn()}>
								<Tabs testID="today-tabs">
									<Tab
										testID="today-tab-overview"
										label="Overview"
										selected={tab() === "overview"}
										onPress={() => todayTab.set("overview")}
									/>
									<Tab
										testID="today-tab-needs"
										label="Needs you"
										count={needsCount(props.day, ctx, interviews)}
										selected={tab() === "needs"}
										onPress={() => todayTab.set("needs")}
									/>
									<Tab
										testID="today-tab-new"
										label="New"
										count={todayRequests(props.day).length}
										selected={tab() === "new"}
										onPress={() => todayTab.set("new")}
									/>
									<If when={linear.shown()}>
										<Tab
											testID="today-tab-linear"
											label="Linear"
											count={linear.count()}
											selected={tab() === "linear"}
											onPress={() => todayTab.set("linear")}
										/>
									</If>
									<Tab
										testID="today-tab-working"
										label="Working"
										count={working.count()}
										selected={tab() === "working"}
										onPress={() => todayTab.set("working")}
									/>
									<Tab
										testID="today-tab-missions"
										label="Missions"
										count={missionsCount(props.day, ctx)}
										selected={tab() === "missions"}
										onPress={() => todayTab.set("missions")}
									/>
								</Tabs>
							</If>
						}
					>
						<If
							when={ctx.showsOwn()}
							else={<OtherProject day={props.day} ctx={ctx} interviews={interviews} working={working} />}
						>
							<If when={tab() === "overview"}>
								<Columns
									main={
										<>
											{problems()}
											<NeedsYou day={props.day} ctx={ctx} interviews={interviews} />
											<New day={props.day} filtered={false} />
											<FinishedToday day={props.day} ctx={ctx} />
										</>
									}
									side={
										<>
											<WorkingNow day={props.day} ctx={ctx} list={working} />
											<If when={ctx.tagged()}>
												<OtherNotShown ctx={ctx} />
											</If>
											{missionSide(false)}
										</>
									}
								/>
							</If>
							<If when={tab() === "needs"}>
								<Column centered>
									{problems()}
									<NeedsYou day={props.day} ctx={ctx} interviews={interviews} />
								</Column>
							</If>
							<If when={tab() === "new"}>
								<Column centered>
									<New day={props.day} filtered />
								</Column>
							</If>
							<If when={tab() === "linear"}>
								<LinearTabContent day={props.day} project={linear.project} />
							</If>
							<If when={tab() === "working"}>
								<Column centered>
									<WorkingNow day={props.day} ctx={ctx} list={working} />
								</Column>
							</If>
							<If when={tab() === "missions"}>
								<Column centered>{missionSide(true)}</Column>
							</If>
						</If>
					</Panel>
					<If when={ctx.showsOwn()}>
						<PageFoot
							text={
								!everRead(today().attention.state) || !today().problemsKnown || !interviews.known()
									? "Pilot could not read everything that needs you yet. It keeps trying."
									: today().problems.length > 0
										? "Unresolved work is shown above. Pilot retries nothing on its own."
										: "That is everything for now. Pilot will tell you if something needs you."
							}
						/>
					</If>
				</If>
			</Page>
		</Scroll>
	);
}
