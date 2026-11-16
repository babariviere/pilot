// One mission's planning: where it should end up, the open interview, the
// map of what is still unknown, the proposed plan in full, and each step
// from answers to work. Submitting, approving, publishing and starting work
// are separate steps. Only the exact-plan confirmation starts one task.
import { cleanup, computed, type JSX, keymap, Scroll, signal, Text, View, type ViewRef } from "nsh";
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
import { ActivityLine } from "./PlanActivity";
import { flush, unsavedCount } from "./planCommands";
import type { Plans } from "./planning";
import { fogOpen, mapOpen, put, roundOpen, settledOpen } from "./planView";
import { RevisitSection } from "./RevisitDoc";
import { RoundPrototype } from "./RoundPrototype";
import { Unstick } from "./Unstick";
import {
	Action,
	Disclosure,
	ExpandableRow,
	Mark,
	type MarkKind,
	MarkLine,
	Notice,
	Page,
	PageTitle,
	SectionTitle,
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

/** A plan's mark. */
export function stageMark(stage: PlanStage): MarkKind {
	switch (stage) {
		case "questions":
		case "review":
			return "needs";
		case "unknown":
			return "unknown";
		case "published":
			return "done";
		default:
			return "moving";
	}
}

function stepMark(state: StepState): MarkKind {
	switch (state) {
		case "done":
			return "ready";
		case "now":
			return "moving";
		case "unknown":
			return "unknown";
		default:
			return "unreported";
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

/** A short list under a quiet label. */
function Lines(props: { title: string; lines: string[]; testID?: string }) {
	return (
		<If when={props.lines.length > 0}>
			<View testID={props.testID} class="gap-1">
				<Text class="text-xs font-semibold text-muted-foreground">{props.title}</Text>
				<Each of={props.lines} key={(l) => l}>
					{(l) => <Text class="text-sm leading-relaxed text-foreground">{`• ${l()}`}</Text>}
				</Each>
			</View>
		</If>
	);
}

/** The proposed plan in full: spec, testing, slices with their order and owners, and what is still unknown. */
function ProposalView(props: { proposal: Proposal }) {
	const p = () => props.proposal;
	return (
		<View testID="proposal" class="gap-5">
			<SectionTitle title="The proposed plan" />
			<View class="gap-1">
				<Text class="text-xs font-semibold text-muted-foreground">Problem</Text>
				<Text class="text-sm leading-relaxed text-foreground">{p().spec.problem}</Text>
			</View>
			<View class="gap-1">
				<Text class="text-xs font-semibold text-muted-foreground">Solution</Text>
				<Text class="text-sm leading-relaxed text-foreground">{p().spec.solution}</Text>
			</View>
			<Lines title="Who it is for" lines={p().spec.stories.map((s) => s.text)} />
			<Lines title="How it is built" lines={p().spec.implementation} />
			<Lines testID="testing" title="How it is tested" lines={p().spec.testing} />
			<Lines title="Left out" lines={p().spec.exclusions} />
			<View class="gap-2">
				<Text class="text-xs font-semibold text-muted-foreground">
					{`Tasks it would become · ${p().slices.length}`}
				</Text>
				<Each of={p().slices} key={(s) => s.id}>
					{(s) => (
						<View testID={`slice-${s().id}`} class="gap-1.5 rounded-xl border border-border px-4 py-3">
							<View class="flex-row flex-wrap items-baseline gap-2">
								<Text class="flex-1 text-sm font-medium text-foreground">{s().title}</Text>
								<Text class="text-xs text-faint">{s().owners.map(owner).join(" · ")}</Text>
							</View>
							<Text class="text-sm text-muted-foreground">{s().outcome}</Text>
							<Each of={s().acceptance} key={(a) => a}>
								{(a) => <Text class="text-xs text-foreground">{`✓ ${a()}`}</Text>}
							</Each>
							<Text class="text-xs text-faint">
								{[
									s().after.length > 0 ? `After: ${s().after.join(", ")}` : "Can start first",
									`Stories: ${s().stories.join(", ")}`,
								].join(" · ")}
							</Text>
						</View>
					)}
				</Each>
			</View>
			<Lines title="Still unknown" lines={p().openFog} testID="open-fog" />
		</View>
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
		<ExpandableRow
			open={open()}
			testID={`explore-${e().id}`}
			onToggle={() => put(mapOpen, key(), !open())}
			class="py-3"
			summaryClass="gap-1"
			content={<ItemRecord plans={props.plans} page={props.page} item={e()} class="pl-4 pt-3" />}
		>
			<View class="flex-row items-center gap-2">
				<Mark kind={exploreMark(e())} />
				<Text class="flex-1 text-sm font-medium text-foreground">{e().title}</Text>
				<Text class="text-xs text-faint">{itemWord(e())}</Text>
			</View>
			<Text class="pl-4 text-xs text-foreground">{exploreLine(e())}</Text>
			<Each of={e().changed} key={(c) => c}>
				{(c) => <Text class="pl-4 text-xs text-needs-ink">{c()}</Text>}
			</Each>
		</ExpandableRow>
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
			<View testID={props.testID}>
				<Text class="pb-1 text-xs text-faint">{`${props.title}  ${props.items.length}`}</Text>
				<Each of={props.items} key={(e) => e.id}>
					{(e) => <MapItem plans={props.plans} page={props.page} item={e()} />}
				</Each>
			</View>
		</If>
	);
}

function FogRow(props: { plans: Plans; page: PlanPage; fog: FogArea }) {
	return (
		<View testID={`fog-${props.fog.id}`} class="gap-1 border-t border-border py-3">
			<Text class="text-sm font-medium text-foreground">{props.fog.area}</Text>
			<FogRecord plans={props.plans} page={props.page} fog={props.fog} />
		</View>
	);
}

/**
 * The Wayfinder map: the same saved records the coordinator reads. What is
 * open now, what waits, what is settled, the fog of war and the agreement.
 * Reading it answers, approves and starts nothing.
 */
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
					mark: "unreported" as MarkKind,
					title: "Pilot proposes a plan",
					who: "Later",
					line: "When nothing is left to decide. Approving it publishes build tasks; it starts nothing.",
				};
		}
	};
	return (
		<View testID="map-plan-step" class="gap-1 border-t border-border pt-3">
			<View class="flex-row items-center gap-2">
				<Mark kind={step().mark} />
				<Text class="flex-1 text-sm font-medium text-foreground">{step().title}</Text>
				<Text class="text-xs text-faint">{step().who}</Text>
			</View>
			<Text class="pl-4 text-xs text-muted-foreground">{step().line}</Text>
		</View>
	);
}

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
		<View testID="map" class="gap-5">
			<View class="gap-1">
				<SectionTitle title="Map">
					<If when={props.page.map}>
						<Text class="text-xs text-faint">{`Revision ${props.page.map?.revision ?? 0}`}</Text>
					</If>
				</SectionTitle>
				<Text testID="map-summary" class="text-sm text-muted-foreground">
					{mapSummary(props.page)}
				</Text>
				<If when={changed() > 0}>
					<Text testID="map-changed" class="text-xs leading-relaxed text-needs-ink">
						{changed() === 1
							? "1 question cites a record that changed. Pilot updates the map from it; nothing here needs you."
							: `${changed()} questions cite records that changed. Pilot updates the map from them; nothing here needs you.`}
					</Text>
				</If>
			</View>
			<ExpeditionChart
				plans={props.plans}
				page={props.page}
				state={chart}
				mode="inline"
				onOpenFull={props.onOpenChart}
				onOpenTasks={props.onOpenTasks}
			/>
			<Text class="text-xs leading-relaxed text-faint">
				{`Select a place for its field notes. Open the chart (${keymap.label(OPEN_CHART)}) to look around and zoom. Esc closes the notes. Reading the chart answers, approves and starts nothing.`}
			</Text>
			<View testID="map-next" class="gap-3">
				<SectionTitle title="Next on the route">
					<Text class="text-xs text-faint">In order</Text>
				</SectionTitle>
				<MapGroup plans={props.plans} testID="map-now" title="Open now" items={now()} page={props.page} />
				<MapGroup plans={props.plans} testID="map-waiting" title="Waiting" items={waiting()} page={props.page} />
				<If when={!props.page.prototypes.available && items().some((e) => e.kind === "prototype")}>
					<Text class="text-xs text-faint">{props.page.prototypes.line}</Text>
				</If>
				<PlanStep page={props.page} />
			</View>
			<If when={settled().length > 0}>
				<Disclosure
					testID="settled-toggle"
					label={`Settled · ${settled().length}`}
					open={done()}
					onToggle={() => put(settledOpen, id(), !done())}
				>
					<View testID="map-settled" class="gap-0">
						<Text class="pb-2 text-xs leading-relaxed text-muted-foreground">
							Settled questions are not asked again. Open one to see what settled it.
						</Text>
						<Each of={settled()} key={(e) => e.id}>
							{(e) => <MapItem plans={props.plans} page={props.page} item={e()} />}
						</Each>
					</View>
				</Disclosure>
			</If>
			<Disclosure
				testID="fog-toggle"
				label={`Fog of war · ${active().length}`}
				open={fog()}
				onToggle={() => put(fogOpen, id(), !fog())}
			>
				<View class="gap-0">
					<Text class="pb-2 text-xs leading-relaxed text-muted-foreground">
						Areas Pilot does not understand well enough to ask precise questions about yet. Fog is not a problem
						and blocks nothing.
					</Text>
					<Each of={active()} key={(f) => f.id}>
						{(f) => <FogRow plans={props.plans} page={props.page} fog={f()} />}
					</Each>
					<If when={explored().length > 0}>
						<Text class="pt-3 text-xs text-faint">Explored</Text>
						<Each of={explored()} key={(f) => f.id}>
							{(f) => <FogRow plans={props.plans} page={props.page} fog={f()} />}
						</Each>
					</If>
				</View>
			</Disclosure>
			<If when={props.page.map}>
				<Agreement info={props.page.map as MapInfo} onOpenTasks={props.onOpenTasks} />
			</If>
			<ExpeditionLog page={props.page} state={chart} />
			<ChartKey />
		</View>
	);
}

