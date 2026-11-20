// The mission's work, first: what is working now, what is next in the plan,
// and what is blocked. Each is a Section of the mission's panel: Now and Next
// in its main column, Blockers in its side column. Every task's work state and reason come from the
// native read (`TaskLine.workState`, `workReason`); this file keeps the
// canonical task order and says each state in words. It never decides that a
// task can run, that a chat is free or that a dependency is met. Opening a
// chat or a task's details only reads.
import { effect, type JSX, signal, untracked, View, type ViewRef } from "nsh";
import type { Decision, MissionPage, TaskLine, TaskPrerequisite } from "pilot-day/native";
import { openChat } from "./chatView";
import { type ContentAnchor, yieldAnchor } from "./contentAnchor";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { restoreScroll, scrollOf } from "./kept";
import { goHome, goSettings } from "./nav";
import { OpenChatAction } from "./OpenChatAction";
import {
	Block,
	Body,
	Button,
	Caption,
	Disclosure,
	EmptyLine,
	glide,
	Link,
	type MarkKind,
	Num,
	Row,
	RowDetail,
	RowGroup,
	Rows,
	Section,
} from "./ui";
import { focused, focusFront, todayPlace } from "./view";
import { nextLine, provenance, stateOf, taskWord, type WorkState, workWord } from "./words";

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
			<Block testID={props.testID}>
				<View class="flex-row flex-wrap items-center gap-x-3 gap-y-1">
					<Caption>{`Showing ${n()} of ${props.total}.`}</Caption>
					<Link
						label={`Show ${more()} more`}
						testID={`${props.testID}-more`}
						onPress={() => shownCount.update((all) => ({ ...all, [props.listKey]: n() + more() }))}
					/>
				</View>
			</Block>
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

/**
 * A task's state mark, from the library's seven states: Working while an agent has it, Needs you while it waits
 * for an answer, Paused while held, Done once completed, and the quiet New mark while it waits in the plan or for
 * other work. A work state this read does not know shows no mark; its words say so.
 */
export function taskMark(state: WorkState): MarkKind | undefined {
	switch (state) {
		case "working":
		case "review":
			return "working";
		case "waitingForUser":
			return "needs";
		case "held":
			return "paused";
		case "completed":
			return "done";
		case "unknown":
			return undefined;
		default:
			return "new";
	}
}

/** A state word's tone in a task row: amber only while it waits for the user. */
function taskTone(state: WorkState): "needs" | "quiet" {
	return state === "waitingForUser" ? "needs" : "quiet";
}

/** The host's reasons, one line each. */
function Reasons(props: { task: TaskLine; quiet?: boolean }) {
	const lines = () =>
		(props.task.workReason ?? "")
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l);
	return (
		<Each of={lines()} key="index">
			{(line) => <Body tone={props.quiet ? "muted" : "default"}>{line()}</Body>}
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
				<Caption>Waits for</Caption>
				<Each of={props.task.prerequisites ?? []} key={(p) => p.id}>
					{(p) => <Caption tone="default">{line(p())}</Caption>}
				</Each>
			</View>
		</If>
	);
}

/** The chat that owns the task, read only. */
function ChatLink(props: { day: Day; page: MissionPage; task: TaskLine; lane: Lane }) {
	return (
		<If when={props.task.sessionId && props.day.chat}>
			<OpenChatAction
				label="Open agent chat"
				testID={`${props.lane}-chat-${props.task.id}`}
				accessibilityLabel={`Open agent chat for #${props.task.number} ${props.task.title}, read only. Opening it sends nothing.`}
				onPress={() => openMemberChat(props.page, props.task.sessionId ?? "")}
			/>
		</If>
	);
}

/**
 * The task's model and why, such as "UI · large · Sol · preferred". Day has no per-task model choice, so Change
 * opens Settings at Models, scrolled to the task's work profile with the keyboard focus on it.
 */
function TaskModel(props: { task: TaskLine; lane: Lane }) {
	return (
		<If when={props.task.modelLine ?? ""}>
			<View class="flex-row flex-wrap items-center gap-x-2">
				<Caption testID={`${props.lane}-model-${props.task.id}`} tone="faint">
					{props.task.modelLine ?? ""}
				</Caption>
				<Link
					label="Change"
					testID={`${props.lane}-model-change-${props.task.id}`}
					onPress={() =>
						goSettings({
							section: "models",
							...(props.task.modelProfile ? { profile: props.task.modelProfile } : {}),
						})
					}
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
			<View selectable>
				<Body tone="muted">{(props.task.body ?? "") || "No details are recorded for this task."}</Body>
			</View>
		</Disclosure>
	);
}

