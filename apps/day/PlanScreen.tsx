// One mission's planning: where it should end up, the open interview, the
// map of what is still unknown, the proposed plan in full, and each step
// from answers to work. Submitting, approving, publishing and starting work
// are separate steps, and this page only ever takes the first two.
import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import { Collapsible } from "nsh/base";
import type {
	Exploration,
	ExploreKind,
	FogArea,
	PlanPage,
	PlanStage,
	Proposal,
	SliceOwner,
	Step,
	StepState,
} from "pilot-day/native";
import type { Day } from "./day";
import { InterviewDoc } from "./InterviewDoc";
import { keepScroll } from "./kept";
import { flush, unsavedCount } from "./planCommands";
import type { Plans } from "./planning";
import { closePlanning, fogOpen, put, roundOpen } from "./planView";
import { TopBar } from "./TodayScreen";
import { Action, Mark, type MarkKind, SectionTitle } from "./ui";
import { openMission } from "./view";

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

function exploreLine(e: Exploration): string {
	switch (e.state) {
		case "waiting":
			return e.after.length > 0 ? `Waits for: ${e.after.join(", ")}` : "Waiting";
		case "ready":
			return "Ready: what it needs is resolved.";
		case "running":
			return e.by ? `Running · ${e.by}` : "Running";
		case "asking":
			return "Your answers are needed below.";
		case "resolved":
			return e.result || "Resolved";
	}
}

function exploreMark(e: Exploration): MarkKind {
	switch (e.state) {
		case "asking":
			return "needs";
		case "running":
			return "moving";
		case "resolved":
			return "done";
		case "ready":
			return "moving";
		default:
			return "unreported";
	}
}

function ExploreRow(props: { item: Exploration }) {
	const e = () => props.item;
	const meta = () =>
		[e().sources.length > 0 ? `From ${e().sources.join(", ")}` : "", e().fromFog ? `Was fog: ${e().fromFog}` : ""]
			.filter(Boolean)
			.join(" · ");
	return (
		<View testID={`explore-${e().id}`} class="gap-1 border-t border-border py-3">
			<View class="flex-row items-center gap-2">
				<Mark kind={exploreMark(e())} />
				<Text class="flex-1 text-sm font-medium text-foreground">{e().title}</Text>
			</View>
			<Text class="pl-4 text-sm text-muted-foreground">{e().question}</Text>
			<Text class="pl-4 text-xs text-foreground">{exploreLine(e())}</Text>
			<If when={meta()}>
				<Text class="pl-4 text-xs text-faint">{meta()}</Text>
			</If>
		</View>
	);
}

function ExploreGroup(props: { title: string; kind: ExploreKind; page: PlanPage }) {
	const items = () => props.page.explorations.filter((e) => e.kind === props.kind);
	return (
		<If when={items().length > 0}>
			<View>
				<Text class="pb-1 text-xs text-faint">{`${props.title}  ${items().length}`}</Text>
				<Each of={items()} key={(e) => e.id}>
					{(e) => <ExploreRow item={e()} />}
				</Each>
			</View>
		</If>
	);
}

function FogRow(props: { fog: FogArea }) {
	const f = () => props.fog;
	return (
		<View testID={`fog-${f().id}`} class="gap-1 border-t border-border py-3">
			<Text class="text-sm font-medium text-foreground">{f().area}</Text>
			<Text class="text-sm text-muted-foreground">{f().why}</Text>
			<Text class="text-xs text-foreground">
				{f().active ? `Ready when: ${f().readyWhen}` : `Became: ${f().became.join(", ")}`}
			</Text>
			<Text class="text-xs text-faint">
				{[
					f().after.length > 0 ? `After: ${f().after.join(", ")}` : "",
					f().sources.length > 0 ? `From ${f().sources.join(", ")}` : "",
				]
					.filter(Boolean)
					.join(" · ")}
			</Text>
		</View>
	);
}