/** Each step from answers to work, separately. */
function Steps(props: { steps: Step[] }) {
	return (
		<View testID="steps" class="gap-1">
			<View class="pb-2">
				<SectionTitle title="From plan to work" />
			</View>
			<Each of={props.steps} key={(s) => s.label}>
				{(s) => (
					<View class="py-1.5">
						<MarkLine kind={stepMark(s().state)}>
							<Text class="text-sm text-foreground">{`${s().label}: ${stepWord(s().state)}`}</Text>
							<Text class="text-xs text-faint">{s().line}</Text>
						</MarkLine>
					</View>
				)}
			</Each>
		</View>
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
			<View class="gap-2">
				<If when={work()?.canStart && !shown() && !uncertain()}>
					<Action
						label="Start work"
						variant="primary"
						disabled={busy() || !props.plans.feed.startWork}
						onPress={() => shown.set(work() ?? null)}
					/>
				</If>
				<If when={shown()}>
					<Text class="text-sm text-foreground">{`Start “${shown()?.title}” as one background Build task?`}</Text>
					<Text class="text-xs text-faint">{`${shown()?.project} · ${shown()?.model} · ${shown()?.thinking}. Access: ${shown()?.access}. Existing limits apply. Other tasks do not start.`}</Text>
					<View class="flex-row gap-2">
						<Action
							label={busy() ? "Starting…" : "Start task"}
							variant="primary"
							disabled={busy() || !current()}
							onPress={() => void send()}
						/>
						<Action label="Cancel" disabled={busy()} onPress={() => shown.set(null)} />
					</View>
				</If>
				<If when={work()?.canCheck || uncertain()}>
					<Action label="Check Start" disabled={busy()} onPress={() => void send(true)} />
				</If>
				<If when={note()}>
					<Text role="alert" class="text-xs text-muted-foreground">
						{note()}
					</Text>
				</If>
			</View>
		</If>
	);
}