/** A task with work on it now: what it is, where it stands, who has it and its chat, with its reasons under it. */
function NowRow(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const target = laneFocus(props.task.id, "now");
	return (
		<Row
			testID={`now-${t().id}`}
			mark={taskMark(stateOf(t()))}
			title={t().title}
			meta={`#${t().number}`}
			state={workWord(stateOf(t()))}
			stateTone={taskTone(stateOf(t()))}
			trailing={<ChatLink day={props.day} page={props.page} task={t()} lane="now" />}
			detail={
				<RowDetail>
					<View selectable class="gap-1">
						<Reasons task={t()} />
						<If when={t().report}>
							<Body tone="muted">{t().report?.summary ?? ""}</Body>
							<If when={t().report?.movement === "notMoving" && t().report?.nextStep}>
								<Body tone="muted">
									{t().report ? nextLine(t().report as NonNullable<TaskLine["report"]>) : ""}
								</Body>
							</If>
							<Caption tone="faint">
								{t().report
									? `${provenance(t().report as NonNullable<TaskLine["report"]>)} · agent words, not verified`
									: ""}
							</Caption>
						</If>
						<If when={t().ownerTitle ?? ""}>
							<Caption>{`Owner: ${t().ownerTitle ?? ""}`}</Caption>
						</If>
						<Prerequisites task={t()} />
					</View>
					<TaskModel task={t()} lane="now" />
					<Details task={t()} lane="now" target={target} />
				</RowDetail>
			}
		/>
	);
}

/** One task later in the plan. It opens in place with its reasons, owner, prerequisites and body. */
function NextRow(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const open = () => !!openWork()[t().id];
	const target = laneFocus(props.task.id, "next");
	return (
		<Row
			testID={`next-${t().id}`}
			mark={taskMark(stateOf(t()))}
			title={t().title}
			meta={`#${t().number}`}
			state={workWord(stateOf(t()))}
			open={open()}
			accessibilityLabel={`#${t().number} ${t().title}, ${workWord(stateOf(t()))}. ${open() ? "Hide" : "Show"} its details.`}
			anchor={target.anchor}
			onFocus={target.onFocus}
			onBlur={target.onBlur}
			onToggle={() => toggleWork(t().id, target)}
			aside={<ChatLink day={props.day} page={props.page} task={t()} lane="next" />}
			detail={
				<If when={t().modelLine ?? ""}>
					<RowDetail>
						<TaskModel task={t()} lane="next" />
					</RowDetail>
				</If>
			}
			content={
				<View selectable class="gap-1.5">
					<Reasons task={t()} quiet />
					<If when={t().ownerTitle ?? ""}>
						<Caption>{`Owner: ${t().ownerTitle ?? ""}`}</Caption>
					</If>
					<Prerequisites task={t()} />
					<Body tone="muted">{(t().body ?? "") || "No details are recorded for this task."}</Body>
				</View>
			}
		/>
	);
}

/** One blocked task in the narrow column: why it cannot move, and what it waits for. */
function BlockedRow(props: { day: Day; page: MissionPage; task: TaskLine }) {
	const t = () => props.task;
	const target = laneFocus(props.task.id, "blocked");
	return (
		<Row
			testID={`blocked-${t().id}`}
			mark={taskMark(stateOf(t()))}
			title={t().title}
			meta={`#${t().number}`}
			state={workWord(stateOf(t()))}
			trailing={<ChatLink day={props.day} page={props.page} task={t()} lane="blocked" />}
			detail={
				<RowDetail>
					<View selectable class="gap-1">
						<Reasons task={t()} quiet />
						<Prerequisites task={t()} />
					</View>
					<Details task={t()} lane="blocked" target={target} />
				</RowDetail>
			}
		/>
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
		<Row
			testID="mission-waiting"
			mark={decisionMark(d())}
			title={d().title}
			state="Waiting for you"
			stateTone="needs"
			wrap
			detail={
				<RowDetail>
					<Button
						small
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
				</RowDetail>
			}
		/>
	);
}

/**
 * The mission's own Pause. It holds new work; a chat the read still shows
 * working is in Now with its reasons. Resume stays in the control section.
 */