/** The Wayfinder map: questions for the user, research, prototypes, and the fog of war. */
function MapView(props: { page: PlanPage }) {
	const active = () => props.page.fog.filter((f) => f.active);
	const explored = () => props.page.fog.filter((f) => !f.active);
	const frontier = () => props.page.explorations.filter((e) => e.state === "ready" || e.state === "asking");
	const open = () => fogOpen()[props.page.missionId] === true;
	return (
		<View testID="map" class="gap-5">
			<SectionTitle title="What is still open">
				<Text class="text-xs text-muted-foreground">
					{frontier().length === 1 ? "1 ready now" : `${frontier().length} ready now`}
				</Text>
			</SectionTitle>
			<ExploreGroup title="Needs your answers" kind="grilling" page={props.page} />
			<ExploreGroup title="Needs research" kind="research" page={props.page} />
			<View testID="prototypes" class="gap-1">
				<Text class="text-xs text-faint">Needs a prototype</Text>
				<ExploreGroup title="Prototypes" kind="prototype" page={props.page} />
				<If when={!props.page.prototypes.available}>
					<Text class="text-sm text-muted-foreground">{props.page.prototypes.line}</Text>
				</If>
			</View>
			<Collapsible
				open={open()}
				class="gap-1"
				content={
					<View class="gap-0">
						<Text class="pb-2 text-xs leading-relaxed text-muted-foreground">
							Areas Pilot does not understand well enough to ask precise questions about yet. Fog is not a
							problem and blocks nothing.
						</Text>
						<Each of={active()} key={(f) => f.id}>
							{(f) => <FogRow fog={f()} />}
						</Each>
						<If when={explored().length > 0}>
							<Text class="pt-3 text-xs text-faint">Explored</Text>
							<Each of={explored()} key={(f) => f.id}>
								{(f) => <FogRow fog={f()} />}
							</Each>
						</If>
					</View>
				}
			>
				<View
					testID="fog-toggle"
					role="button"
					accessibilityState={{ expanded: open() }}
					onPress={() => put(fogOpen, props.page.missionId, !open())}
					class="flex-row items-baseline gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
				>
					<Text class="text-sm text-muted-foreground">{open() ? "▾" : "▸"}</Text>
					<Text class="text-sm text-muted-foreground">{`Fog of war · ${active().length}`}</Text>
				</View>
			</Collapsible>
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
					<View class="flex-row gap-3 py-1.5">
						<View class="pt-1.5">
							<Mark kind={stepMark(s().state)} />
						</View>
						<View class="flex-1 gap-0.5">
							<Text class="text-sm text-foreground">{`${s().label}: ${stepWord(s().state)}`}</Text>
							<Text class="text-xs text-faint">{s().line}</Text>
						</View>
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
						primary
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
							primary
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
							<Collapsible
								open={open()}
								class="border-t border-border py-2"
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
								<View
									testID={`round-${r().id}`}
									role="button"
									accessibilityState={{ expanded: open() }}
									onPress={() => {
										if (r().answers.length > 0) put(roundOpen, key(), !open());
									}}
									class="flex-row items-center gap-3 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
								>
									<Mark kind={r().state === "submitted" ? "done" : "unreported"} />
									<Text class="w-40 text-sm text-foreground">{r().title}</Text>
									<Text class="flex-1 text-sm text-muted-foreground">{r().line}</Text>
									<If when={r().answers.length > 0}>
										<Text class="text-xs text-faint">{open() ? "Hide answers" : "Show answers"}</Text>
									</If>
								</View>
							</Collapsible>
						);
					}}
				</Each>
			</View>
		</If>
	);
}

