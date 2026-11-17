// The mission's work, first: what is working now, what is next in the plan,
// and what is blocked. Every task's work state and reason come from the
// native read (`TaskLine.workState`, `workReason`); this file keeps the
// canonical task order and says each state in words. It never decides that a
// task can run, that a chat is free or that a dependency is met. Opening a
// chat or a task's details only reads.
import { effect, signal, Text, untracked, View, type ViewRef } from "nsh";
import type { Decision, MissionPage, TaskLine, TaskPrerequisite } from "pilot-day/native";
import { openChat } from "./chatView";
import { type ContentAnchor, yieldAnchor } from "./contentAnchor";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { restoreScroll, scrollOf } from "./kept";
import { goHome } from "./nav";
import { Action, Disclosure, ExpandableRow, glide, Mark, Panel, SectionTitle } from "./ui";
import { focused, focusFront, todayPlace } from "./view";
import { provenance, stateOf, taskWord, type WorkState, workMark, workWord } from "./words";

type Lane = "now" | "next" | "blocked";

/** Which tasks show their details, by task id. Kept across updates, lane changes and Back. */
const openWork = signal<Record<string, boolean>>({});
/** The task whose focus target has the keyboard focus now, from its own focus and blur. */
const focusedTask = signal<string | null>(null);
/** The lane each task was last drawn in, to tell a lane change from a first draw or a return with Back. */
const lanes = new Map<string, Lane>();

/** Where a task's keyboard focus target is, and how it reports the focus. */
type Target = {
	anchor: (node: ViewRef) => void;
	onFocus: () => void;
	onBlur: () => void;
	/** Gives the target the keyboard focus, as a press on it does. */
	focus: () => void;
};

function toggleWork(id: string, target: Target) {
	glide();
	openWork.update((all) => ({ ...all, [id]: !all[id] }));
	// A press gives the target the keyboard focus, so a later lane change can follow it; its blur clears this.
	target.focus();
	focusedTask.set(id);
}

/** Kept for the page's other controls; the focus itself says where the user is. */
export function forgetWorkFocus() {
	focusedTask.set(null);
}

/**
 * The focus target of a task drawn in `lane`. Only when that task's target
 * has the keyboard focus and an update moves the task to another lane does
 * its new place take the focus. A blur from the old place, once it is gone,
 * does not count.
 */
function laneFocus(id: string, lane: Lane): Target {
	const before = lanes.get(id);
	lanes.set(id, lane);
	const moved = before !== undefined && before !== lane;
	const node = signal<ViewRef | null>(null);
	let alive = true;
	effect(() => () => {
		alive = false;
	});
	effect(() => {
		const n = node();
		if (n && moved && untracked(focusedTask) === id) {
			n.focus();
			// The focus moved with the task: show its new place rather than keep the page still.
			yieldAnchor();
			n.reveal({ vertical: "nearest", animated: false });
		}
	});
	return {
		anchor: (n: ViewRef) => node.set(n),
		onFocus: () => focusedTask.set(id),
		onBlur: () => {
			if (alive && untracked(focusedTask) === id) focusedTask.set(null);
		},
		focus: () => untracked(node)?.focus(),
	};
}

/** How many rows each long list shows, by list key. Kept across updates and Back. */
const shownCount = signal<Record<string, number>>({});

/** The first rows of a long list. The rest stay one press away and are never dropped silently. */
export function limited<T>(listKey: string, items: T[], first: number): T[] {
	const n = shownCount()[listKey] ?? first;
	return items.length > n ? items.slice(0, n) : items;
}

/** Says how many rows a limited list shows, and shows more on request. Opening more only reads. */
export function MoreRows(props: { listKey: string; total: number; first: number; step: number; testID: string }) {
	const n = () => Math.min(shownCount()[props.listKey] ?? props.first, props.total);
	const more = () => Math.min(props.step, props.total - n());
	return (
		<If when={props.total > n()}>
			<View testID={props.testID} class="flex-row flex-wrap items-center gap-x-3 gap-y-1 py-2">
				<Text class="text-xs text-muted-foreground">{`Showing ${n()} of ${props.total}.`}</Text>
				<Action
					label={`Show ${more()} more`}
					testID={`${props.testID}-more`}
					onPress={() => shownCount.update((all) => ({ ...all, [props.listKey]: n() + more() }))}
				/>
			</View>
		</If>
	);
}

