// One mission's planning: where it should end up, the open interview, the
// map of what is still unknown, the proposed plan in full, and each step
// from answers to work. Submitting, approving, publishing and starting work
// are separate steps. Only the exact-plan confirmation starts one task.
// One panel under the page's head, with three tabs: Questions (the interview,
// the map, Revisit and earlier rounds), Plan (the proposal and its review)
// and Activity (the planning agent's chat). The planner's status and the
// steps from plan to work stay beside Questions and Plan.
import {
	cleanup,
	computed,
	effect,
	type JSX,
	keymap,
	lifecycle,
	Scroll,
	signal,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import type {
	Exploration,
	FogArea,
	MapInfo,
	PlanPage,
	PlanStage,
	Proposal,
	SliceOwner,
	Step,
	StepState,
} from "pilot-day/native";
import type { ArtifactSource } from "./artifactReads";
import type { Day } from "./day";
import { errorText, logEvent } from "./dayLog";
import { ChartKey, chartState, ExpeditionChart, ExpeditionLog, FullChart, OPEN_CHART } from "./ExpeditionChart";
import { InterviewDoc } from "./InterviewDoc";
import { keepScroll } from "./kept";
import { Agreement, exploreLine, exploreMark, FogRecord, ItemRecord, itemWord } from "./MapRecords";
import { planBack } from "./nav";
import { ActivityLine, PlanChat } from "./PlanActivity";
import { flush, unsavedCount } from "./planCommands";
import type { Plans } from "./planning";
import { fogOpen, mapOpen, put, roundOpen, settledOpen } from "./planView";
import { RevisitSection } from "./RevisitDoc";
import { RoundPrototype } from "./RoundPrototype";
import { PlannerWaits, plannerWaits, Unstick } from "./Unstick";
import {
	Block,
	Body,
	Button,
	Buttons,
	Caption,
	Column,
	Columns,
	Disclosure,
	EmptyLine,
	type MarkKind,
	Notice,
	Page,
	PageHead,
	Panel,
	Question,
	Row,
	RowDetail,
	RowGroup,
	Rows,
	Section,
	State,
	Tab,
	Tabs,
} from "./ui";

/** The words beside a plan's mark. */
export function stageWord(stage: PlanStage): string {
	switch (stage) {
		case "questions":
			return "Questions for you";
		case "planning":
			return "Pilot is planning";
		case "review":
			return "Plan ready for your review";
		case "approved":
			return "Approved, not published";
		case "published":
			return "Published";
		case "submitted":
			return "Submitted, waiting to continue";
		case "unknown":
			return "Not confirmed";
	}
}

/** A plan's mark. A stage Pilot could not confirm needs a look, like a write it could not confirm. */
export function stageMark(stage: PlanStage): MarkKind {
	switch (stage) {
		case "questions":
		case "review":
		case "unknown":
			return "needs";
		case "published":
			return "done";
		default:
			return "working";
	}
}

function stepMark(state: StepState): MarkKind {
	switch (state) {
		case "done":
			return "done";
		case "now":
			return "working";
		case "unknown":
			return "needs";
		default:
			return "new";
	}
}

function stepWord(state: StepState): string {
	switch (state) {
		case "done":
			return "Done";
		case "now":
			return "Now";
		case "unknown":
			return "Not confirmed";
		case "unavailable":
			return "Not here";
		default:
			return "Not yet";
	}
}

function owner(o: SliceOwner): string {
	return o === "ui" ? "UI (Opus)" : "Backend (Sol)";
}

/** Who builds a slice: its work profile and size, or the owners of an older plan. */
function builder(s: { owners: SliceOwner[]; profile?: string; size?: string }): string {
	if (s.owners.length) return s.owners.map(owner).join(" · ");
	return [s.profile, s.size || "large"].filter(Boolean).join(" · ");
}

/** One part of the plan's spec: its label, then its words. */
function Part(props: { title: string; testID?: string; children?: JSX.Element }) {
	return (
		<View testID={props.testID} class="gap-1">
			<Caption>{props.title}</Caption>
			{props.children}
		</View>
	);
}

/** A short list under a quiet label. */
function Lines(props: { title: string; lines: string[]; testID?: string }) {
	return (
		<If when={props.lines.length > 0}>
			<Part title={props.title} testID={props.testID}>
				<Each of={props.lines} key={(l) => l}>
					{(l) => <Body measure>{`• ${l()}`}</Body>}
				</Each>
			</Part>
		</If>
	);
}

/** The proposed plan in full: spec, testing, slices with their order and owners, and what is still unknown. */
function ProposalView(props: { proposal: Proposal }) {
	const p = () => props.proposal;
	return (
		<Section testID="proposal" title="The proposed plan">
			<Block selectable gap={4}>
				<Part title="Problem">
					<Body measure>{p().spec.problem}</Body>
				</Part>
				<Part title="Solution">
					<Body measure>{p().spec.solution}</Body>
				</Part>
				<Lines title="Who it is for" lines={p().spec.stories.map((s) => s.text)} />
				<Lines title="How it is built" lines={p().spec.implementation} />
				<Lines testID="testing" title="How it is tested" lines={p().spec.testing} />
				<Lines title="Left out" lines={p().spec.exclusions} />
			</Block>
			<RowGroup label={`Tasks it would become · ${p().slices.length}`} />
			<Rows>
				<Each of={p().slices} key={(s) => s.id}>
					{(s) => (
						<Row
							testID={`slice-${s().id}`}
							title={s().title}
							meta={builder(s())}
							wrap
							selectable
							detail={
								<RowDetail>
									<Body tone="muted">{s().outcome}</Body>
									<Caption>
										{(s().files ?? []).length
											? `Owned files: ${(s().files ?? []).join(", ")}. Check combined changes before dependent work.`
											: "Write scope not declared. Takes turns with this project's other writers."}
									</Caption>
									<Each of={s().acceptance} key={(a) => a}>
										{(a) => <Caption tone="default">{`✓ ${a()}`}</Caption>}
									</Each>
									<Caption tone="faint">
										{[
											s().after.length > 0 ? `After: ${s().after.join(", ")}` : "Can start first",
											`Stories: ${s().stories.join(", ")}`,
										].join(" · ")}
									</Caption>
								</RowDetail>
							}
						/>
					)}
				</Each>
			</Rows>
			<If when={p().openFog.length > 0}>
				<Block>
					<Lines title="Still unknown" lines={p().openFog} testID="open-fog" />
				</Block>
			</If>
		</Section>
	);
}

/**
 * One question on the map: a calm row that opens to its full saved record.
 * Opening it reads nothing and changes nothing.
 */
function MapItem(props: { plans: Plans; page: PlanPage; item: Exploration }) {
	const e = () => props.item;
	const key = () => `${props.page.missionId}/${e().id}`;
	const open = () => mapOpen()[key()] === true;
	return (
		<Row
			testID={`explore-${e().id}`}
			mark={exploreMark(e())}
			title={e().title}
			meta={exploreLine(e())}
			state={itemWord(e())}
			wrap
			accessibilityLabel={`${e().title}, ${itemWord(e())}. ${open() ? "Hide" : "Show"} its record.`}
			onPress={() => put(mapOpen, key(), !open())}
			detail={
				<If when={open() || e().changed.length > 0}>
					<RowDetail>
						<Each of={e().changed} key={(c) => c}>
							{(c) => <Caption tone="needs">{c()}</Caption>}
						</Each>
						<If when={open()}>
							<ItemRecord plans={props.plans} page={props.page} item={e()} />
						</If>
					</RowDetail>
				</If>
			}
		/>
	);
}

/** The map's questions that can move now: asked, ready or being worked on. */
function openNow(page: PlanPage): Exploration[] {
	return page.explorations.filter((e) => e.state === "asking" || e.state === "ready" || e.state === "running");
}

/** The map in one line, such as "3 settled · 2 open now · 1 waiting · 2 in fog". */
export function mapSummary(page: PlanPage): string {
	const count = (state: Exploration["state"]) => page.explorations.filter((e) => e.state === state).length;
	return [
		`${count("resolved")} settled`,
		`${openNow(page).length} open now`,
		count("waiting") > 0 ? `${count("waiting")} waiting` : "",
		`${page.fog.filter((f) => f.active).length} in fog`,
	]
		.filter(Boolean)
		.join(" · ");
}

/** A titled group of map questions, shown only when it has any. */
function MapGroup(props: { testID: string; title: string; items: Exploration[]; page: PlanPage; plans: Plans }) {
	return (
		<If when={props.items.length > 0}>
			<RowGroup label={`${props.title} · ${props.items.length}`} />
			<Rows testID={props.testID}>
				<Each of={props.items} key={(e) => e.id}>
					{(e) => <MapItem plans={props.plans} page={props.page} item={e()} />}
				</Each>
			</Rows>
		</If>
	);
}

function FogRow(props: { plans: Plans; page: PlanPage; fog: FogArea }) {
	return (
		<Row
			testID={`fog-${props.fog.id}`}
			title={props.fog.area}
			wrap
			detail={
				<RowDetail>
					<FogRecord plans={props.plans} page={props.page} fog={props.fog} />
				</RowDetail>
			}
		/>
	);
}

/** The last stop on the route: the plan, once nothing is left to decide. */
function PlanStep(props: { page: PlanPage }) {
	const step = () => {
		switch (props.page.stage) {
			case "review":
				return {
					mark: "needs" as MarkKind,
					title: "Read the plan",
					who: "You",
					line: "Pilot proposed a plan. Read it in full before you answer.",
				};
			case "approved":
			case "published":
				return {
					mark: "done" as MarkKind,
					title: stageWord(props.page.stage),
					who: "",
					line: "Approving publishes build tasks; it starts nothing.",
				};
			default:
				return {
					mark: "new" as MarkKind,
					title: "Pilot proposes a plan",
					who: "Later",
					line: "When nothing is left to decide. Approving it publishes build tasks; it starts nothing.",
				};
		}
	};
	return (
		<Row
			testID="map-plan-step"
			mark={step().mark}
			title={step().title}
			meta={step().line}
			state={step().who || undefined}
			stateTone={step().mark === "needs" ? "needs" : "quiet"}
			wrap
		/>
	);
}

/**
 * The Wayfinder map: the same saved records the coordinator reads. What is
 * open now, what waits, what is settled, the fog of war and the agreement.
 * Reading it answers, approves and starts nothing.
 */
function MapView(props: {
	plans: Plans;
	page: PlanPage;
	onOpenTasks?: () => void;
	/** Opens the chart full window. It gets the button that opened it. */
	onOpenChart?: (button: ViewRef | undefined) => void;
}) {
	const chart = chartState();
	const items = () => props.page.explorations;
	// What needs you first, then work under way, then what is ready.
	const now = () => {
		const rank = { asking: 0, running: 1, ready: 2, waiting: 3, resolved: 4 } as const;
		return [...openNow(props.page)].sort((a, b) => rank[a.state] - rank[b.state]);
	};
	const waiting = () => items().filter((e) => e.state === "waiting");
	const settled = () => items().filter((e) => e.state === "resolved");
	const active = () => props.page.fog.filter((f) => f.active);
	const explored = () => props.page.fog.filter((f) => !f.active);
	const changed = () => items().filter((e) => e.changed.length > 0).length;
	const id = () => props.page.missionId;
	const fog = () => fogOpen()[id()] === true;
	const done = () => settledOpen()[id()] === true;
	return (
		<>
			<Section
				testID="map"
				title="Map"
				note={props.page.map ? `Revision ${props.page.map?.revision ?? 0}` : undefined}
			>
				<Block gap={3}>
					<Body testID="map-summary" tone="muted">
						{mapSummary(props.page)}
					</Body>
					<If when={changed() > 0}>
						<Caption testID="map-changed" tone="needs">
							{changed() === 1
								? "1 question cites a record that changed. Pilot updates the map from it; nothing here needs you."
								: `${changed()} questions cite records that changed. Pilot updates the map from them; nothing here needs you.`}
						</Caption>
					</If>
				</Block>
				{/* The chart sizes itself to the window, so it takes the panel's whole width, outside the padded block. */}
				<ExpeditionChart
					plans={props.plans}
					page={props.page}
					state={chart}
					mode="inline"
					onOpenFull={props.onOpenChart}
					onOpenTasks={props.onOpenTasks}
				/>
				<Block>
					<Caption tone="faint">
						{`Select a place for its field notes. Open the chart (${keymap.label(OPEN_CHART)}) to look around and zoom. Esc closes the notes. Reading the chart answers, approves and starts nothing.`}
					</Caption>
				</Block>
			</Section>
			<Section testID="map-next" title="Next on the route" note="In order">
				<MapGroup plans={props.plans} testID="map-now" title="Open now" items={now()} page={props.page} />
				<MapGroup plans={props.plans} testID="map-waiting" title="Waiting" items={waiting()} page={props.page} />
				<If when={!props.page.prototypes.available && items().some((e) => e.kind === "prototype")}>
					<EmptyLine text={props.page.prototypes.line} />
				</If>
				<Rows>
					<PlanStep page={props.page} />
				</Rows>
				<Block gap={3}>
					<If when={settled().length > 0}>
						<Disclosure
							testID="settled-toggle"
							label={`Settled · ${settled().length}`}
							open={done()}
							onToggle={() => put(settledOpen, id(), !done())}
						>
							<View testID="map-settled" class="gap-1">
								<Caption>Settled questions are not asked again. Open one to see what settled it.</Caption>
								<Rows>
									<Each of={settled()} key={(e) => e.id}>
										{(e) => <MapItem plans={props.plans} page={props.page} item={e()} />}
									</Each>
								</Rows>
							</View>
						</Disclosure>
					</If>
					<Disclosure
						testID="fog-toggle"
						label={`Fog of war · ${active().length}`}
						open={fog()}
						onToggle={() => put(fogOpen, id(), !fog())}
					>
						<View class="gap-1">
							<Caption>
								Areas Pilot does not understand well enough to ask precise questions about yet. Fog is not a
								problem and blocks nothing.
							</Caption>
							<Rows>
								<Each of={active()} key={(f) => f.id}>
									{(f) => <FogRow plans={props.plans} page={props.page} fog={f()} />}
								</Each>
							</Rows>
							<If when={explored().length > 0}>
								<RowGroup label="Explored" />
								<Rows>
									<Each of={explored()} key={(f) => f.id}>
										{(f) => <FogRow plans={props.plans} page={props.page} fog={f()} />}
									</Each>
								</Rows>
							</If>
						</View>
					</Disclosure>
					<If when={props.page.map}>
						<Agreement info={props.page.map as MapInfo} onOpenTasks={props.onOpenTasks} />
					</If>
				</Block>
			</Section>
			<ExpeditionLog page={props.page} state={chart} />
			<ChartKey />
		</>
	);
}

/** Each step from answers to work, separately. */
function Steps(props: { steps: Step[] }) {
	return (
		<Section testID="steps" title="From plan to work">
			<Rows>
				<Each of={props.steps} key={(s) => s.label}>
					{(s) => (
						<Row mark={stepMark(s().state)} title={`${s().label}: ${stepWord(s().state)}`} meta={s().line} wrap />
					)}
				</Each>
			</Rows>
		</Section>
	);
}

/** Same planning layout and action controls. Confirmation pins what the user saw. */
export function StartWork(props: { plans: Plans; page: PlanPage }) {
	const shown = signal<NonNullable<PlanPage["work"]> | null>(null);
	const busy = signal(false);
	const note = signal("");
	const uncertain = signal(false);
	const work = () => props.page.work;
	const current = () => !uncertain() && shown()?.context === work()?.context && work()?.canStart === true;
	async function send(check = false) {
		if (busy()) return;
		const pin = shown();
		if (!check && (!pin || !current())) {
			shown.set(null);
			return;
		}
		// Navigation while drafts save cannot redirect this confirmed intent.
		const missionId = props.page.missionId;
		const interview = props.page.interview;
		busy.set(true);
		try {
			if (interview) {
				await flush(props.plans, interview);
				const saved = props.plans.feed.page(missionId)?.interview;
				if (saved && unsavedCount(saved) > 0) {
					note.set("Save the answers before starting work.");
					return;
				}
			}
			const result = check
				? await props.plans.feed.checkWork?.(missionId)
				: await props.plans.feed.startWork?.(missionId, {
						revision: pin!.revision,
						digest: pin!.digest,
						taskId: pin!.taskId,
						context: pin!.context,
					});
			note.set(result?.message ?? "Start is unavailable here.");
			uncertain.set(result?.status === "unknown");
			shown.set(null);
		} catch {
			uncertain.set(true);
			note.set("Start is not confirmed. Check only; do not start again.");
			shown.set(null);
		} finally {
			busy.set(false);
		}
	}
	return (
		<If when={work()}>
			<Section title="Work">
				<If when={shown()}>
					{/* The confirmation waits for the user's answer, with the exact task, model and access. */}
					<Question
						title={`Start “${shown()?.title}” as one background Build task?`}
						meta={
							<Caption tone="faint">{`${shown()?.project} · ${shown()?.model} · ${shown()?.thinking}. Access: ${shown()?.access}. Existing limits apply. Other tasks do not start.`}</Caption>
						}
						foot={
							<>
								<Button
									kind="primary"
									label={busy() ? "Starting…" : "Start task"}
									disabled={busy() || !current()}
									onPress={() => void send()}
								/>
								<Button label="Cancel" disabled={busy()} onPress={() => shown.set(null)} />
							</>
						}
					/>
				</If>
				<If when={(work()?.canStart && !shown() && !uncertain()) || work()?.canCheck || uncertain() || note()}>
					<Block>
						<Buttons>
							<If when={work()?.canStart && !shown() && !uncertain()}>
								<Button
									kind="primary"
									label="Start work"
									disabled={busy() || !props.plans.feed.startWork}
									onPress={() => shown.set(work() ?? null)}
								/>
							</If>
							<If when={work()?.canCheck || uncertain()}>
								<Button label="Check Start" disabled={busy()} onPress={() => void send(true)} />
							</If>
						</Buttons>
						<If when={note()}>
							<Caption role="alert">{note()}</Caption>
						</If>
					</Block>
				</If>
			</Section>
		</If>
	);
}

/** Earlier interview rounds: each one's own completion and answers, apart from the plan's approval. */
function Rounds(props: { page: PlanPage }) {
	const p = () => props.page;
	return (
		<If when={p().rounds.length > 0}>
			<Section testID="rounds" title="Earlier interview rounds" count={p().rounds.length}>
				<Block>
					<Caption tone="faint">
						Submitting a round completes that round. It is not agreement to the plan or approval to build.
					</Caption>
				</Block>
				<Rows>
					<Each of={p().rounds} key={(r) => r.id}>
						{(r) => {
							const key = () => `${p().missionId}/${r().id}`;
							const open = () => roundOpen()[key()] === true;
							const has = () => r().answers.length > 0;
							return (
								<Row
									testID={`round-${r().id}`}
									mark={r().state === "submitted" ? "done" : "new"}
									title={r().title}
									meta={r().line}
									trailing={
										<If when={has()}>
											<Caption tone="faint">{open() ? "Hide answers" : "Show answers"}</Caption>
										</If>
									}
									accessibilityLabel={`${r().title}, ${r().line}.${has() ? (open() ? " Hide its answers." : " Show its answers.") : ""}`}
									onPress={() => {
										if (has()) put(roundOpen, key(), !open());
									}}
									detail={
										<If when={open() && has()}>
											<RowDetail testID={`round-answers-${r().id}`}>
												<Each of={r().answers} key={(a) => a.prompt}>
													{(a) => (
														<View class="gap-0.5">
															<Caption>{a().prompt}</Caption>
															<Body>{a().answer || "No answer"}</Body>
														</View>
													)}
												</Each>
											</RowDetail>
										</If>
									}
								/>
							);
						}}
					</Each>
				</Rows>
			</Section>
		</If>
	);
}

/**
 * Wakes an idle planning agent. One quiet action under its status: it answers, approves
 * and starts nothing, and names the planning state shown, so a changed mission refuses it.
 * Its message outlives the button, so the page keeps it.
 */
function ContinuePlanning(props: { plans: Plans; page: PlanPage; message: ReturnType<typeof signal<string>> }) {
	const busy = signal(false);
	const message = props.message;
	const press = async () => {
		const feed = props.plans.feed;
		if (busy() || !feed.continuePlanning) return;
		busy.set(true);
		message.set("");
		try {
			// Called on the feed: the connected feed's methods use their own private state.
			message.set((await feed.continuePlanning({ missionId: props.page.missionId, feedback: "" })).message);
		} catch (error) {
			logEvent("ui.error", errorText(error));
			message.set("Pilot could not send this. Nothing was sent.");
		} finally {
			busy.set(false);
		}
	};
	return (
		<If when={(props.page.canContinue && props.plans.feed.continuePlanning !== undefined) || busy() || message()}>
			<Block>
				<If when={(props.page.canContinue && props.plans.feed.continuePlanning !== undefined) || busy()}>
					<Button
						testID="continue-planning"
						label={busy() ? "Asking Pilot to continue…" : "Continue planning"}
						accessibilityLabel="Continue planning: Pilot's planning agent picks up where it stopped. It answers, approves and starts nothing."
						disabled={busy()}
						onPress={() => void press()}
					/>
				</If>
				<If when={message()}>
					<Caption testID="continue-message" tone="faint">
						{message()}
					</Caption>
				</If>
			</Block>
		</If>
	);
}

/** The planning agent: what it waits for, what it does now, Continue and Unstick. Hidden while it has nothing to say. */
function PlannerStatus(props: { plans: Plans; page: PlanPage }) {
	const p = () => props.page;
	const message = signal("");
	const shown = () =>
		plannerWaits(p()) ||
		!!p().activity ||
		!!p().unstick ||
		!!message() ||
		(p().canContinue && props.plans.feed.continuePlanning !== undefined);
	return (
		<If when={shown()}>
			<Section title="Planning agent">
				<PlannerWaits plans={props.plans} page={p()} />
				<If when={p().activity}>
					<ActivityLine
						plans={props.plans}
						page={p()}
						activity={p().activity as NonNullable<PlanPage["activity"]>}
					/>
				</If>
				<If when={!plannerWaits(p())}>
					<ContinuePlanning plans={props.plans} page={p()} message={message} />
				</If>
				<Unstick plans={props.plans} page={p()} />
			</Section>
		</If>
	);
}

/** The page's sub-pages. */
type PlanTab = "questions" | "plan" | "activity";

/** The tab a planning page opens on: the plan while its review waits or nothing else is open, else the questions. */
function firstTab(p: PlanPage): PlanTab {
	const iv = p.interview;
	if (iv?.kind === "review") return "plan";
	if (iv && iv.submit !== "submitted") return "questions";
	if (p.revisit) return "questions";
	return p.proposal ? "plan" : "questions";
}

function PlanBody(props: {
	plans: Plans;
	page: PlanPage;
	title: string;
	onOpenTasks?: () => void;
	/** Opens the map's chart full window. */
	onOpenChart?: (button: ViewRef | undefined) => void;
	/** A command beside the title, such as Try now. */
	action?: JSX.Element;
	/** Why the page's own read did not work, when it did not. */
	readNote: string;
	/** Reads the prototype a topic round asks about. Absent in mock flows. */
	artifacts?: ArtifactSource;
}) {
	const p = () => props.page;
	const asking = () =>
		p().interview && p().interview?.kind !== "review" && p().interview?.submit !== "submitted" ? p().interview : null;
	// A submitted round is history while Pilot plans from it, so the map comes first.
	const submitted = () =>
		p().interview && p().interview?.kind !== "review" && p().interview?.submit === "submitted" ? p().interview : null;
	const review = () => (p().interview?.kind === "review" ? p().interview : null);
	// Chosen once when the page opens, so a live update never moves the user to another tab.
	const tab = signal<PlanTab>(untracked(() => firstTab(props.page)));
	const chat = () => props.plans.feed.readChat !== undefined;
	const shownTab = () => (tab() === "activity" && !chat() ? "questions" : tab());
	const wayfinder = () => p().available && p().route === "wayfinder";
	// A submitted round is history while Pilot plans from it, so on a map it comes after the map.
	const submittedDoc = () => (
		<Each of={submitted() ? [submitted() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
			{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
		</Each>
	);
	// Beside Questions and Plan: the planner's status, the steps from plan to work and the earlier rounds, which
	// hold both interviews and reviews.
	const side = () => (
		<>
			<PlannerStatus plans={props.plans} page={p()} />
			<If when={p().available}>
				<Steps steps={p().steps} />
			</If>
			<Rounds page={p()} />
		</>
	);
	return (
		<>
			<PageHead
				title={p().title || props.title || "Mission planning"}
				pre={
					<If when={p().available}>
						<Caption>Interview and plan</Caption>
					</If>
				}
				state={
					<If when={p().available}>
						<State
							kind={stageMark(p().stage)}
							label={
								p().route === "wayfinder"
									? `${stageWord(p().stage)} · Mapped across sessions`
									: stageWord(p().stage)
							}
						/>
					</If>
				}
				text={p().goal ? `You asked: ${p().goal}` : undefined}
				actions={props.action}
			>
				<If when={p().destination}>
					<Body measure>{`Where it should end up: ${p().destination}`}</Body>
				</If>
				<If when={props.readNote}>
					<Notice role="alert" text={props.readNote} />
				</If>
				<If when={!p().available}>
					<Notice testID="planning-unavailable" text={p().reason} />
				</If>
			</PageHead>
			<Panel
				testID="plan-panel"
				notice={
					<If when={p().note}>
						<Notice kind="needs" role="alert" placement="panel" text={p().note} />
					</If>
				}
				tabs={
					<If when={p().available}>
						<Tabs testID="plan-tabs">
							<Tab
								testID="plan-tab-questions"
								label="Questions"
								selected={shownTab() === "questions"}
								onPress={() => tab.set("questions")}
							/>
							<Tab
								testID="plan-tab-plan"
								label="Plan"
								selected={shownTab() === "plan"}
								onPress={() => tab.set("plan")}
							/>
							<If when={chat()}>
								<Tab
									testID="plan-tab-activity"
									label="Activity"
									selected={shownTab() === "activity"}
									onPress={() => tab.set("activity")}
								/>
							</If>
						</Tabs>
					</If>
				}
			>
				<If when={shownTab() === "questions"}>
					<Columns
						main={
							<>
								{/* Start sits above the long plan, so a published plan shows it without scrolling. */}
								<If when={p().available}>
									<StartWork plans={props.plans} page={p()} />
								</If>
								<If when={asking() && props.artifacts}>
									<RoundPrototype page={p()} source={props.artifacts as ArtifactSource} />
								</If>
								<Each of={asking() ? [asking() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
									{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
								</Each>
								<If when={!wayfinder()}>{submittedDoc()}</If>
								<Each
									of={p().revisit ? [p().revisit as NonNullable<PlanPage["revisit"]>] : []}
									key={() => p().missionId}
								>
									{(r) => <RevisitSection plans={props.plans} page={p()} revisit={r()} />}
								</Each>
								<If when={!asking() && !submitted() && !p().revisit && !wayfinder()}>
									<Section title="Questions">
										<EmptyLine text="No questions are open for you." />
									</Section>
								</If>
							</>
						}
						side={side()}
					/>
					{/* The map's chart needs the panel's whole width, so the map spans it under the columns. */}
					<If when={wayfinder()}>
						<Column testID="plan-map">
							<MapView
								plans={props.plans}
								page={p()}
								onOpenTasks={props.onOpenTasks}
								onOpenChart={props.onOpenChart}
							/>
							{submittedDoc()}
						</Column>
					</If>
				</If>
				<If when={shownTab() === "plan"}>
					<Columns
						main={
							<>
								<If when={p().available}>
									<StartWork plans={props.plans} page={p()} />
								</If>
								<Each of={p().proposal ? [p().proposal as Proposal] : []} key={(x) => x.digest}>
									{(x) => <ProposalView proposal={x()} />}
								</Each>
								<If when={!p().proposal}>
									<Section title="The proposed plan">
										<EmptyLine text="Pilot proposes a plan when nothing is left to decide. Approving it publishes build tasks; it starts nothing." />
									</Section>
								</If>
								<Each of={review() ? [review() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
									{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
								</Each>
							</>
						}
						side={side()}
					/>
				</If>
				<If when={shownTab() === "activity"}>
					<Column centered>
						<PlanChat plans={props.plans} missionId={p().missionId} />
					</Column>
				</If>
			</Panel>
		</>
	);
}

/**
 * The planning of mission `props.missionId`, read again on every change.
 * Opening it asks Rust to read the saved interview and plan; that read
 * answers, submits and starts nothing.
 */
export function PlanScreen(props: {
	day?: Day;
	plans: Plans;
	missionId: string;
	interviewProject?: string;
	title?: string;
	onBackFromJump?: () => boolean;
}) {
	// Leaving stops reading this page as its agent works, and closes its chat.
	cleanup(() => props.plans.feed.leave?.(props.missionId));
	const reading = signal<"reading" | "read" | "failed">("reading");
	const readOnce = signal(false);
	effect(() => {
		if (!props.interviewProject || readOnce()) return;
		props.plans.planning();
		if (reading() === "read" || props.plans.feed.readConfirmed?.(props.missionId)) readOnce.set(true);
	});
	// An interview opened from Today must pass a new scoped read before
	// showing anything from the planning page's cache.
	const canShow = () => {
		if (!props.interviewProject) return true;
		const project = props.day?.scope
			?.view()
			.snapshot?.projects.find((p) => p.selected && p.id === props.interviewProject);
		return readOnce() && project?.planning?.plans.some((p) => p.missionId === props.missionId) === true;
	};
	const page = computed(() => {
		props.plans.planning();
		return canShow() ? (props.plans.feed.page(props.missionId) ?? null) : null;
	});
	// One level up: the mission's overview, once Today's read has the
	// mission (its agents' reports, Pause and the chats working now), else
	// Today. The header's Back and Escape both go there.
	const back = () => planBack(props.day, props.missionId);
	const inToday = () => back().label === "Mission overview";
	const toOverview = () => back().go();
	const message = signal("");
	const id = props.missionId;
	async function read() {
		reading.set("reading");
		try {
			const outcome = await props.plans.feed.open(id);
			reading.set(outcome.status === "accepted" ? "read" : "failed");
			message.set(outcome.message);
		} catch {
			reading.set("failed");
			message.set("Pilot could not read this mission's planning. Your drafts stay here. Read again.");
		}
	}
	void read();
	keymap.bind("escape", () => {
		if (!props.onBackFromJump?.()) back().go();
	});
	const scroll = keepScroll(`plan/${id}`);
	// The map's chart, full window, over this page. The page stays mounted underneath,
	// so closing the chart comes back to the same scroll position and drafts.
	const chartOpen = signal(false);
	let chartButton: ViewRef | undefined;
	const openChart = (button: ViewRef | undefined) => {
		chartButton = button;
		chartOpen.set(true);
	};
	const closeChart = () => {
		chartOpen.set(false);
		chartButton?.focus();
	};
	const fullChart = () => {
		const p = page();
		return chartOpen() && p?.available && p.route === "wayfinder" ? p : null;
	};
	// Pilot reads the page again on its own: after changes, with backoff after
	// a failure, and when the window comes back. Try now shows only with the
	// old-data warning, or while nothing could be read.
	let was = untracked(lifecycle);
	effect(() => {
		const now = lifecycle();
		if (now === "active" && was !== "active") untracked(() => props.plans.feed.focusRead?.());
		was = now;
	});
	const readAgain = () => (
		<If when={page() ? !page()?.fresh : reading() === "failed"}>
			<Button
				label={reading() === "reading" ? "Reading…" : "Try now"}
				icon="refresh"
				accessibilityLabel="Read this mission's planning again. This sends nothing."
				disabled={reading() === "reading"}
				onPress={() => void (page() && props.plans.feed.readNow ? props.plans.feed.readNow() : read())}
			/>
		</If>
	);
	const readNote = () =>
		message() && page() && !(props.interviewProject && props.plans.feed.readConfirmed?.(id)) ? message() : "";
	return (
		// The test ID says whether the page's own read is still on its way. It shows nothing.
		<View testID={reading() === "reading" ? "plan-reading" : "plan-read"} class="flex-1">
			<Scroll
				class="flex-1"
				accessibilityElementsHidden={fullChart() !== null}
				contentOffset={scroll.contentOffset}
				scrollEventThrottle={100}
				onScroll={scroll.onScroll}
			>
				<Page>
					<If
						when={page()}
						else={
							<PageHead
								title={
									reading() === "reading"
										? "Reading this mission's planning…"
										: message() ||
											(props.interviewProject && !canShow()
												? "Pilot cannot show this interview here. Your drafts are kept."
												: "This mission is not in planning any more.")
								}
								actions={readAgain()}
							/>
						}
					>
						<Each of={page() ? [page() as PlanPage] : []} key={(p) => p.missionId}>
							{(p) => (
								<PlanBody
									plans={props.plans}
									page={p()}
									title={
										props.title ||
										props.plans.planning().plans.find((row) => row.missionId === id)?.title ||
										""
									}
									onOpenTasks={inToday() ? toOverview : undefined}
									onOpenChart={openChart}
									artifacts={props.day?.artifacts as ArtifactSource | undefined}
									action={readAgain()}
									readNote={readNote()}
								/>
							)}
						</Each>
					</If>
				</Page>
			</Scroll>
			<If when={fullChart()}>
				{(p) => (
					<FullChart
						plans={props.plans}
						page={p()}
						onClose={closeChart}
						onOpenTasks={inToday() ? toOverview : undefined}
					/>
				)}
			</If>
		</View>
	);
}