function Paused(props: { page: MissionPage }) {
	const state = () => props.page.row.state;
	return (
		<Row
			testID="mission-held"
			mark="paused"
			title={state() === "paused" ? "Paused" : "Pausing"}
			meta={
				state() === "paused"
					? "No new work starts in this mission until you resume it."
					: "Its work is stopping at safe points. No new work starts."
			}
			wrap
		/>
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

const of = (page: MissionPage, lane: Lane) => page.tasks.filter((t) => laneOf(t) === lane);

/**
 * Now: the tasks with work on them, then the chats working in the mission that no task row stands for. The
 * content anchor's "work" part is this section.
 */
export function MissionNow(props: { day: Day; page: MissionPage; anchor?: ContentAnchor }) {
	const work = props.anchor?.part("work");
	const id = () => props.page.row.id;
	const now = () => of(props.page, "now");
	// Chats the read shows working that no working task row stands for, including one whose task is done.
	const others = () =>
		props.page.chats.filter((c) => !now().some((t) => stateOf(t) === "working" && t.sessionId === c.id));
	return (
		<View ref={work?.ref} onLayout={work?.onLayout}>
			<Section testID="mission-now" title="Now" count={now().length}>
				<If when={now().length === 0 && others().length === 0}>
					<EmptyLine text={nowEmpty(props.page)} />
				</If>
				<Rows>
					<Each of={limited(`${id()}/now`, now(), NOW_SHOWN)} key={(t) => t.id}>
						{(t) => <NowRow day={props.day} page={props.page} task={t()} />}
					</Each>
				</Rows>
				<MoreRows
					listKey={`${id()}/now`}
					total={now().length}
					first={NOW_SHOWN}
					step={NOW_SHOWN}
					testID="now-limit"
				/>
				<If when={others().length > 0}>
					<View testID="mission-also-working">
						<RowGroup
							label={now().length > 0 ? "Also working in this mission" : "Chats working in this mission"}
						/>
						<Rows>
							<Each of={others()} key={(c) => c.id}>
								{(c) => (
									<Row
										mark="working"
										title={c().title}
										trailing={
											<>
												<Num>{`since ${c().since}`}</Num>
												<If when={props.day.chat}>
													<OpenChatAction
														testID={`mission-chat-${c().id}`}
														accessibilityLabel={`Open the chat “${c().title}”, read only. Opening it sends nothing.`}
														onPress={() => openMemberChat(props.page, c().id)}
													/>
												</If>
											</>
										}
									/>
								)}
							</Each>
						</Rows>
					</View>
				</If>
			</Section>
		</View>
	);
}

/** Next: the plan's next tasks, each opening in place. `lead` shows first, such as the task ready to start. */
export function MissionNext(props: { day: Day; page: MissionPage; anchor?: ContentAnchor; lead?: JSX.Element }) {
	const nextPart = props.anchor?.part("next");
	const id = () => props.page.row.id;
	const next = () => of(props.page, "next");
	const loose = () => unplaced(props.page).length;
	return (
		<View ref={nextPart?.ref} onLayout={nextPart?.onLayout}>
			<Section testID="mission-next" title="Next" count={next().length}>
				{props.lead}
				<If when={next().length === 0 && nextEmpty(props.page)}>
					<EmptyLine text={nextEmpty(props.page)} />
				</If>
				<Rows>
					<Each of={limited(`${id()}/next`, next(), NEXT_SHOWN)} key={(t) => t.id}>
						{(t) => <NextRow day={props.day} page={props.page} task={t()} />}
					</Each>
				</Rows>
				<MoreRows listKey={`${id()}/next`} total={next().length} first={NEXT_SHOWN} step={25} testID="next-limit" />
				<If when={loose() > 0}>
					<EmptyLine
						testID="mission-unplaced"
						text={`${loose() === 1 ? "1 task has" : `${loose()} tasks have`} no work state in this read. Tasks shows their recorded status.`}
					/>
				</If>
			</Section>
		</View>
	);
}

/** Blockers: the mission's pause, its decision for the user and the blocked tasks, in the side column. */
export function MissionBlockers(props: { day: Day; page: MissionPage }) {
	const id = () => props.page.row.id;
	const now = () => of(props.page, "now");
	const blocked = () => of(props.page, "blocked");
	const decision = (): Decision | undefined =>
		props.day.today().decisions.find((d) => d.id === props.page.row.decisionId);
	const paused = () => props.page.row.state === "paused" || props.page.row.state === "pausing";
	const blockers = () => blocked().length + (decision() ? 1 : 0) + (paused() ? 1 : 0);
	// Held work and questions are rows in Now; the empty section must not say nothing waits.
	const elsewhere = () => now().some((t) => stateOf(t) === "held" || stateOf(t) === "waitingForUser");
	const loose = () => unplaced(props.page).length;
	return (
		<Section testID="mission-blockers" title="Blockers" count={blockers()}>
			<If when={blockers() === 0}>
				<EmptyLine
					text={
						!props.page.tasksKnown
							? "Blocked tasks are not known from this read."
							: elsewhere()
								? "No other blockers. Held work and questions for you are in Now."
								: loose() > 0
									? "No blocked task in this read. Some tasks have no work state."
									: "No prerequisite blockers in this read."
					}
				/>
			</If>
			<Rows>
				<If when={paused()}>
					<Paused page={props.page} />
				</If>
				<Each of={decision() ? [decision() as Decision] : []} key={(d) => d.id}>
					{(d) => <Waiting decision={d()} />}
				</Each>
				<Each of={limited(`${id()}/blocked`, blocked(), BLOCKED_SHOWN)} key={(t) => t.id}>
					{(t) => <BlockedRow day={props.day} page={props.page} task={t()} />}
				</Each>
			</Rows>
			<MoreRows
				listKey={`${id()}/blocked`}
				total={blocked().length}
				first={BLOCKED_SHOWN}
				step={BLOCKED_SHOWN}
				testID="blocked-limit"
			/>
		</Section>
	);
}