/** Large cards shown in Now before "Show more". */
const NOW_SHOWN = 6;
/** Rows shown in Next before "Show more". */
const NEXT_SHOWN = 8;
/** Blocked tasks shown in the narrow column before "Show more". */
const BLOCKED_SHOWN = 6;

/** Opens one of the mission's chats, read only. Back returns to the mission page where it was. */
export function openMemberChat(page: MissionPage, sessionId: string) {
	const missionId = page.row.id;
	restoreScroll(`mission/${missionId}`, scrollOf(`mission/${missionId}`));
	openChat(sessionId, page.row.title || "Mission overview");
}

function unfinished(task: TaskLine): boolean {
	return stateOf(task) !== "completed" && task.status !== "done";
}

/** The unfinished tasks the native read does not place: an older service, or a state it cannot tell. */
function unplaced(page: MissionPage): TaskLine[] {
	return page.tasks.filter((t) => stateOf(t) === "unknown" && unfinished(t));
}

/**
 * Where a task shows. Held work that was active or in review shows where it
 * stopped, in Now. A held task that also waits for earlier work or is marked
 * blocked stays in Blockers with its reasons. Other held tasks not started
 * yet stay in Next, so a paused large plan never becomes a wall of cards.
 */
function laneOf(task: TaskLine): Lane | null {
	switch (stateOf(task)) {
		case "working":
		case "review":
		case "waitingForUser":
			return "now";
		case "held":
			if (task.status === "inProgress" || task.status === "inReview") return "now";
			// A hold never hides what already blocks a task.
			if ((task.prerequisites ?? []).length > 0 || task.status === "blocked") return "blocked";
			return "next";
		case "queued":
		case "assigned":
		case "delegated":
			return "next";
		case "dependencyBlocked":
		case "blocked":
			return "blocked";
		default:
			return null;
	}
}

/** The host's reasons, one line each. */
function Reasons(props: { task: TaskLine; class?: string }) {
	const lines = () =>
		(props.task.workReason ?? "")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l);
	return (
		<Each of={lines()} key="index">
			{(line) => <Text class={props.class ?? "text-sm text-foreground"}>{line()}</Text>}
		</Each>
	);
}

/**
 * The unfinished tasks this one waits for, as the read lists them. A
 * prerequisite the read cannot find keeps its own words and no number.
 */
function Prerequisites(props: { task: TaskLine }) {
	const line = (p: TaskPrerequisite) =>
		p.number > 0
			? `#${p.number} ${p.title} · ${taskWord(p.status)}`
			: `${p.title || "Prerequisite unavailable"} · ${taskWord(p.status)}`;
	return (
		<If when={(props.task.prerequisites ?? []).length > 0}>
			<View testID={`prerequisites-${props.task.id}`} class="gap-0.5">
				<Text class="text-xs text-muted-foreground">Waits for</Text>
				<Each of={props.task.prerequisites ?? []} key={(p) => p.id}>
					{(p) => <Text class="text-xs text-foreground">{line(p())}</Text>}
				</Each>
			</View>
		</If>
	);
}

/** A task's state: its mark and words. The words carry the meaning. */
function WorkStatus(props: { state: WorkState }) {
	return (
		<View class="flex-row items-center gap-1.5">
			<Mark kind={workMark(props.state)} />
			<Text
				class="text-xs"
				classList={{
					"text-needs-ink": props.state === "waitingForUser",
					"text-foreground": props.state === "working",
					"text-muted-foreground": props.state !== "waitingForUser" && props.state !== "working",
				}}
			>
				{workWord(props.state)}
			</Text>
		</View>
	);
}

/** The chat that owns the task, read only. */
function ChatLink(props: { day: Day; page: MissionPage; task: TaskLine; lane: Lane }) {
	return (
		<If when={props.task.sessionId && props.day.chat}>
			<View class="flex-row pt-1">
				<Action
					variant="outline"
					label="Open its chat"
					testID={`${props.lane}-chat-${props.task.id}`}
					accessibilityLabel={`Open the chat of #${props.task.number} ${props.task.title}, read only. Opening it sends nothing.`}
					onPress={() => openMemberChat(props.page, props.task.sessionId ?? "")}
				/>
			</View>
		</If>
	);
}