function Body(props: { plans: Plans; page: PlanPage; title: string }) {
	const p = () => props.page;
	const asking = () => (p().interview && p().interview?.kind !== "review" ? p().interview : null);
	const review = () => (p().interview?.kind === "review" ? p().interview : null);
	return (
		<View class="gap-10">
			<View class="gap-2">
				<Text role="header" class="text-2xl font-semibold leading-tight tracking-tight text-foreground">
					{p().title || props.title || "Mission planning"}
				</Text>
				<If when={!p().available}>
					<View
						testID="planning-unavailable"
						class="mt-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3"
					>
						<Mark kind="unknown" />
						<Text class="flex-1 text-sm text-foreground">{p().reason}</Text>
					</View>
				</If>
				<If when={p().available}>
					<View class="flex-row items-center gap-1.5">
						<Mark kind={stageMark(p().stage)} />
						<Text class="text-xs text-muted-foreground">
							{p().route === "wayfinder"
								? `${stageWord(p().stage)} · Mapped across sessions`
								: stageWord(p().stage)}
						</Text>
					</View>
				</If>
				<If when={p().goal}>
					<Text class="text-sm leading-relaxed text-muted-foreground">{`You asked: ${p().goal}`}</Text>
				</If>
				<If when={p().destination}>
					<Text class="text-sm leading-relaxed text-foreground">{`Where it should end up: ${p().destination}`}</Text>
				</If>
				<If when={p().note}>
					<View class="mt-2 flex-row items-center gap-2.5 rounded-xl bg-muted px-4 py-3">
						<Mark kind="needs" />
						<Text role="alert" class="flex-1 text-sm text-foreground">
							{p().note}
						</Text>
					</View>
				</If>
			</View>
			<If when={asking()}>
				<Each of={asking() ? [asking() as NonNullable<PlanPage["interview"]>] : []} key={(iv) => iv.id}>
					{(iv) => <InterviewDoc plans={props.plans} page={p()} interview={iv()} />}
				</Each>
			</If>
			<If when={p().available && p().route === "wayfinder"}>
				<MapView page={p()} />
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
	const page = computed(() => {
		props.plans.planning();
		return props.plans.feed.page(props.missionId) ?? null;
	});
	// The mission's overview, once Today's read has the mission: its agents'
	// reports, Pause and the chats working now.
	const inToday = () => {
		const t = props.day?.today();
		return !!t && [...t.moving, ...t.notMoving, ...t.unreported].some((m) => m.id === props.missionId);
	};
	const toOverview = () => {
		closePlanning();
		openMission(props.missionId);
	};
	const reading = signal<"reading" | "read" | "failed">("reading");
	const message = signal("");
	const id = props.missionId;
	void props.plans.feed.open(id).then((outcome) => {
		reading.set(outcome.status === "accepted" ? "read" : "failed");
		message.set(outcome.message);
	});
	keymap.bind("escape", closePlanning);
	const scroll = keepScroll(`plan/${id}`);
	return (
		<Scroll
			class="flex-1 bg-background"
			contentOffset={scroll.contentOffset}
			scrollEventThrottle={100}
			onScroll={scroll.onScroll}
		>
			<View class="w-full max-w-2xl self-center gap-8 px-6 pb-24 pt-6">
				<TopBar />
				<View class="flex-row items-center gap-2">
					<Action label="‹ Today" accessibilityLabel="Back to Today" onPress={closePlanning} />
					<If when={inToday()}>
						<Action
							testID="open-overview"
							label="Mission overview"
							accessibilityLabel="Open this mission's overview"
							onPress={toOverview}
						/>
					</If>
				</View>
				<If when={message() && page()}>
					<Text role="alert" class="text-sm text-needs-ink">
						{message()}
					</Text>
				</If>
				<If
					when={page()}
					else={
						<Text class="text-base text-muted-foreground">
							{reading() === "reading"
								? "Reading this mission's planning…"
								: message() || "This mission is not in planning any more."}
						</Text>
					}
				>
					<Each of={page() ? [page() as PlanPage] : []} key={(p) => p.missionId}>
						{(p) => <Body plans={props.plans} page={p()} title={props.title ?? ""} />}
					</Each>
				</If>
			</View>
		</Scroll>
	);
}