/** Earlier interview rounds: each one's own completion and answers, apart from the plan's approval. */
function Rounds(props: { page: PlanPage }) {
	const p = () => props.page;
	return (
		<If when={p().rounds.length > 0}>
			<View testID="rounds" class="gap-1">
				<SectionTitle title="Earlier interview rounds" count={p().rounds.length} />
				<Text class="pb-2 text-xs leading-relaxed text-faint">
					Submitting a round completes that round. It is not agreement to the plan or approval to build.
				</Text>
				<Each of={p().rounds} key={(r) => r.id}>
					{(r) => {
						const key = () => `${p().missionId}/${r().id}`;
						const open = () => roundOpen()[key()] === true;
						return (
							<ExpandableRow
								open={open()}
								testID={`round-${r().id}`}
								onToggle={() => {
									if (r().answers.length > 0) put(roundOpen, key(), !open());
								}}
								class="py-2"
								summaryClass="flex-row items-center gap-3"
								content={
									<View testID={`round-answers-${r().id}`} class="gap-2 pb-1 pl-4 pt-2">
										<Each of={r().answers} key={(a) => a.prompt}>
											{(a) => (
												<View class="gap-0.5">
													<Text class="text-xs text-muted-foreground">{a().prompt}</Text>
													<Text class="text-sm text-foreground">{a().answer || "No answer"}</Text>
												</View>
											)}
										</Each>
									</View>
								}
							>
								<Mark kind={r().state === "submitted" ? "done" : "unreported"} />
								<Text class="w-40 text-sm text-foreground">{r().title}</Text>
								<Text class="flex-1 text-sm text-muted-foreground">{r().line}</Text>
								<If when={r().answers.length > 0}>
									<Text class="text-xs text-faint">{open() ? "Hide answers" : "Show answers"}</Text>
								</If>
							</ExpandableRow>
						);
					}}
				</Each>
			</View>
		</If>
	);
}