/** The task's own words, as the mission records them. Opening them only reads. */
function Details(props: { task: TaskLine; lane: Lane; target: Target }) {
	const open = () => !!openWork()[props.task.id];
	return (
		<Disclosure
			label={open() ? "Hide details" : "Details"}
			open={open()}
			testID={`${props.lane}-details-${props.task.id}`}
			accessibilityLabel={`${open() ? "Hide" : "Show"} the details of #${props.task.number} ${props.task.title}.`}
			anchor={props.target.anchor}
			onFocus={props.target.onFocus}
			onBlur={props.target.onBlur}
			onToggle={() => toggleWork(props.task.id, props.target)}
		>
			<View selectable class="gap-1 pl-5">
				<Text class="text-sm leading-relaxed text-muted-foreground">
					{(props.task.body ?? "") || "No details are recorded for this task."}
				</Text>
			</View>
		</Disclosure>
	);
}

/** A task with work on it now, large: what it is, where it stands, who has it and its chat. */
function NowCard(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const target = laneFocus(props.task.id, "now");
	return (
		<Panel testID={`now-${t().id}`} tone="card" size="lg" class="gap-2">
			<View selectable class="gap-2">
				<View class="flex-row flex-wrap items-baseline gap-x-2 gap-y-1">
					<Text class="text-xs text-faint">{`#${t().number}`}</Text>
					<Text class="min-w-40 flex-1 text-base font-semibold text-foreground">{t().title}</Text>
					<WorkStatus state={stateOf(t())} />
				</View>
				<Reasons task={t()} />
				<If when={t().report}>
					<Text class="text-sm text-muted-foreground">{t().report?.summary ?? ""}</Text>
					<Text class="text-xs text-faint">
						{t().report
							? `${provenance(t().report as NonNullable<TaskLine["report"]>)} · agent words, not verified`
							: ""}
					</Text>
				</If>
				<If when={t().ownerTitle ?? ""}>
					<Text class="text-xs text-muted-foreground">{`Owner: ${t().ownerTitle ?? ""}`}</Text>
				</If>
				<Prerequisites task={t()} />
			</View>
			<Details task={t()} lane="now" target={target} />
			<ChatLink day={props.day} page={props.page} task={t()} lane="now" />
		</Panel>
	);
}

/** One task later in the plan. It opens in place with its reasons, owner, prerequisites and body. */
function NextRow(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const open = () => !!openWork()[t().id];
	const target = laneFocus(props.task.id, "next");
	return (
		<ExpandableRow
			open={open()}
			anchor={target.anchor}
			onFocus={target.onFocus}
			onBlur={target.onBlur}
			testID={`next-${t().id}`}
			accessibilityLabel={`#${t().number} ${t().title}, ${workWord(stateOf(t()))}. ${open() ? "Hide" : "Show"} its details.`}
			onToggle={() => toggleWork(t().id, target)}
			summaryClass="flex-row items-baseline gap-3 px-1 py-2 hover:bg-accent"
			content={
				<View class="gap-1.5 pb-3 pl-10">
					<View selectable class="gap-1.5">
						<Reasons task={t()} class="text-sm text-muted-foreground" />
						<If when={t().ownerTitle ?? ""}>
							<Text class="text-xs text-muted-foreground">{`Owner: ${t().ownerTitle ?? ""}`}</Text>
						</If>
						<Prerequisites task={t()} />
						<Text class="text-sm leading-relaxed text-muted-foreground">
							{(t().body ?? "") || "No details are recorded for this task."}
						</Text>
					</View>
					<ChatLink day={props.day} page={props.page} task={t()} lane="next" />
				</View>
			}
		>
			<Text class="w-7 text-xs text-faint">{`#${t().number}`}</Text>
			<Text class="flex-1 text-sm text-foreground">{t().title}</Text>
			<Text class="text-xs text-muted-foreground">{workWord(stateOf(t()))}</Text>
		</ExpandableRow>
	);
}

