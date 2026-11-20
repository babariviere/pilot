// Today's project scope on screen: the one control at the top of Today, the
// line that says what Today shows and what needs the user elsewhere, and
// other projects' rows. The project the window acts on keeps its own
// actionable sections; another project's rows say what is there, and its
// missions and plans open. Choosing a scope or opening a row only reads:
// nothing starts or is sent. What Pilot could not read stays unknown.
import { effect, lifecycle, untracked, View } from "nsh";
import type { Decision, HumanAction, MissionRow, Planning } from "pilot-day/native";
import { openChat } from "./chatView";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { openDelivery, waitsForCheck } from "./deliveryView";
import { openRequestIn } from "./Incoming";
import { jump } from "./nav";
import { stageMark, stageWord } from "./PlanScreen";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { scopedQuestion } from "./ScopedQuestion";
import { type ScopeCount, type ScopeProject, todayProject } from "./todayScope";
import { Block, Button, Caption, EmptyLine, Link, Notice, Picker, Progress, Row, RowGroup, Rows } from "./ui";
import { drafts, openMission, picks, placeRow, replies, reports } from "./view";
import { rowLine, stateMark, stateTone, stateWord } from "./words";
import { destinationProject } from "./workSearch";

const WORDS = ["No", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine"];

/** Today's scope for one window: what it shows, and what it does not. */
export type TodayScope = {
	/** Whether this window offers a scope at all (it has a scope read and its projects). */
	on: () => boolean;
	/** "all", or one project's ID. */
	scope: () => string;
	/** The project this window acts on, when Pilot named it. */
	own: () => string | null;
	/** A project's name, or "a project". */
	name: (id: string) => string;
	/** Whether the window's own, actionable sections show. */
	showsOwn: () => boolean;
	/** Other projects in the scope, read. Empty while unread or unavailable. */
	others: () => ScopeProject[];
	/** The chosen project's row in the scope read, when one project is chosen. */
	chosen: () => ScopeProject | null;
	/** The window moves to the chosen project, and its own read of it is on its way. */
	arriving: () => boolean;
	/** Whether rows name their project: All projects with other projects shown. */
	tagged: () => boolean;
	/** Every project the user can choose, by ID and name: the scope read's list, else New's. */
	projects: () => { id: string; name: string }[];
	/** Why this window offers no scope although it has a scope read, or "". */
	offReason: () => string;
};

/** Today's scope over `day`'s scope read and `plans`' project list. */
export function todayScope(day: Day, plans?: Plans): TodayScope {
	const chats = () => plans?.chats.view();
	// Which project is this window's own comes from the project list. Reading it is passive.
	if (day.scope && plans && untracked(() => plans.chats.view().availability) === "reading") {
		void plans.chats.source.read();
	}
	// A profile-only window has no own-project rows. Its catalog still scopes Today.
	const on = () => !!day.scope;
	const scope = () => (on() ? todayProject() : "all");
	const snapshot = () => {
		const s = day.scope?.view().snapshot;
		return s && s.scope === scope() ? s : null;
	};
	// The project Today's own read is of. Empty when the read names none (mock worlds, test roots).
	const desk = () => day.today().project ?? "";
	// The project the window acts on: the one Today's own read is of. Else the
	// native root names it in the read of this scope; else the project list.
	// A scope read can be an earlier one kept for this scope, so its `own`
	// may be older than Today's own read.
	const own = () => (desk() || null) ?? snapshot()?.own ?? chats()?.current ?? null;
	// Today's own read shows only under its own project: right after a switch,
	// it may still hold the previous project's rows. A read naming none is trusted.
	const deskIs = (id: string) => desk() === "" || desk() === id;
	// ... and only once it holds a read of that project, not the empty one a switch starts with.
	const deskReady = (id: string) => deskIs(id) && day.today().freshness.state !== "unreadable";
	const name = (id: string) =>
		snapshot()?.projects.find((p) => p.id === id)?.name ??
		chats()?.projects.find((p) => p.projectId === id)?.name ??
		"a project";
	const showsOwn = () => {
		if (!on()) return true;
		const id = own();
		return id !== null && (scope() === "all" || scope() === id) && deskReady(id);
	};
	// The window is moving to the chosen project: the root names it as the one
	// the window acts on, but Today's own read of it has not landed yet.
	const arriving = () =>
		on() && scope() !== "all" && !showsOwn() && (snapshot()?.own === scope() || desk() === scope());
	// Under All projects: every selected project but the window's own sections.
	// Under one project: none while the window moves there (its own read
	// follows), else that project read only, for a window that acts on another.
	const others = () => {
		if (scope() !== "all" && arriving()) return [];
		const shown = showsOwn() ? own() : null;
		return (snapshot()?.projects ?? []).filter((p) => p.selected && p.id !== shown);
	};
	const projects = () => {
		const read = day.scope?.catalog() ?? [];
		if (read.length > 0) return read;
		return (chats()?.projects ?? []).map((p) => ({ id: p.projectId, name: p.name }));
	};
	return {
		on,
		scope,
		own,
		name,
		showsOwn,
		others,
		arriving,
		chosen: () => (scope() === "all" ? null : (snapshot()?.projects.find((p) => p.id === scope()) ?? null)),
		tagged: () => scope() === "all" && others().length > 0,
		projects,
		offReason: () => {
			const c = chats();
			if (day.scope || !c || c.availability !== "unavailable") return "";
			return `Showing this window's project only. ${c.reason}`;
		},
	};
}

/**
 * Reads the scope again when it changes and when the window comes back.
 * Passive: reading sends nothing.
 */
export function bindScopeReads(day: Day, ctx: TodayScope) {
	let was = untracked(lifecycle);
	effect(() => {
		const scope = ctx.scope();
		const now = lifecycle();
		const back = now === "active" && was !== "active";
		was = now;
		if (!ctx.on()) return;
		untracked(() => {
			if (back || day.scope?.view().snapshot?.scope !== scope) void day.scope?.read(scope);
		});
	});
}

/** The one scope control: All projects or one project. Choosing only reads. */
export function ScopeControl(props: { ctx: TodayScope }) {
	const projects = () => props.ctx.projects();
	const items = () => [
		{ value: "all", title: "All projects" },
		...projects().map((p) => ({ value: p.id, title: p.name })),
	];
	const detail = (id: string) => {
		if (id === "all") return "Every row names its project";
		return id === props.ctx.own() ? "This window's project" : "";
	};
	return (
		<If when={props.ctx.on()}>
			<Picker
				testID="today-scope"
				label="Projects Today shows"
				items={items()}
				// A remembered project Pilot no longer lists still shows as chosen, by name.
				value={items().some((i) => i.value === props.ctx.scope()) ? props.ctx.scope() : null}
				placeholder={props.ctx.name(props.ctx.scope())}
				detail={detail}
				searchable={projects().length > 8}
				searchPlaceholder="Find a project"
				onChange={(id) => todayProject.set(id)}
			/>
		</If>
	);
}

function needsWords(n: number, where: string): string {
	return `${WORDS[n] ?? String(n)} ${n === 1 ? "thing needs" : "things need"} you ${where}.`;
}

/** What needs the user outside the scope, honestly: a count, none, or unknown. */
function elsewhereLine(c: ScopeCount | null): string {
	if (!c || c.count === null) return "Pilot could not count what needs you in other projects.";
	if (c.count === 0)
		return c.complete
			? "Nothing needs you in other projects."
			: "Pilot could not count everything that needs you in other projects.";
	const line = needsWords(c.count, "in other projects");
	return c.complete ? line : `At least ${line.charAt(0).toLowerCase()}${line.slice(1)}`;
}

/** The lines under Today's summary: what Today shows, and what needs the user elsewhere. */
export function ScopeNote(props: { day: Day; ctx: TodayScope }) {
	const view = () => props.day.scope?.view();
	const snapshot = () => {
		const s = view()?.snapshot;
		return s && s.scope === props.ctx.scope() ? s : null;
	};
	const ownName = () => props.ctx.name(props.ctx.own() ?? "");
	const all = () => props.ctx.scope() === "all";
	const unreadable = () => (snapshot()?.projects ?? []).filter((p) => p.selected && p.currentness === "unavailable");
	// This window's unsent words stay on their items while another project shows: counted, never moved.
	const kept = () => {
		if (props.ctx.showsOwn()) return 0;
		const typed = new Set([
			...Object.keys(picks()),
			...Object.keys(drafts()),
			...Object.keys(replies()),
			...Object.keys(reports()),
		]);
		const t = props.day.today();
		return [...t.decisions, ...t.actions].filter((item) => typed.has(item.id)).length;
	};
	const shows = () => {
		const v = view();
		if (all()) {
			if (!v || v.state === "reading") return "Reading your projects…";
			if (!snapshot()) return props.ctx.own() ? `Showing ${ownName()} only. ${v.reason}` : v.reason;
			if (snapshot()?.catalogComplete && snapshot()?.projects.length === 0) return "No accessible projects.";
			const missing = unreadable().map((p) => p.name);
			if (missing.length > 0) return `Across your projects. Pilot could not read ${missing.join(", ")}.`;
			return "Across all your projects. Each section names its project.";
		}
		const name = props.ctx.name(props.ctx.scope());
		if (props.ctx.showsOwn()) return `Showing ${name}.`;
		if (!v || v.state === "reading") return `Reading ${name}…`;
		if (!snapshot()) return `Pilot cannot show ${name} here. ${v.reason}`;
		if (!props.ctx.arriving()) return `Showing ${name}.`;
		// The window moves to the chosen project; its own read is on its way.
		return props.day.freshness?.warn() ? `Pilot could not read ${name} yet. It keeps trying.` : `Reading ${name}…`;
	};
	const elsewhere = () => {
		if (all()) return "";
		const v = view();
		// The first read of a switch counts nothing elsewhere yet: the complete read follows.
		if (!v || v.state === "reading" || snapshot()?.partial) return "";
		const line = snapshot()
			? elsewhereLine(snapshot()?.outsideNeedsYou ?? null)
			: "Pilot cannot count what needs you in other projects here yet.";
		const n = kept();
		if (n === 0) return line;
		return `${line} Your unsent words on ${n === 1 ? "one item" : `${WORDS[n] ?? n} items`} in ${ownName()} are kept.`;
	};
	return (
		<If
			when={props.ctx.on()}
			else={
				<If when={props.ctx.offReason()}>
					<Caption testID="scope-note">{props.ctx.offReason()}</Caption>
				</If>
			}
		>
			<View testID="scope-note" class="gap-1">
				<Caption>{shows()}</Caption>
				<If when={elsewhere()}>
					<Notice
						kind={snapshot()?.outsideNeedsYou.count ? "needs" : snapshot() ? "done" : "unconfirmed"}
						text={elsewhere()}
						testID="scope-elsewhere"
						action={<Link label="Show all projects" testID="scope-all" onPress={() => todayProject.set("all")} />}
					/>
				</If>
				<If when={view()?.state === "unavailable" || (snapshot() && view()?.reason)}>
					<Link
						label="Read again"
						testID="scope-read"
						onPress={() => void props.day.scope?.read(props.ctx.scope())}
					/>
				</If>
			</View>
		</If>
	);
}

/** A project's name above its rows, so every row says where it belongs. */
export function ProjectLabel(props: { name: string; own?: boolean; stale?: boolean }) {
	const words = () =>
		props.own ? `${props.name} · this window` : `${props.name}${props.stale ? " · earlier read" : ""}`;
	return <RowGroup label={words()} />;
}

/** Which read errors cover each part of another project's Today. */
const SOURCES: Record<string, string[]> = {
	needsYou: ["attention", "today"],
	missions: ["today"],
};

/** Whether a part of another project was read in full, so an empty list means none. */
function complete(project: ScopeProject, section: string): boolean {
	return (
		!!project.today &&
		project.currentness !== "unavailable" &&
		!(SOURCES[section] ?? []).some((key) => project.errors[key])
	);
}

/** Why one project's part could not be read, or nothing. */
function Unread(props: { project: ScopeProject; section: string }) {
	const reason = () => {
		if (complete(props.project, props.section)) return "";
		const keys = SOURCES[props.section] ?? [];
		const found = keys.map((key) => props.project.errors[key]).find(Boolean);
		return found || "Pilot could not read all of it. What shows may be missing items.";
	};
	return (
		<If when={reason()}>
			<Notice placement="section" text={`${props.project.name}: ${reason()}`} />
		</If>
	);
}

type Need = { id: string; title: string; effort: string; why: string; decision: Decision | null };

function needsOf(p: ScopeProject): Need[] {
	const t = p.today;
	if (!t) return [];
	return [
		...t.decisions.map((d) => ({ id: d.id, title: d.title, effort: d.effort, why: d.reason, decision: d })),
		...t.actions.map((a: HumanAction) => ({
			id: a.id,
			title: a.title,
			effort: a.effort,
			why: a.why,
			decision: null,
		})),
	];
}

/** Another project's new Slack requests. Its Linear requests wait on its Linear page. */
function requestsOf(p: ScopeProject) {
	return (p.today?.intake.requests ?? []).filter((r) => r.source !== "linear");
}

/** Why another project's requests could not all be read, one line each. */
function requestTrouble(p: ScopeProject): string[] {
	return [p.errors.intake ?? "", ...(p.today?.intake.trouble ?? [])].filter(Boolean);
}

/** How many things other projects in the scope need the user for, when read: Slack requests count too. */
export function otherNeedsCount(ctx: TodayScope): number {
	return ctx.others().reduce((n, p) => n + needsOf(p).length + requestsOf(p).length, 0);
}

/** Other projects' attention. Opening the exact item does not switch the Today filter. */
export function OtherNeeds(props: { ctx: TodayScope; day: Day }) {
	return (
		<Each of={props.ctx.others()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-needs-${p().id}`}>
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Unread project={p()} section="needsYou" />
					<Rows>
						<Each of={needsOf(p())} key={(n) => n.id}>
							{(n) => (
								<Row
									mark={n().decision ? decisionMark(n().decision as Decision) : "needs"}
									title={n().title}
									meta={[n().why, n().effort].filter(Boolean).join(" · ")}
									trailing={
										<>
											<If when={props.day.chat && n().decision?.requestSessionId}>
												<Button
													small
													label="Open chat"
													onPress={() => {
														const id = n().decision?.requestSessionId;
														if (!id) return;
														destinationProject.set(p().name);
														openChat(id, "Today");
													}}
												/>
											</If>
											<If
												when={
													props.day.search &&
													(n().decision?.reply || !!n().decision?.interviewRoundId) &&
													n().id.startsWith("question-")
												}
											>
												<Button
													small
													label={n().decision?.interviewRoundId ? "Open interview" : "Answer"}
													accessibilityLabel={`Answer ${n().title} in ${p().name}`}
													onPress={() =>
														scopedQuestion.set({
															projectId: p().id,
															projectName: p().name,
															decisionId: n().id,
															interviewRoundId: n().decision?.interviewRoundId ?? undefined,
														})
													}
												/>
											</If>
										</>
									}
								/>
							)}
						</Each>
					</Rows>
					<Each of={requestTrouble(p())} key={(t) => t}>
						{(t) => <Notice placement="section" text={`${p().name}: ${t()}`} />}
					</Each>
					<Rows>
						<Each of={requestsOf(p())} key={(r) => r.id}>
							{(r) => (
								<Row
									testID={`scope-request-${r().id}`}
									mark="new"
									title={r().title}
									meta={[`${r().sourceLabel} request`, r().place, r().age].filter(Boolean).join(" · ")}
									trailing={
										<Button
											small
											label="Open"
											accessibilityLabel={`${r().title} in ${p().name}. Open it to start work, put it off or discard it.`}
											onPress={() => {
												openRequestIn(p().id, r().id);
												todayProject.set(p().id);
											}}
										/>
									}
								/>
							)}
						</Each>
					</Rows>
				</View>
			)}
		</Each>
	);
}

function missionsOf(p: ScopeProject): MissionRow[] {
	const t = p.today;
	return t ? [...t.moving, ...t.notMoving, ...t.unreported] : [];
}

/** How many missions other projects in the scope have, when read. */
export function otherMissionsCount(ctx: TodayScope): number {
	return ctx.others().reduce((n, p) => n + missionsOf(p).length, 0);
}

/** Other projects' missions: state and one line. Pressing one opens the mission. */
export function OtherMissions(props: { ctx: TodayScope; day: Day }) {
	return (
		<Each of={props.ctx.others()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-missions-${p().id}`}>
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Unread project={p()} section="missions" />
					<If when={complete(p(), "missions") && missionsOf(p()).length === 0}>
						<EmptyLine text="No active missions." />
					</If>
					<Rows>
						<Each of={missionsOf(p())} key={(m) => m.id}>
							{(m) => {
								const id = m().id;
								// The same place as the window's own row: back on Today, the row takes the focus again.
								const place = placeRow(`mission-${id}`, () =>
									jump({ day: props.day }, () => {
										openMission(id);
										destinationProject.set(p().name);
									}),
								);
								return (
									<Row
										testID={`scope-mission-${id}`}
										mark={stateMark(m())}
										title={m().title}
										meta={rowLine(m())}
										state={stateWord(m())}
										stateTone={stateTone(m())}
										trailing={<Progress counts={m().progress} />}
										accessibilityLabel={`${m().title} in ${p().name}, ${stateWord(m())}. Open the mission.`}
										anchor={place.anchor}
										onPress={place.press}
									/>
								);
							}}
						</Each>
					</Rows>
				</View>
			)}
		</Each>
	);
}