/**
 * Wakes an idle planning agent. One quiet action under its status: it answers, approves
 * and starts nothing, and names the planning state shown, so a changed mission refuses it.
 */
function ContinuePlanning(props: { plans: Plans; page: PlanPage }) {
	const busy = signal(false);
	const message = signal("");
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
		<View class="gap-1">
			<If when={(props.page.canContinue && props.plans.feed.continuePlanning !== undefined) || busy()}>
				<View class="-ml-3 mt-1 flex-row">
					<Action
						testID="continue-planning"
						label={busy() ? "Asking Pilot to continue…" : "Continue planning"}
						accessibilityLabel="Continue planning: Pilot's planning agent picks up where it stopped. It answers, approves and starts nothing."
						disabled={busy()}
						onPress={() => void press()}
					/>
				</View>
			</If>
			<If when={message()}>
				<Text testID="continue-message" class="text-xs text-faint">
					{message()}
				</Text>
			</If>
		</View>
	);
}

function Body(props: {
	plans: Plans;
	page: PlanPage;
	title: string;
	onOpenTasks?: () => void;
	/** Opens the map's chart full window. */
	onOpenChart?: (button: ViewRef | undefined) => void;
	/** A command beside the title, such as Read again. */
	action?: JSX.Element;
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
	return (
		<View class="gap-10">
			<View class="gap-3">
				<View class="flex-row items-start gap-4">
					<View class="flex-1 gap-2">
						<PageTitle title={p().title || props.title || "Mission planning"} />
						<If when={p().available}>
							<View class="flex-row flex-wrap items-center gap-1.5">
								<Text class="text-xs text-muted-foreground">Interview and plan</Text>
								<Text class="text-xs text-faint">·</Text>
								<Mark kind={stageMark(p().stage)} />
								<Text class="text-xs text-muted-foreground">
									{p().route === "wayfinder"
										? `${stageWord(p().stage)} · Mapped across sessions`
										: stageWord(p().stage)}
								</Text>
							</View>
						</If>
					</View>
					<View class="pt-1">{props.action}</View>
				</View>
				<If when={!p().available}>
					<Notice testID="planning-unavailable" text={p().reason} />
				</If>
				<If when={p().goal}>
					<Text class="text-sm leading-relaxed text-muted-foreground">{`You asked: ${p().goal}`}</Text>
				</If>
				<If when={p().destination}>
					<Text class="text-sm leading-relaxed text-foreground">{`Where it should end up: ${p().destination}`}</Text>
				</If>
				<If when={p().note}>
					<Notice kind="needs" role="alert" text={p().note} class="mt-2" />
				</If>
				<If when={p().activity}>
					<View class="mt-2">
						<ActivityLine
							plans={props.plans}
							page={p()}
							activity={p().activity as NonNullable<PlanPage["activity"]>}
						/>
					</View>
				</If>
				<ContinuePlanning plans={props.plans} page={p()} />
				<Unstick plans={props.plans} page={p()} />
			</View>
			<If when={asking() && props.artifacts}>
				<RoundPrototype page={p()} source={props.artifacts as ArtifactSource} />
			</If>
			<If when={asking()}>
				<Each of={asking() ? [asking() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
					{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
				</Each>
			</If>
			<If when={p().available && p().route === "wayfinder"}>
				<MapView plans={props.plans} page={p()} onOpenTasks={props.onOpenTasks} onOpenChart={props.onOpenChart} />
			</If>
			<If when={submitted()}>
				<Each of={submitted() ? [submitted() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
					{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
				</Each>
			</If>
			<If when={p().proposal}>
				<Each of={p().proposal ? [p().proposal as Proposal] : []} key={(x) => x.digest}>
					{(x) => <ProposalView proposal={x()} />}
				</Each>
			</If>
			<If when={review()}>
				<Each of={review() ? [review() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
					{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
				</Each>
			</If>
			<If when={p().revisit}>
				<Each of={p().revisit ? [p().revisit as NonNullable<PlanPage["revisit"]>] : []} key={() => p().missionId}>
					{(r) => <RevisitSection plans={props.plans} page={p()} revisit={r()} />}
				</Each>
			</If>
			<If when={p().available}>
				<Steps steps={p().steps} />
				<StartWork plans={props.plans} page={p()} />
			</If>
			<Rounds page={p()} />
		</View>
	);
}

/**
 * The planning of mission `props.missionId`, read again on every change.
 * Opening it asks Rust to read the saved interview and plan; that read
 * answers, submits and starts nothing.
 */
export function PlanScreen(props: { day?: Day; plans: Plans; missionId: string; title?: string }) {
	// Leaving stops reading this page as its agent works, and closes its chat.
	cleanup(() => props.plans.feed.leave?.(props.missionId));
	const page = computed(() => {
		props.plans.planning();
		return props.plans.feed.page(props.missionId) ?? null;
	});
	// One level up: the mission's overview, once Today's read has the
	// mission (its agents' reports, Pause and the chats working now), else
	// Today. The header's Back and Escape both go there.
	const back = () => planBack(props.day, props.missionId);
	const inToday = () => back().label === "Mission overview";
	const toOverview = () => back().go();
	const reading = signal<"reading" | "read" | "failed">("reading");
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
	keymap.bind("escape", () => back().go());
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
	const readAgain = () => (
		<If when={reading() === "failed" || (page() && (!page()?.fresh || page()?.stage === "planning"))}>
			<Action
				label={reading() === "reading" ? "Reading…" : "Read again"}
				icon="refresh"
				accessibilityLabel="Read this mission's planning again. This sends nothing."
				disabled={reading() === "reading"}
				onPress={() => void read()}
			/>
		</If>
	);
	return (
		<View class="flex-1">
			<Scroll
				class="flex-1 bg-background"
				accessibilityElementsHidden={fullChart() !== null}
				contentOffset={scroll.contentOffset}
				scrollEventThrottle={100}
				onScroll={scroll.onScroll}
			>
				<Page gap={8}>
					<If when={message() && page()}>
						<Text role="alert" class="text-sm text-needs-ink">
							{message()}
						</Text>
					</If>
					<If
						when={page()}
						else={
							<View class="flex-row items-start gap-4">
								<Text class="flex-1 text-base text-muted-foreground">
									{reading() === "reading"
										? "Reading this mission's planning…"
										: message() || "This mission is not in planning any more."}
								</Text>
								{readAgain()}
							</View>
						}
					>
						<Each of={page() ? [page() as PlanPage] : []} key={(p) => p.missionId}>
							{(p) => (
								<Body
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