/** One blocked task in the narrow column: why it cannot move, and what it waits for. */
function BlockedItem(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const target = laneFocus(props.task.id, "blocked");
	return (
		<Panel testID={`blocked-${t().id}`} tone="card" size="md" class="gap-1.5">
			<View selectable class="gap-1">
				<Text class="text-xs font-semibold text-foreground">{workWord(stateOf(t()))}</Text>
				<Text class="text-sm text-foreground">{`#${t().number} ${t().title}`}</Text>
				<Reasons task={t()} class="text-xs text-muted-foreground" />
				<Prerequisites task={t()} />
			</View>
			<Details task={t()} lane="blocked" target={target} />
			<ChatLink day={props.day} page={props.page} task={t()} lane="blocked" />
		</Panel>
	);
}

/** What the mission waits for from the user, and the one way to it: its card on Today. */
function Waiting(props: { decision: Decision }) {
	const d = () => props.decision;
	const verb = () => {
		if (d().kind === "review") return "Review it on Today";
		if (d().kind === "unknown" || d().delivery === "unknown") return "Check it on Today";
		return "Decide on Today";
	};
	return (
		<Panel testID="mission-waiting" tone="card" size="md" class="gap-1.5">
			<View class="flex-row items-center gap-1.5">
				<Mark kind={decisionMark(d())} />
				<Text class="text-xs font-semibold text-needs-ink">Waiting for you</Text>
			</View>
			<Text class="text-sm font-medium text-foreground">{d().title}</Text>
			<View class="flex-row pt-1">
				<Action
					variant="primary"
					label={verb()}
					accessibilityLabel={`${verb()}: ${d().title}`}
					onPress={() => {
						// The card takes the keyboard focus on Today, not the mission's row.
						todayPlace.row = null;
						focused.set(d().id);
						focusFront.set(true);
						goHome();
					}}
				/>
			</View>
		</Panel>
	);
}

/**
 * The mission's own Pause. It holds new work; a chat the read still shows
 * working is in Now with its reasons. Resume stays in the control panel above.
 */
function Paused(props: { page: MissionPage }) {
	const state = () => props.page.row.state;
	return (
		<Panel testID="mission-held" tone="card" size="md" class="gap-1">
			<Text class="text-xs font-semibold text-foreground">{state() === "paused" ? "Paused" : "Pausing"}</Text>
			<Text class="text-xs text-muted-foreground">
				{state() === "paused"
					? "No new work starts in this mission until you resume it."
					: "Its work is stopping at safe points. No new work starts."}
			</Text>
		</Panel>
	);
}

/** Why Now has no task and no chat working, from what this read says. */
function nowEmpty(page: MissionPage): string {
	if (!page.tasksKnown) return "The task list is not available here yet.";
	if (page.tasks.length === 0) return "No tasks yet.";
	if (!page.tasks.some(unfinished)) return `Nothing is working. All ${page.tasks.length} tasks are done.`;
	if (unplaced(page).length > 0) return "This read does not say which tasks are working.";
	if (page.row.state === "paused") return "Nothing is working while the mission is paused.";
	return "Nothing is working now.";
}

function nextEmpty(page: MissionPage): string {
	if (!page.tasksKnown) return "";
	if (page.tasks.length > 0 && !page.tasks.some(unfinished)) return "Nothing is next.";
	return "Nothing is queued in the plan.";
}

/**
 * The focus stack: work now as large cards, the plan's next tasks below,
 * and blockers in a narrow column beside them. In a narrow window the
 * blockers wrap under the work.
 */
