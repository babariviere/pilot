// One mission's planning: where it should end up, the open interview, the
// map of what is still unknown, the proposed plan in full, and each step
// from answers to work. Submitting, approving, publishing and starting work
// are separate steps. Only the exact-plan confirmation starts one task.
import { computed, keymap, Scroll, signal, Text, View } from "nsh";
import { Collapsible } from "nsh/base";
import type {
	Exploration,
	ExploreKind,
	FogArea,
	MapInfo,
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
import { MapSources } from "./MapSources";
import { flush, unsavedCount } from "./planCommands";
import type { Plans } from "./planning";
import { closePlanning, fogOpen, mapOpen, put, roundOpen, settledOpen } from "./planView";
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
			return "Its questions for you are open above.";
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

/** What kind of uncertainty a question is, in the words the map uses. */
function kindWord(kind: ExploreKind): string {
	switch (kind) {
		case "grilling":
			return "Needs your answers";
		case "research":
			return "Needs research";
		case "prototype":
			return "Needs a prototype";
	}
}

/** A short list under a quiet label, inside a map record. */
function Detail(props: { title: string; lines: string[] }) {
	return (
		<If when={props.lines.length > 0}>
			<View class="gap-0.5">
				<Text class="text-xs text-faint">{props.title}</Text>
				<Each of={props.lines} key={(l) => l}>
					{(l) => <Text class="text-sm leading-relaxed text-foreground">{`• ${l()}`}</Text>}
				</Each>
			</View>
		</If>
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
	// A question settled in an interview shows that round's answers, as submitted.
	const round = () => (e().round ? (props.page.rounds.find((r) => r.id === e().round) ?? null) : null);
	const origin = () =>
		[e().sources.length > 0 ? `From ${e().sources.join(", ")}` : "", e().fromFog ? `Was fog: ${e().fromFog}` : ""]
			.filter(Boolean)
			.join(" · ");
	return (
		<Collapsible
			open={open()}
			class="border-t border-border py-3"
			content={
				<View testID={`record-${e().id}`} class="gap-3 pl-4 pt-3">
					<Text class="text-sm leading-relaxed text-foreground">{e().question}</Text>
					<If when={e().evidence}>
						<Text class="text-sm text-foreground">{e().evidence}</Text>
					</If>
					<Detail title="What the prototype showed" lines={e().observations} />
					<Detail title="What it left open" lines={e().unresolved} />
					<If when={round()}>
						<View testID={`settled-round-${e().id}`} class="gap-2">
							<Text class="text-xs text-faint">{`${round()?.title ?? ""} · your answers, as submitted`}</Text>
							<Each of={round()?.answers ?? []} key={(a) => a.prompt}>
								{(a) => (
									<View class="gap-0.5">
										<Text class="text-xs text-muted-foreground">{a().prompt}</Text>
										<Text class="text-sm text-foreground">{a().answer || "No answer"}</Text>
									</View>
								)}
							</Each>
						</View>
					</If>
					<MapSources plans={props.plans} page={props.page} area="item" recordId={e().id} refs={e().sourceRefs} />
					<If when={origin()}>
						<Text class="text-xs text-faint">{origin()}</Text>
					</If>
				</View>
			}
		>
			<View
				testID={`explore-${e().id}`}
				role="button"
				accessibilityState={{ expanded: open() }}
				onPress={() => put(mapOpen, key(), !open())}
				class="gap-1 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
			>
				<View class="flex-row items-center gap-2">
					<Mark kind={exploreMark(e())} />
					<Text class="flex-1 text-sm font-medium text-foreground">{e().title}</Text>
					<Text class="text-xs text-faint">{kindWord(e().kind)}</Text>
				</View>
				<Text class="pl-4 text-xs text-foreground">{exploreLine(e())}</Text>
				<Each of={e().changed} key={(c) => c}>
					{(c) => <Text class="pl-4 text-xs text-needs-ink">{c()}</Text>}
				</Each>
			</View>
		</Collapsible>
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
	const f = () => props.fog;
	return (
		<View testID={`fog-${f().id}`} class="gap-1 border-t border-border py-3">
			<Text class="text-sm font-medium text-foreground">{f().area}</Text>
			<Text class="text-sm text-muted-foreground">{f().why}</Text>
			<Text class="text-xs text-foreground">
				{f().active ? `Ready when: ${f().readyWhen}` : `Became: ${f().became.join(", ")}`}
			</Text>
			<MapSources plans={props.plans} page={props.page} area="fog" recordId={f().id} refs={f().sourceRefs} />
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

/** A disclosure line that opens a quiet section, such as the fog of war. */
function Disclosure(props: { testID: string; label: string; open: boolean; onToggle: () => void }) {
	return (
		<View
			testID={props.testID}
			role="button"
			accessibilityState={{ expanded: props.open }}
			onPress={props.onToggle}
			class="flex-row items-baseline gap-2 rounded-md focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Text class="text-sm text-muted-foreground">{props.open ? "▾" : "▸"}</Text>
			<Text class="text-sm text-muted-foreground">{props.label}</Text>
		</View>
	);
}

/** The agreement and the tasks it became. Opening a task shows the mission overview; it starts nothing. */
function Agreement(props: { info: MapInfo; onOpenTasks?: () => void }) {
	return (
		<If when={props.info.agreement || props.info.tasks.length > 0}>
			<View testID="map-agreement" class="gap-1">
				<Text class="text-xs text-faint">Agreement</Text>
				<Text class="text-sm text-foreground">{props.info.agreement}</Text>
				<Each of={props.info.tasks} key={(t) => t.id}>
					{(t) => (
						<View class="flex-row items-baseline gap-3 py-1">
							<Text class="w-7 text-xs text-faint">{t().number > 0 ? `#${t().number}` : ""}</Text>
							<Text class="flex-1 text-sm text-foreground">{t().title}</Text>
							<Text class="text-xs text-muted-foreground">{t().status}</Text>
						</View>
					)}
				</Each>
				<If when={props.info.tasks.length > 0 && props.onOpenTasks}>
					<View class="flex-row">
						<Action label="Open the tasks" onPress={() => props.onOpenTasks?.()} />
					</View>
				</If>
			</View>
		</If>
	);
}

/**
 * The Wayfinder map: the same saved records the coordinator reads. What is
 * open now, what waits, what is settled, the fog of war and the agreement.
 * Reading it answers, approves and starts nothing.
 */
function MapView(props: { plans: Plans; page: PlanPage; onOpenTasks?: () => void }) {
	const items = () => props.page.explorations;
	const now = () => openNow(props.page);
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
			<MapGroup plans={props.plans} testID="map-now" title="Open now" items={now()} page={props.page} />
			<MapGroup plans={props.plans} testID="map-waiting" title="Waiting" items={waiting()} page={props.page} />
			<If when={!props.page.prototypes.available && items().some((e) => e.kind === "prototype")}>
				<Text class="text-xs text-faint">{props.page.prototypes.line}</Text>
			</If>
			<If when={settled().length > 0}>
				<Collapsible
					open={done()}
					class="gap-1"
					content={
						<View testID="map-settled" class="gap-0">
							<Text class="pb-2 text-xs leading-relaxed text-muted-foreground">
								Settled questions are not asked again. Open one to see what settled it.
							</Text>
							<Each of={settled()} key={(e) => e.id}>
								{(e) => <MapItem plans={props.plans} page={props.page} item={e()} />}
							</Each>
						</View>
					}
				>
					<Disclosure
						testID="settled-toggle"
						label={`Settled · ${settled().length}`}
						open={done()}
						onToggle={() => put(settledOpen, id(), !done())}
					/>
				</Collapsible>
			</If>
			<Collapsible
				open={fog()}
				class="gap-1"
				content={
					<View class="gap-0">
						<Text class="pb-2 text-xs leading-relaxed text-muted-foreground">
							Areas Pilot does not understand well enough to ask precise questions about yet. Fog is not a
							problem and blocks nothing.
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
				}
			>
				<Disclosure
					testID="fog-toggle"
					label={`Fog of war · ${active().length}`}
					open={fog()}
					onToggle={() => put(fogOpen, id(), !fog())}
				/>
			</Collapsible>
			<If when={props.page.map}>
				<Agreement info={props.page.map as MapInfo} onOpenTasks={props.onOpenTasks} />
			</If>
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

function Body(props: { plans: Plans; page: PlanPage; title: string; onOpenTasks?: () => void }) {
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
				<MapView plans={props.plans} page={p()} onOpenTasks={props.onOpenTasks} />
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
					<If when={reading() === "failed" || (page() && (!page()?.fresh || page()?.stage === "planning"))}>
						<Action label="Read again" disabled={reading() === "reading"} onPress={() => void read()} />
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
						{(p) => (
							<Body
								plans={props.plans}
								page={p()}
								title={
									props.title || props.plans.planning().plans.find((row) => row.missionId === id)?.title || ""
								}
								onOpenTasks={inToday() ? toOverview : undefined}
							/>
						)}
					</Each>
				</If>
			</View>
		</Scroll>
	);
}
