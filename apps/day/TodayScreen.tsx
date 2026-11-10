// Today: what needs the user, which missions move, what landed and what
// comes next. Read-only over the Rust read model, except through intents.
// Movement comes only from agents' reports; a mission without a current
// report is shown as such, never as not moving.
import { effect, type JSX, keymap, Scroll, signal, Text, View, type ViewRef } from "nsh";
import type { Decision, MissionRow } from "pilot-day/native";
import { ActionCard } from "./ActionCard";
import type { Changes } from "./changeFeed";
import { showChanges } from "./changesView";
import { commit, later, pickNth, toggleHelp, writeReply } from "./commands";
import { DayLine } from "./DayLine";
import { DecisionCard, decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { Arrive } from "./motion";
import { stageMark, stageWord } from "./PlanScreen";
import type { Plans } from "./planning";
import { openNew, openPlan } from "./planView";
import { Action, EvidenceChip, InlineAction, Mark, RowLink, SectionTitle, Track } from "./ui";
import { updateLabel } from "./UpdateScreen";
import { showUpdate, updateEntry, updateOpen } from "./updateView";
import { dataSource, focused, focusFront, front, type Item, move, openMission, queue, todayPlace } from "./view";
import { freshnessLine, provenance, rowLine, stateMark, stateTone, stateWord } from "./words";

function actionFor(decision: Decision | undefined): string {
	if (!decision) return "";
	if (decision.kind === "review") return "Review it";
	if (decision.kind === "unknown" || decision.delivery === "unknown") return "Check it";
	return "Decide";
}

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** The keystroke that opens New, as the platform writes it. */
const keymapLabel = keymap.label("mod+n");

/** The headline: the coordinators' summary, until the user starts answering. */
function headline(day: Day): string {
	const today = day.today();
	const left = today.decisions.length + today.actions.length;
	if (today.notes.length === 0) return today.headline;
	if (left === 0) return "That was everything. Pilot is back on it.";
	if (left === 1) return "One thing left.";
	return `${WORDS[left] ?? String(left)} things left.`;
}

function total(row: MissionRow): number {
	const p = row.progress;
	return p.done + p.review + p.active + p.blocked + p.todo;
}

/**
 * A row that opens another screen. Pressing it keeps its place, and when
 * Today comes back the row takes the keyboard focus again. Returns the
 * row's anchor and what its press does.
 */
function placeRow(testID: string, open: () => void) {
	const node = signal<ViewRef | null>(null);
	effect(() => {
		const n = node();
		if (n && todayPlace.row === testID) {
			todayPlace.row = null;
			n.focus();
		}
	});
	return {
		anchor: (n: ViewRef) => node.set(n),
		press: () => {
			todayPlace.row = testID;
			open();
		},
	};
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

function MissionLine(props: { day: Day; row: MissionRow }) {
	const decision = () => props.day.today().decisions.find((d) => d.id === props.row.decisionId);
	const place = placeRow(`mission-${props.row.id}`, () => openMission(props.row.id));
	const meta = () => {
		const parts = [props.row.report ? provenance(props.row.report) : "", props.row.stage];
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
				<Text class="text-sm text-muted-foreground">{rowLine(props.row)}</Text>
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

function MissionGroup(props: { day: Day; label: string; rows: MissionRow[]; first: boolean }) {
	return (
		<View classList={{ "pt-3": !props.first }}>
			<Text class="pb-1.5 text-xs text-faint">{`${props.label}  ${props.rows.length}`}</Text>
			<Each of={props.rows} key={(m) => m.id}>
				{(m) => <MissionLine day={props.day} row={m()} />}
			</Each>
		</View>
	);
}

function itemTitle(item: Item): string {
	return item.kind === "decision" ? item.decision.title : item.action.title;
}

/** What waits for the user: one card in front, the rest as "Up next". */
function NeedsYou(props: { day: Day }) {
	const items = () => queue(props.day.today());
	const first = () => front(props.day.today());
	const rest = () => items().filter((item) => item.id !== first()?.id);
	const decisions = () => props.day.today().decisions;
	const attention = () => props.day.today().attention;
	// What needs the user has its own read. A note shows only when it says
	// more than the missions' freshness note above.
	const attentionNote = () => {
		const a = attention();
		const f = props.day.today().freshness;
		if (a.state === "live" || (a.state === f.state && a.reason === f.reason)) return "";
		return a.reason;
	};
	const readable = () => attention().state !== "unreadable" && attention().state !== "unavailable";
	// A focus request with no card to take it lapses, so a later arrival
	// never takes the focus on its own.
	effect(() => {
		if (focusFront() && !first()) focusFront.set(false);
	});
	return (
		<View class="gap-4">
			<SectionTitle title="Needs you" count={items().length} />
			<If when={attentionNote()}>
				<View testID="attention-note" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
					<Mark kind="unknown" />
					<Text class="flex-1 text-sm text-foreground">{attentionNote()}</Text>
				</View>
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
							<Text class="text-base text-foreground">
								Pilot could not read what needs you. Nothing here is guessed.
							</Text>
						}
					>
						<Text class="text-base text-foreground">Nothing needs you. Pilot keeps going on its own.</Text>
					</If>
				}
			>
				<Each of={first() ? [first() as Item] : []} key={(item) => item.id}>
					{(item) => (
						<Arrive>
							<If
								when={item().kind === "decision"}
								else={
									<ActionCard
										day={props.day}
										action={(item() as Extract<Item, { kind: "action" }>).action}
										index={items().findIndex((i) => i.id === item().id)}
										count={items().length}
									/>
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
									{item().kind === "decision" ? "Up next: " : "Up next, action for you: "}
									<Text class="text-foreground">{itemTitle(item())}</Text>
								</Text>
								<Text class="text-xs text-faint">
									{item().kind === "decision"
										? (item() as Extract<Item, { kind: "decision" }>).decision.effort
										: (item() as Extract<Item, { kind: "action" }>).action.effort}
								</Text>
							</View>
						)}
					</Each>
				</View>
			</If>
		</View>
	);
}

/**
 * Keyboard triage while Today shows: J and K bring the next or previous item
 * forward, 1 to 9 pick an option, S, C, V and Q open help, L puts the item
 * off and Command-Return takes its one next action. Letters and digits never
 * fire while a text field has the focus; help keys never pick or send.
 */
function bindTriage(day: Day, plans: Plans | undefined) {
	const decision = (): Decision | undefined => {
		const item = front(day.today());
		return item?.kind === "decision" ? item.decision : undefined;
	};
	const keys: Record<string, () => void> = {
		j: () => move(day.today(), 1),
		k: () => move(day.today(), -1),
		l: () => later(day, front(day.today())),
		"mod+enter": () => commit(day, front(day.today())),
		"mod+n": () => {
			if (plans) openNew();
		},
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
	keymap.bind(keys);
}

function Missions(props: { day: Day }) {
	const today = () => props.day.today();
	const count = () => today().moving.length + today().notMoving.length + today().unreported.length;
	return (
		<View class="gap-3">
			<SectionTitle title="Missions" count={count()} />
			<If when={count() === 0}>
				<Text class="text-sm text-muted-foreground">No active missions.</Text>
			</If>
			<If when={today().moving.length > 0}>
				<MissionGroup day={props.day} label="Moving" rows={today().moving} first />
			</If>
			<If when={today().notMoving.length > 0}>
				<MissionGroup
					day={props.day}
					label="Not moving"
					rows={today().notMoving}
					first={today().moving.length === 0}
				/>
			</If>
			<If when={today().unreported.length > 0}>
				<MissionGroup
					day={props.day}
					label="No current report"
					rows={today().unreported}
					first={today().moving.length + today().notMoving.length === 0}
				/>
			</If>
		</View>
	);
}

/** A quiet line when the read shown is not live. */
export function FreshnessNote(props: { day: Day }) {
	const freshness = () => props.day.today().freshness;
	return (
		<If when={freshnessLine(freshness())}>
			<View testID="freshness" class="flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-foreground">{freshnessLine(freshness())}</Text>
			</View>
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

/** Pilot's mark and name, with the mock data note when the window shows mock data. */
export function TopBar(props: { children?: JSX.Element; action?: JSX.Element }) {
	// Pilot's service, only when it needs the user: an update, a registration, a lost answer.
	const update = () => {
		const entry = updateEntry();
		return entry && !updateOpen() ? updateLabel(entry.service()) : "";
	};
	return (
		<View class="flex-row items-center gap-2">
			{props.children}
			<View class="size-4 rounded-md bg-primary" />
			<Text class="text-sm font-semibold text-foreground">Pilot</Text>
			<View class="flex-1" />
			<If when={update()}>
				<Action label={update()} testID="update-open" onPress={showUpdate} />
			</If>
			{props.action}
			<If when={dataSource() === "mock"}>
				<Text class="text-xs text-faint">Mock data</Text>
			</If>
		</View>
	);
}

/**
 * Missions in planning, those waiting for the user first. Hidden when the
 * list is read and empty; a list that could not be read says so and shows
 * no rows, so it never looks like having none. Read again only reads.
 */
function Planning(props: { plans: Plans }) {
	const planning = () => props.plans.planning();
	const off = () => planning().availability === "unavailable";
	const rows = () => {
		if (off()) return [];
		const all = planning().plans;
		return [...all.filter((p) => p.needsYou), ...all.filter((p) => !p.needsYou)];
	};
	const readInventory = props.plans.feed.readInventory?.bind(props.plans.feed);
	// Not offered when reading again cannot help: the service changed, or Pilot is closing.
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
		<If when={off() || rows().length > 0}>
			<View testID="planning" class="gap-1">
				<View class="pb-1">
					<SectionTitle title="Planning" count={rows().length} />
				</View>
				<If when={off()}>
					<View testID="planning-off" class="gap-1.5 rounded-xl bg-muted px-4 py-3">
						<View class="flex-row items-center gap-2.5">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-foreground">Pilot cannot show missions in planning here.</Text>
						</View>
						<Text class="text-sm text-muted-foreground">{planning().reason}</Text>
						<Text class="text-xs text-faint">This is not the same as having none.</Text>
						<If when={canReadAgain()}>
							<View class="flex-row pt-1">
								<Action
									label={reading() ? "Reading…" : "Read again"}
									disabled={reading()}
									accessibilityLabel="Read missions in planning again. This sends nothing."
									onPress={() => void readAgain()}
								/>
							</View>
						</If>
					</View>
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
							</View>
						);
					}}
				</Each>
			</View>
		</If>
	);
}

function DoneSince(props: { day: Day }) {
	const today = () => props.day.today();
	return (
		<View class="gap-1">
			<View class="flex-row items-baseline gap-2 pb-2">
				<Text role="header" class="text-sm font-semibold text-muted-foreground">
					Done since you looked
				</Text>
				<Text class="text-sm text-faint">{today().lastLooked}</Text>
			</View>
			<Each of={today().done} key={(e) => e.id}>
				{(e) => (
					<View class="flex-row gap-3 py-2.5">
						<View class="pt-1.5">
							<Mark
								kind={
									e().evidence.some((x) => x.tone === "bad")
										? "failed"
										: e().evidence.some((x) => x.tone === "warn")
											? "needs"
											: "done"
								}
							/>
						</View>
						<View class="flex-1 gap-2">
							<Text class="text-sm text-foreground">{e().text}</Text>
							<View class="flex-row flex-wrap items-center gap-1.5">
								<Each of={e().evidence} key={(x) => x.label}>
									{(x) => <EvidenceChip evidence={x()} />}
								</Each>
								<Text class="text-xs text-faint">{e().missionTitle}</Text>
							</View>
						</View>
					</View>
				)}
			</Each>
			<If when={today().doneHidden > 0}>
				<Text class="pt-1 text-xs text-faint">{`${today().doneHidden} earlier results are not shown here.`}</Text>
			</If>
			<If when={today().finished.length > 0}>
				<Text class="pt-2 text-xs text-muted-foreground">{`Finished: ${today().finished.join(", ")}`}</Text>
			</If>
		</View>
	);
}

function ComingUp(props: { day: Day }) {
	return (
		<View class="gap-1">
			<View class="pb-2">
				<SectionTitle title="Coming up" />
			</View>
			<Each of={props.day.today().comingUp} key={(s) => s.id}>
				{(s) => (
					<View class="flex-row gap-3 py-2">
						<View class="flex-1 gap-0.5">
							<Text class="text-sm text-foreground">{s().text}</Text>
							<If when={s().note}>
								<Text class="text-xs text-faint">{s().note ?? ""}</Text>
							</If>
						</View>
						<Text class="text-xs text-faint">{s().when}</Text>
					</View>
				)}
			</Each>
		</View>
	);
}

/** The Changes button: how many reviews wait, said to screen readers too. */
function ChangesButton(props: { changes: Changes }) {
	const waiting = () => props.changes.list().waiting.length;
	return (
		<Action
			label="Changes"
			accessibilityLabel={waiting() > 0 ? `Changes, ${waiting()} to review` : "Changes"}
			onPress={showChanges}
		/>
	);
}

/** The whole Today screen for `props.day`. */
export function TodayScreen(props: { day: Day; plans?: Plans; changes?: Changes }) {
	const today = () => props.day.today();
	bindTriage(props.day, props.plans);
	const plans = props.plans;
	const changes = props.changes;
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={{ y: todayPlace.y }}
			scrollEventThrottle={100}
			onScroll={(e) => {
				todayPlace.y = e.offset.y;
			}}
		>
			<View class="w-full max-w-2xl self-center gap-12 px-6 pb-24 pt-6">
				<TopBar
					action={
						<View class="flex-row items-center gap-1">
							<If when={changes}>
								<ChangesButton changes={changes as Changes} />
							</If>
							<If when={plans}>
								<Action label="New" shortcut={keymapLabel} onPress={openNew} />
							</If>
						</View>
					}
				/>
				<If when={today().freshness.state !== "unreadable"} else={<Unreadable day={props.day} />}>
					<View class="gap-12">
						<View class="gap-3 pt-6">
							<DayLine day={props.day} />
							<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
								{headline(props.day)}
							</Text>
							<Text class="text-base leading-relaxed text-muted-foreground">{today().summary}</Text>
							<If when={today().leftOff && today().decisions.length === 0}>
								<Text class="text-xs text-primary">{today().leftOff ?? ""}</Text>
							</If>
							<FreshnessNote day={props.day} />
						</View>

						<NeedsYou day={props.day} />
						<If when={plans}>
							<Planning plans={plans as Plans} />
						</If>
						<Missions day={props.day} />
						<DoneSince day={props.day} />
						<ComingUp day={props.day} />

						<Text class="border-t border-border pt-5 text-xs text-faint">
							That is everything for now. Pilot will tell you if something needs you.
						</Text>
					</View>
				</If>
			</View>
		</Scroll>
	);
}