export function MissionWork(props: { day: Day; page: MissionPage; anchor?: ContentAnchor }) {
	const work = props.anchor?.part("work");
	const nextPart = props.anchor?.part("next");
	const id = () => props.page.row.id;
	const of = (lane: Lane) => props.page.tasks.filter((t) => laneOf(t) === lane);
	const now = () => of("now");
	const next = () => of("next");
	const blocked = () => of("blocked");
	const decision = (): Decision | undefined =>
		props.day.today().decisions.find((d) => d.id === props.page.row.decisionId);
	const paused = () => props.page.row.state === "paused" || props.page.row.state === "pausing";
	const blockers = () => blocked().length + (decision() ? 1 : 0) + (paused() ? 1 : 0);
	// Held work and questions are cards in Now; the empty column must not say nothing waits.
	const elsewhere = () => now().some((t) => stateOf(t) === "held" || stateOf(t) === "waitingForUser");
	// Chats the read shows working that no working task card stands for, including one whose task is done.
	const others = () =>
		props.page.chats.filter((c) => !now().some((t) => stateOf(t) === "working" && t.sessionId === c.id));
	const loose = () => unplaced(props.page).length;
	return (
		<View
			ref={work?.ref}
			onLayout={work?.onLayout}
			testID="mission-work"
			class="flex-row flex-wrap items-start gap-x-8 gap-y-8"
		>
			<View class="min-w-72 flex-1 gap-8">
				<View testID="mission-now" class="gap-3">
					<SectionTitle title="Now" count={now().length} />
					<If when={now().length === 0 && others().length === 0}>
						<Text class="text-sm text-muted-foreground">{nowEmpty(props.page)}</Text>
					</If>
					<Each of={limited(`${id()}/now`, now(), NOW_SHOWN)} key={(t) => t.id}>
						{(t) => <NowCard day={props.day} page={props.page} task={t()} />}
					</Each>
					<MoreRows
						listKey={`${id()}/now`}
						total={now().length}
						first={NOW_SHOWN}
						step={NOW_SHOWN}
						testID="now-limit"
					/>
					<If when={others().length > 0}>
						<View testID="mission-also-working" class="gap-1 pt-1">
							<Text class="text-xs text-muted-foreground">
								{now().length > 0 ? "Also working in this mission" : "Chats working in this mission"}
							</Text>
							<Each of={others()} key={(c) => c.id}>
								{(c) => (
									<View class="flex-row flex-wrap items-baseline gap-x-3 gap-y-1 py-1">
										<Text class="flex-1 text-sm text-foreground">{c().title}</Text>
										<Text class="text-xs text-faint">{`since ${c().since}`}</Text>
										<If when={props.day.chat}>
											<Action
												label="Open its chat"
												testID={`mission-chat-${c().id}`}
												accessibilityLabel={`Open the chat “${c().title}”, read only. Opening it sends nothing.`}
												onPress={() => openMemberChat(props.page, c().id)}
											/>
										</If>
									</View>
								)}
							</Each>
						</View>
					</If>
				</View>
				<View ref={nextPart?.ref} onLayout={nextPart?.onLayout} testID="mission-next" class="gap-1">
					<View class="pb-1">
						<SectionTitle title="Next" count={next().length} />
					</View>
					<If when={next().length === 0 && nextEmpty(props.page)}>
						<Text class="text-sm text-muted-foreground">{nextEmpty(props.page)}</Text>
					</If>
					<Each of={limited(`${id()}/next`, next(), NEXT_SHOWN)} key={(t) => t.id}>
						{(t) => <NextRow day={props.day} page={props.page} task={t()} />}
					</Each>
					<MoreRows
						listKey={`${id()}/next`}
						total={next().length}
						first={NEXT_SHOWN}
						step={25}
						testID="next-limit"
					/>
					<If when={loose() > 0}>
						<Text testID="mission-unplaced" class="pt-1 text-xs text-muted-foreground">
							{`${loose() === 1 ? "1 task has" : `${loose()} tasks have`} no work state in this read. Tasks shows their recorded status.`}
						</Text>
					</If>
				</View>
			</View>
			<View testID="mission-blockers" class="w-64 gap-2">
				<SectionTitle title="Blockers" count={blockers()} />
				<If when={blockers() === 0}>
					<Text class="text-sm text-muted-foreground">
						{!props.page.tasksKnown
							? "Blocked tasks are not known from this read."
							: elsewhere()
								? "No other blockers. Held work and questions for you are in Now."
								: loose() > 0
									? "No blocked task in this read. Some tasks have no work state."
									: "No prerequisite blockers in this read."}
					</Text>
				</If>
				<If when={paused()}>
					<Paused page={props.page} />
				</If>
				<Each of={decision() ? [decision() as Decision] : []} key={(d) => d.id}>
					{(d) => <Waiting decision={d()} />}
				</Each>
				<Each of={limited(`${id()}/blocked`, blocked(), BLOCKED_SHOWN)} key={(t) => t.id}>
					{(t) => <BlockedItem day={props.day} page={props.page} task={t()} />}
				</Each>
				<MoreRows
					listKey={`${id()}/blocked`}
					total={blocked().length}
					first={BLOCKED_SHOWN}
					step={BLOCKED_SHOWN}
					testID="blocked-limit"
				/>
			</View>
		</View>
	);
}