function plansOf(p: ScopeProject): Planning["plans"] {
	return p.planning?.plans ?? [];
}

/** Other projects' missions in planning. Pressing one opens its planning. Unread planning is not shown as none. */
export function OtherPlanning(props: { ctx: TodayScope }) {
	const shown = () => props.ctx.others().filter((p) => plansOf(p).length > 0 || p.errors.planning);
	return (
		<Each of={shown()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-planning-${p().id}`}>
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<If when={p().errors.planning}>
						<Notice placement="section" text={`${p().name}: ${p().errors.planning ?? ""}`} />
					</If>
					<Rows>
						<Each of={plansOf(p())} key={(row) => row.missionId}>
							{(row) => {
								const id = row().missionId;
								const place = placeRow(`plan-${id}`, () => openPlan(id));
								return (
									<Row
										testID={`scope-plan-${id}`}
										mark={stageMark(row().stage)}
										title={row().title}
										state={stageWord(row().stage)}
										stateTone={row().needsYou ? "needs" : "quiet"}
										accessibilityLabel={`${row().title} in ${p().name}, ${stageWord(row().stage)}. Open its planning.`}
										anchor={place.anchor}
										onPress={place.press}
									/>
								);
							}}
						</Each>
					</Rows>
				</View>
			)}
		</Each>
	);
}

/** Other projects' delivered results. Reading does not retarget this window or grant actions. */
export function OtherToCheck(props: { ctx: TodayScope; day: Day; nested?: boolean }) {
	const rows = (p: ScopeProject) =>
		p.results?.items.filter(
			(i) => i.unsettled || i.snapshot?.pendingOperationId || waitsForCheck(i.snapshot, undefined),
		) ?? [];
	const shown = () => props.ctx.others().filter((p) => rows(p).length > 0 || !p.results?.complete);
	return (
		<If when={shown().length > 0}>
			<View testID="scope-to-check">
				<RowGroup label={props.nested && props.ctx.scope() === "all" ? "To check in other projects" : "To check"} />
				<Each of={shown()} key={(p) => p.id}>
					{(p) => (
						<View>
							<ProjectLabel name={p().name} stale={p().currentness !== "live"} />
							<Rows>
								<Each of={rows(p())} key={(i) => i.snapshot?.targetId ?? JSON.stringify(i.subject)}>
									{(i) => (
										<Row
											mark={i().unsettled || i().snapshot?.pendingOperationId ? "unconfirmed" : "needs"}
											title={i().title}
											state={
												i().unsettled || i().snapshot?.pendingOperationId
													? "Check not confirmed"
													: "To check"
											}
											stateTone="needs"
											trailing={
												<If when={props.day.delivery}>
													<Button
														small
														label="Review result"
														accessibilityLabel={`Review ${i().title} in ${p().name}`}
														onPress={() => {
															destinationProject.set(p().name);
															openDelivery(i().subject, i().title);
														}}
													/>
												</If>
											}
										/>
									)}
								</Each>
							</Rows>
							<If when={!p().results?.complete}>
								<EmptyLine
									text={
										p().results?.reason ||
										"Delivered results could not all be read. This is not an empty list."
									}
								/>
							</If>
							<If when={!props.day.delivery && rows(p()).length > 0}>
								<EmptyLine
									text={
										props.ctx.scope() === "all"
											? "Choose this project above to check its results here."
											: "This window acts on another project, so it cannot check these here."
									}
								/>
							</If>
						</View>
					)}
				</Each>
			</View>
		</If>
	);
}

/** Sections other projects have that Today cannot show yet, said once. */
export function OtherNotShown(props: { ctx: TodayScope }) {
	return (
		<If when={props.ctx.others().length > 0}>
			<Block>
				<Caption testID="scope-not-shown" tone="faint">
					{props.ctx.showsOwn()
						? "Coming up from other projects is not shown here yet."
						: "Coming up for this project is not shown here yet."}
				</Caption>
			</Block>
		</If>
	);
}

/** Today's headline when it shows another project, from that project's read. */
export function scopedHeadline(ctx: TodayScope): string {
	if (ctx.scope() === "all") {
		const projects = ctx.others();
		if (projects.length === 0) return "Your projects.";
		if (projects.some((p) => p.needsYou.count === null || !complete(p, "needsYou")))
			return "What needs you is not fully known.";
		const n = projects.reduce((sum, p) => sum + (p.needsYou.count ?? 0), 0);
		return n === 0 ? "Nothing needs you." : needsWords(n, "across your projects");
	}
	const p = ctx.chosen();
	if (!p) return `${ctx.name(ctx.scope())} is not shown.`;
	if (!p.today) return `${p.name} could not be read.`;
	const n = p.needsYou.count;
	if (n === null || !complete(p, "needsYou")) return `What needs you in ${p.name} is not fully known.`;
	return n === 0 ? `Nothing needs you in ${p.name}.` : needsWords(n, `in ${p.name}`);
}
