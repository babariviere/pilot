// Today: what needs the user, which missions move, what landed and what
// comes next. Read-only over the Rust read model, except through intents.
// Movement comes only from agents' reports; a mission without a current
// report is shown as such, never as not moving.
import { effect, keymap, Scroll, type ScrollRef, signal, Text, View } from "nsh";
import type { Decision, MissionRow } from "pilot-day/native";
import { ActionCard } from "./ActionCard";
import { commit, later, pickNth, toggleHelp, writeReply } from "./commands";
import { DatabaseApprovals } from "./DatabaseSettings";
import { DayLine } from "./DayLine";
import { DecisionCard, decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { FeedbackIncoming, feedbackFocus, incomingFeedback, newFeedback } from "./FeedbackIncoming";
import { everRead, todayWarning } from "./freshness";
import { Incoming } from "./Incoming";
import { todayScrollTo } from "./kept";
import { goSchedules } from "./nav";
import { stageMark, stageWord } from "./PlanScreen";
import { Problems } from "./Problems";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { ResultCard } from "./ResultCard";
import type { Rituals } from "./ritualFeed";
import {
	bindScopeReads,
	OtherDone,
	OtherMissions,
	OtherNeeds,
	OtherNew,
	OtherNotShown,
	OtherPlanning,
	OtherToCheck,
	otherMissionsCount,
	otherNeedsCount,
	otherNewShown,
	ProjectLabel,
	ScopeControl,
	ScopeNote,
	scopedHeadline,
	type TodayScope,
	todayScope,
} from "./ScopeRows";
import { resultTitle, ToCheck, todayResults, unsettledCount } from "./ToCheck";
import {
	Action,
	Arrive,
	EvidenceChip,
	InlineAction,
	Mark,
	MarkLine,
	Notice,
	Page,
	PageTitle,
	RowLink,
	SectionTitle,
	Track,
} from "./ui";
import { focused, focusFront, front, type Item, move, openMission, placeRow, queue, todayPlace } from "./view";
import { WorkingNow } from "./WorkingNow";
import { provenance, rowLine, stateMark, stateTone, stateWord } from "./words";

function actionFor(decision: Decision | undefined): string {
	if (!decision) return "";
	if (decision.kind === "review") return "Review it";
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "Check it";
	return "Decide";
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** The headline: the coordinators' summary, until the user starts answering. */
function headline(day: Day): string {
	const today = day.today();
	if (today.problems.length > 0) return "Some work needs a look.";
	if (!today.problemsKnown) return "Your last read.";
	if (day.databases?.snapshot()?.agents.some((a) => !!a.request)) return "Database access needs your approval.";
	// What needs the user was never read: an all-clear headline would be a guess.
	if (!everRead(today.attention.state) && (today.headline.startsWith("Nothing needs you") || today.notes.length > 0)) {
		return "Your last read.";
	}
	const left = today.decisions.length + today.actions.length;
	if (newFeedback(day).length > 0 && left === 0) return "Feedback needs a look.";
	if (today.notes.length === 0) return today.headline;
	if (left === 0) return "That was everything. Pilot is back on it.";
	if (left === 1) return "One thing left.";
	return `${WORDS[left] ?? String(left)} things left.`;
}

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
}

/** A mission's state: its mark and words. */
export function MissionStatus(props: { row: MissionRow }) {
	return (
		<View class="flex-row items-center gap-1.5">
			<Mark kind={stateMark(props.row)} />
			<Text
				class="text-xs"
				classList={{
					"text-needs-ink": stateTone(props.row) === "needs",
					"text-failed-ink": stateTone(props.row) === "failed",
					"text-muted-foreground": stateTone(props.row) === "quiet",
				}}
			>
				{stateWord(props.row)}
			</Text>
		</View>
	);
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
	const meta = () => {
		const parts = [props.row.report ? provenance(props.row.report) : "", props.row.stage, old() ? "Old plan" : ""];
		return parts.filter(Boolean).join(" · ");
	};
	return (
		<View class="gap-1.5 border-t border-border py-3.5">
			<RowLink
				testID={`mission-${props.row.id}`}
				title={props.row.title}
				accessibilityLabel={`${props.row.title}, ${stateWord(props.row)}. Open the mission.`}
				anchor={place.anchor}
				onPress={place.press}
			>
				<MissionStatus row={props.row} />
			</RowLink>
			<View class="flex-row flex-wrap items-baseline gap-x-1.5">
				{/* min-w-0 shrink lets the summary wrap inside the row instead of running past it. */}
				<Text class="min-w-0 shrink text-sm text-muted-foreground">{rowLine(props.row)}</Text>
				<If when={decision()}>
					<InlineAction
						label={actionFor(decision())}
						onPress={() => {
							focused.set(props.row.decisionId ?? null);
							focusFront.set(true);
						}}
					/>
				</If>
			</View>
			<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1 pt-1">
				<Track progress={props.row.progress} />
				<Text class="flex-1 text-xs text-faint">{meta()}</Text>
				<Text class="text-xs text-faint">{`${props.row.progress.done} of ${total(props.row)} done`}</Text>
			</View>
		</View>
	);
}

function MissionGroup(props: { day: Day; label: string; rows: MissionRow[]; first: boolean; plans?: Plans }) {
	return (
		<View classList={{ "pt-3": !props.first }}>
			<Text class="pb-1.5 text-xs text-faint">{`${props.label}  ${props.rows.length}`}</Text>
			<Each of={props.rows} key={(m) => m.id}>
				{(m) => <MissionLine day={props.day} row={m()} plans={props.plans} />}
			</Each>
		</View>
	);
}

function itemTitle(day: Day, item: Item): string {
	if (item.kind === "result") return resultTitle(day, item.entry);
	return item.kind === "decision" ? item.decision.title : item.action.title;
}

/** The words before an Up next title. */
function upNext(item: Item): string {
	if (item.kind === "result") return "Up next, result to check: ";
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

/** What waits for the user: one card in front, the rest as "Up next". */
function NeedsYou(props: { day: Day; ctx: TodayScope }) {
	// Results to check queue behind the questions and actions, as cards of their own.
	const results = () => todayResults(props.day);
	const items = () => queue(props.day.today(), results());
	const first = () => (feedbackTurn(props.day) ? undefined : front(props.day.today(), results()));
	const rest = () => items().filter((item) => item.id !== first()?.id);
	const decisions = () => props.day.today().decisions;
	// What needs the user has its own read. While a refresh runs or after a
	// failed one, the cards from the last good read stay, answerable: Rust
	// checks each answer again before it sends. Only a read that never worked
	// says so, so an unread list never looks empty.
	const readable = () => everRead(props.day.today().attention.state);
	// Checks whose answer Pilot could not confirm count here too; they show as notices below the cards.
	const checks = () => unsettledCount(props.day);
	// A focus request with no card to take it lapses, so a later arrival
	// never takes the focus on its own.
	effect(() => {
		if (focusFront() && !first()) focusFront.set(false);
	});
	return (
		<View class="gap-4">
			<SectionTitle
				title="Needs you"
				count={
					items().length +
					newFeedback(props.day).length +
					checks() +
					otherNeedsCount(props.ctx) +
					(props.day.databases?.snapshot()?.agents.filter((a) => !!a.request).length ?? 0)
				}
			/>
			<If when={props.ctx.tagged()}>
				<ProjectLabel name={props.ctx.name(props.ctx.own() ?? "")} own />
			</If>
			<Each of={props.day.today().notes} key={(note) => note}>
				{(note) => (
					<View class="flex-row items-center gap-2.5 rounded-xl bg-ok-soft px-4 py-3">
						<Mark kind="ready" />
						<Text class="flex-1 text-sm text-ok-ink">{note()}</Text>
					</View>
				)}
			</Each>
			<If
				when={first()}
				else={
					<If
						when={readable()}
						else={
							<Text testID="attention-unread" class="text-base text-foreground">
								Pilot has not read what needs you yet. It keeps trying; nothing here is guessed.
							</Text>
						}
					>
						<If
							when={
								incomingFeedback(props.day).length === 0 &&
								!props.day.databases?.snapshot()?.agents.some((a) => !!a.request)
							}
						>
							<Text class="text-base text-foreground">
								{checks() > 0
									? "Nothing else waits for you. Check the notes below."
									: "Nothing needs you. Pilot keeps going on its own."}
							</Text>
						</If>
					</If>
				}
			>
				<Each of={first() ? [first() as Item] : []} key={(item) => item.id}>
					{(item) => (
						<Arrive>
							<If
								when={item().kind === "decision"}
								else={
									<If
										when={item().kind === "result"}
										else={
											<ActionCard
												day={props.day}
												action={(item() as Extract<Item, { kind: "action" }>).action}
												index={items().findIndex((i) => i.id === item().id)}
												count={items().length}
											/>
										}
									>
										<ResultCard
											day={props.day}
											entry={(item() as Extract<Item, { kind: "result" }>).entry}
											index={items().findIndex((i) => i.id === item().id)}
											count={items().length}
										/>
									</If>
								}
							>
								<DecisionCard
									day={props.day}
									decision={(item() as Extract<Item, { kind: "decision" }>).decision}
									index={items().findIndex((i) => i.id === item().id)}
									count={items().length}
									later={decisions().length > 1}
								/>
							</If>
						</Arrive>
					)}
				</Each>
			</If>
			<If when={rest().length > 0}>
				<View class="gap-0.5">
					<Each of={rest()} key={(item) => item.id}>
						{(item) => (
							<View class="flex-row items-center gap-2.5 py-1.5">
								<Mark
									kind={
										item().kind === "decision"
											? decisionMark((item() as Extract<Item, { kind: "decision" }>).decision)
											: "needs"
									}
								/>
								<Text class="flex-1 text-sm text-muted-foreground">
									{upNext(item())}
									<Text class="text-foreground">{itemTitle(props.day, item())}</Text>
								</Text>
								<Text class="text-xs text-faint">{effortOf(item())}</Text>
							</View>
						)}
					</Each>
				</View>
			</If>
			<FeedbackIncoming day={props.day} active={!first()} />
			<ToCheck day={props.day} nested queued />
			<If when={props.day.databases}>{(c) => <DatabaseApprovals controls={c()} />}</If>
			<OtherNeeds ctx={props.ctx} day={props.day} />
			<OtherToCheck ctx={props.ctx} day={props.day} nested />
		</View>
	);
}

/**
 * Keyboard triage while Today shows: J and K bring the next or previous item
 * forward, 1 to 9 pick an option, S, C, V and Q open help, L puts the item
 * off and Command-Return takes its one next action. Letters and digits never
 * fire while a text field has the focus; help keys never pick or send. New
 * (Command-N) belongs to the header, which every screen shares.
 * While Today shows only another project, the keys do nothing: this
 * window's own items are not on screen.
 */
function bindTriage(day: Day, shown: () => boolean) {
	const results = () => todayResults(day);
	const decision = (): Decision | undefined => {
		const item = front(day.today(), results());
		return item?.kind === "decision" ? item.decision : undefined;
	};
	const keys: Record<string, () => void> = {
		j: () => move(day.today(), 1, results()),
		k: () => move(day.today(), -1, results()),
		l: () => later(day, front(day.today(), results())),
		"mod+enter": () => commit(day, front(day.today(), results())),
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

function Missions(props: { day: Day; ctx: TodayScope; plans?: Plans }) {
	const today = () => props.day.today();
	const count = () => today().moving.length + today().notMoving.length + today().unreported.length;
	return (
		<View class="gap-3">
			<SectionTitle title="Missions" count={count() + otherMissionsCount(props.ctx)} />
			<If when={props.ctx.tagged()}>
				<ProjectLabel name={props.ctx.name(props.ctx.own() ?? "")} own />
			</If>
			<If when={count() === 0}>
				<Text class="text-sm text-muted-foreground">No active missions.</Text>
			</If>
			<If when={today().moving.length > 0}>
				<MissionGroup day={props.day} label="Moving" rows={today().moving} first plans={props.plans} />
			</If>
			<If when={today().notMoving.length > 0}>
				<MissionGroup
					day={props.day}
					label="Not moving"
					rows={today().notMoving}
					first={today().moving.length === 0}
					plans={props.plans}
				/>
			</If>
			<If when={today().unreported.length > 0}>
				<MissionGroup
					day={props.day}
					label="No current report"
					rows={today().unreported}
					first={today().moving.length + today().notMoving.length === 0}
					plans={props.plans}
				/>
			</If>
			<OtherMissions ctx={props.ctx} day={props.day} />
		</View>
	);
}

/**
 * The one old-data warning (freshness.ts). Nothing shows while reads work or
 * a normal refresh runs: the last good read stays and updates in place.
 */
export function FreshnessNote(props: { day: Day }) {
	const warning = () => todayWarning(props.day.freshness, props.day.today().freshness);
	return (
		<If when={warning()}>
			<Notice
				testID="freshness"
				text={warning()}
				action={
					<If when={props.day.freshness}>
						<Action
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

/** Today when nothing could be read: say so, and show nothing guessed. */
function Unreadable(props: { day: Day }) {
	return (
		<View testID="unreadable" class="gap-2 pt-6">
			<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
				Today could not be read.
			</Text>
			<Text class="text-base leading-relaxed text-muted-foreground">
				{`${props.day.today().freshness.reason} Pilot shows Today again once it can read it. Nothing here is guessed.`}
			</Text>
		</View>
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
			<View testID="planning" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="Planning" count={rows().length}>
						<If when={off()}>
							<Text testID="planning-status" class="text-xs text-faint">
								Unavailable
							</Text>
						</If>
					</SectionTitle>
				</View>
				<If when={off()}>
					<Notice testID="planning-off" text="Pilot cannot show missions in planning here.">
						<Text class="text-sm text-muted-foreground">{planning().reason}</Text>
						<Text class="text-xs text-faint">This is not the same as having none.</Text>
						<If when={canReadAgain()}>
							<View class="flex-row pt-1">
								<Action
									label={reading() ? "Reading…" : "Read again"}
									icon="refresh"
									disabled={reading()}
									accessibilityLabel="Read missions in planning again. This sends nothing."
									onPress={() => void readAgain()}
								/>
							</View>
						</If>
					</Notice>
				</If>
				<If when={!off() && rows().length === 0}>
					<Text testID="planning-note" class="text-xs text-muted-foreground">
						No missions in planning.
					</Text>
				</If>
				<Each of={rows()} key={(p) => p.missionId}>
					{(p) => {
						const id = p().missionId;
						const place = placeRow(`plan-${id}`, () => openPlan(id));
						return (
							<View class="gap-1 border-t border-border py-3">
								<RowLink
									testID={`plan-${id}`}
									title={p().title}
									accessibilityLabel={`${p().title}, ${stageWord(p().stage)}. Open its planning.`}
									anchor={place.anchor}
									onPress={place.press}
								>
									<View class="flex-row items-center gap-1.5">
										<Mark kind={stageMark(p().stage)} />
										<Text class={p().needsYou ? "text-xs text-needs-ink" : "text-xs text-muted-foreground"}>
											{stageWord(p().stage)}
										</Text>
									</View>
								</RowLink>
								<Text class="text-sm text-muted-foreground">{p().line}</Text>
								<If when={p().plannerSays}>
									<View testID={`plan-says-${id}`} selectable class="gap-0.5 pt-1">
										<Text class="text-xs text-faint">Its last message</Text>
										<Text class="text-sm leading-relaxed text-foreground">{p().plannerSays}</Text>
									</View>
								</If>
								<If when={p().reply}>
									<View class="-ml-3 flex-row pt-1">
										<Action
											variant="outline"
											testID={`plan-reply-${id}`}
											label="Reply or continue"
											accessibilityLabel={`Open the planning of ${p().title} to reply to Pilot's planning agent or ask it to continue.`}
											onPress={() => openPlan(id)}
										/>
									</View>
								</If>
							</View>
						);
					}}
				</Each>
				<OtherPlanning ctx={props.ctx} />
			</View>
		</If>
	);
}

function DoneSince(props: { day: Day; ctx: TodayScope }) {
	const today = () => props.day.today();
	return (
		<View class="gap-1">
			<View class="flex-row items-baseline gap-2 pb-2">
				<Text role="header" class="text-sm font-semibold text-muted-foreground">
					Done since you looked
				</Text>
				<Text class="text-sm text-faint">{today().lastLooked}</Text>
			</View>
			<If when={props.ctx.tagged() && today().done.length > 0}>
				<ProjectLabel name={props.ctx.name(props.ctx.own() ?? "")} own />
			</If>
			<Each of={today().done} key={(e) => e.id}>
				{(e) => (
					<View class="py-2.5">
						<MarkLine
							kind={
								e().evidence.some((x) => x.tone === "bad")
									? "failed"
									: e().evidence.some((x) => x.tone === "warn")
										? "needs"
										: "done"
							}
						>
							<View class="gap-2">
								<Text class="text-sm text-foreground">{e().text}</Text>
								<View class="flex-row flex-wrap items-center gap-1.5">
									<Each of={e().evidence} key={(x) => x.label}>
										{(x) => <EvidenceChip evidence={x()} />}
									</Each>
									<Text class="text-xs text-faint">{e().missionTitle}</Text>
								</View>
							</View>
						</MarkLine>
					</View>
				)}
			</Each>
			<If when={today().doneHidden > 0}>
				<Text class="pt-1 text-xs text-faint">{`${today().doneHidden} earlier results are not shown here.`}</Text>
			</If>
			<If when={today().finished.length > 0}>
				<Text class="pt-2 text-xs text-muted-foreground">{`Finished: ${today().finished.join(", ")}`}</Text>
			</If>
			<OtherDone ctx={props.ctx} />
		</View>
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
			<View class="gap-1">
				<View class="flex-row items-center gap-2 pb-2">
					<View class="flex-1">
						<SectionTitle title="Coming up" />
					</View>
					<If when={props.day.schedules}>
						<Action label="Schedules…" onPress={goSchedules} />
					</If>
				</View>
				<Each of={rows()} key={(s) => s.row.id}>
					{(s) => (
						<View class="flex-row gap-3 py-2">
							<View class="flex-1 gap-0.5">
								<Text class="text-sm text-foreground">{s().row.text}</Text>
								<If when={props.ctx.tagged()}>
									<ProjectLabel name={s().project} />
								</If>
								<If when={s().row.note}>
									<Text class="text-xs text-faint">{s().row.note ?? ""}</Text>
								</If>
							</View>
							<Text class="text-xs text-faint">{s().row.when}</Text>
						</View>
					)}
				</Each>
			</View>
		</If>
	);
}

function unreadProblems(ctx: TodayScope) {
	return ctx
		.others()
		.filter((p) => !p.today?.problemsKnown || p.currentness !== "live")
		.map((p) => p.name);
}

/** Today while it shows only another project. */
function OtherProject(props: { day: Day; ctx: TodayScope }) {
	return (
		<If when={props.ctx.others().length > 0} else={<WorkingNow day={props.day} ctx={props.ctx} />}>
			<View class="gap-12">
				<If when={otherNewShown(props.ctx)}>
					<View class="gap-1">
						<SectionTitle title="New" />
						<OtherNew ctx={props.ctx} />
					</View>
				</If>
				<View class="gap-4">
					<Problems
						rows={props.ctx.others().flatMap((p) => p.today?.problems ?? [])}
						known
						unreadProjects={unreadProblems(props.ctx)}
						project={props.ctx.name}
					/>
					<SectionTitle title="Needs you" count={otherNeedsCount(props.ctx)} />
					<OtherNeeds ctx={props.ctx} day={props.day} />
					<OtherToCheck ctx={props.ctx} day={props.day} nested />
				</View>
				<OtherNotShown ctx={props.ctx} />
				<WorkingNow day={props.day} ctx={props.ctx} />
				<If when={props.ctx.others().some((p) => (p.planning?.plans.length ?? 0) > 0 || p.errors.planning)}>
					<View class="gap-1">
						<SectionTitle title="Planning" />
						<OtherPlanning ctx={props.ctx} />
					</View>
				</If>
				<View class="gap-3">
					<SectionTitle title="Missions" count={otherMissionsCount(props.ctx)} />
					<OtherMissions ctx={props.ctx} day={props.day} />
				</View>
				<View class="gap-1">
					<Text role="header" class="text-sm font-semibold text-muted-foreground">
						Done since you looked
					</Text>
					<OtherDone ctx={props.ctx} />
				</View>
			</View>
		</If>
	);
}

/** The whole Today screen for `props.day`. */
export function TodayScreen(props: { day: Day; rituals: Rituals; plans?: Plans }) {
	const today = () => props.day.today();
	const plans = props.plans;
	// The window's project scope: All projects unless the user chose one. Reading only.
	const ctx = todayScope(props.day, plans);
	bindScopeReads(props.day, ctx);
	bindTriage(
		props.day,
		() => ctx.showsOwn() && !feedbackTurn(props.day) && !!front(props.day.today(), todayResults(props.day)),
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
	return (
		<Scroll
			testID="today-page"
			ref={(node) => scroller.set(node)}
			class="flex-1 bg-background"
			contentOffset={{ y: todayPlace.y }}
			scrollEventThrottle={100}
			onScroll={(e) => {
				todayPlace.y = e.offset.y;
			}}
		>
			<Page gap={12}>
				<If when={ctx.on() || today().freshness.state !== "unreadable"} else={<Unreadable day={props.day} />}>
					<View class="gap-12">
						<View class="gap-3">
							<View class="flex-row items-start gap-3">
								<View class="flex-1">
									<DayLine day={props.day} rituals={props.rituals} />
								</View>
								<ScopeControl ctx={ctx} />
							</View>
							<PageTitle title={ctx.showsOwn() ? headline(props.day) : scopedHeadline(ctx)} />
							<If when={ctx.showsOwn()}>
								<Text class="text-base leading-relaxed text-muted-foreground">{today().summary}</Text>
								<If when={today().leftOff && today().decisions.length === 0}>
									<Text class="text-xs text-primary">{today().leftOff ?? ""}</Text>
								</If>
							</If>
							<ScopeNote day={props.day} ctx={ctx} />
							<If when={ctx.showsOwn()}>
								<FreshnessNote day={props.day} />
							</If>
						</View>

						<If when={ctx.showsOwn()} else={<OtherProject day={props.day} ctx={ctx} />}>
							<View class="gap-12">
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
								<Incoming day={props.day} />
								<If when={otherNewShown(ctx)}>
									<View testID="scope-new" class="gap-1">
										<SectionTitle title="New in other projects" />
										<OtherNew ctx={ctx} />
									</View>
								</If>
								<NeedsYou day={props.day} ctx={ctx} />
								<WorkingNow day={props.day} ctx={ctx} />
								<If when={ctx.tagged()}>
									<OtherNotShown ctx={ctx} />
								</If>
								<If when={plans}>
									<Planning plans={plans as Plans} ctx={ctx} />
								</If>
								<Missions day={props.day} ctx={ctx} plans={plans} />
								<DoneSince day={props.day} ctx={ctx} />
								<ComingUp day={props.day} ctx={ctx} />

								<Text class="border-t border-border pt-5 text-xs text-faint">
									{!everRead(today().attention.state) || !today().problemsKnown
										? "Pilot could not read everything that needs you yet. It keeps trying."
										: today().problems.length > 0
											? "Unresolved work is shown above. Pilot retries nothing on its own."
											: "That is everything for now. Pilot will tell you if something needs you."}
								</Text>
							</View>
						</If>
					</View>
				</If>
			</Page>
		</Scroll>
	);
}
