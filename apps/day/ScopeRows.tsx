// Today's project scope on screen: the one control at the top of Today, the
// line that says what Today shows and what needs the user elsewhere, and
// other projects' rows. The project the window acts on keeps its own
// actionable sections; another project's rows say what is there, and its
// missions and plans open. Choosing a scope or opening a row only reads:
// nothing starts or is sent. What Pilot could not read stays unknown.
import { effect, lifecycle, Text, untracked, View } from "nsh";
import type { Decision, HumanAction, MissionRow, Planning } from "pilot-day/native";
import { decisionMark } from "./DecisionCard";
import type { Day } from "./day";
import { waitsForCheck } from "./deliveryView";
import { stageMark, stageWord } from "./PlanScreen";
import type { Plans } from "./planning";
import { openPlan } from "./planView";
import { type ScopeCount, type ScopeProject, todayProject } from "./todayScope";
import { InlineAction, Mark, Picker, RowLink, SectionTitle } from "./ui";
import { drafts, openMission, picks, placeRow, replies, reports } from "./view";
import { rowLine, stateMark, stateWord } from "./words";

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
	// The native root names the project the window acts on in its scope read; else the project list does.
	const own = () => day.scope?.view().snapshot?.own ?? chats()?.current ?? null;
	// A profile-only window has no own-project rows. Its catalog still scopes Today.
	const on = () => !!day.scope;
	const scope = () => (on() ? todayProject() : "all");
	const snapshot = () => {
		const s = day.scope?.view().snapshot;
		return s && s.scope === scope() ? s : null;
	};
	const name = (id: string) =>
		snapshot()?.projects.find((p) => p.id === id)?.name ??
		chats()?.projects.find((p) => p.projectId === id)?.name ??
		"a project";
	const showsOwn = () => !on() || (own() !== null && (scope() === "all" || scope() === own()));
	const others = () => (snapshot()?.projects ?? []).filter((p) => p.selected && p.id !== own());
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

/** The line under Today's summary: what Today shows, and what needs the user elsewhere. */
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
		return `Showing ${name}.`;
	};
	const elsewhere = () => {
		if (all()) return "";
		const v = view();
		if (!v || v.state === "reading") return "";
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
					<Text testID="scope-note" class="text-xs text-muted-foreground">
						{props.ctx.offReason()}
					</Text>
				</If>
			}
		>
			<View testID="scope-note" class="gap-1">
				<Text class="text-xs text-muted-foreground">{shows()}</Text>
				<If when={elsewhere()}>
					<View class="flex-row flex-wrap items-center gap-x-2 gap-y-1">
						<Mark kind={snapshot()?.outsideNeedsYou.count ? "needs" : snapshot() ? "done" : "unknown"} />
						<Text testID="scope-elsewhere" class="text-xs text-muted-foreground">
							{elsewhere()}
						</Text>
						<InlineAction label="Show all projects" testID="scope-all" onPress={() => todayProject.set("all")} />
					</View>
				</If>
				<If when={view()?.state === "unavailable" || (snapshot() && view()?.reason)}>
					<View class="flex-row">
						<InlineAction
							label="Read again"
							testID="scope-read"
							onPress={() => void props.day.scope?.read(props.ctx.scope())}
						/>
					</View>
				</If>
			</View>
		</If>
	);
}

/** A project's name above its rows, so every row says where it belongs. */
export function ProjectLabel(props: { name: string; own?: boolean; stale?: boolean }) {
	const words = () =>
		props.own ? `${props.name} · this window` : `${props.name}${props.stale ? " · earlier read" : ""}`;
	return <Text class="pt-2 text-xs text-faint">{words()}</Text>;
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
			<View class="flex-row items-center gap-2.5 py-1.5">
				<Mark kind="unknown" />
				<Text class="flex-1 text-sm text-muted-foreground">{`${props.project.name}: ${reason()}`}</Text>
			</View>
		</If>
	);
}

type Need = { id: string; title: string; effort: string; decision: Decision | null };

function needsOf(p: ScopeProject): Need[] {
	const t = p.today;
	if (!t) return [];
	return [
		...t.decisions.map((d) => ({ id: d.id, title: d.title, effort: d.effort, decision: d })),
		...t.actions.map((a: HumanAction) => ({ id: a.id, title: a.title, effort: a.effort, decision: null })),
	];
}

/** How many things other projects in the scope need the user for, when read. */
export function otherNeedsCount(ctx: TodayScope): number {
	return ctx.others().reduce((n, p) => n + needsOf(p).length, 0);
}

/** Other projects' rows in Needs you: titles only, read only here. */
export function OtherNeeds(props: { ctx: TodayScope }) {
	return (
		<Each of={props.ctx.others()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-needs-${p().id}`} class="gap-0.5">
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Unread project={p()} section="needsYou" />
					<If when={complete(p(), "needsYou") && needsOf(p()).length === 0}>
						<Text class="py-1.5 text-sm text-muted-foreground">Nothing needs you here.</Text>
					</If>
					<Each of={needsOf(p())} key={(n) => n.id}>
						{(n) => (
							<View class="flex-row items-center gap-2.5 py-1.5">
								<Mark kind={n().decision ? decisionMark(n().decision as Decision) : "needs"} />
								<Text class="flex-1 text-sm text-foreground">
									{n().decision ? n().title : `Action for you: ${n().title}`}
								</Text>
								<Text class="text-xs text-faint">{n().effort}</Text>
							</View>
						)}
					</Each>
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
export function OtherMissions(props: { ctx: TodayScope }) {
	return (
		<Each of={props.ctx.others()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-missions-${p().id}`} class="gap-0.5">
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Unread project={p()} section="missions" />
					<If when={complete(p(), "missions") && missionsOf(p()).length === 0}>
						<Text class="py-1.5 text-sm text-muted-foreground">No active missions.</Text>
					</If>
					<Each of={missionsOf(p())} key={(m) => m.id}>
						{(m) => {
							const id = m().id;
							// The same place as the window's own row: back on Today, the row takes the focus again.
							const place = placeRow(`mission-${id}`, () => openMission(id));
							return (
								<View class="gap-1 border-t border-border py-3">
									<RowLink
										testID={`scope-mission-${id}`}
										title={m().title}
										accessibilityLabel={`${m().title} in ${p().name}, ${stateWord(m())}. Open the mission.`}
										anchor={place.anchor}
										onPress={place.press}
									>
										<View class="flex-row items-center gap-1.5">
											<Mark kind={stateMark(m())} />
											<Text class="text-xs text-muted-foreground">{stateWord(m())}</Text>
										</View>
									</RowLink>
									<Text class="text-sm text-muted-foreground">{rowLine(m())}</Text>
								</View>
							);
						}}
					</Each>
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
				<View testID={`scope-planning-${p().id}`} class="gap-0.5">
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<If when={p().errors.planning}>
						<View class="flex-row items-center gap-2.5 py-1.5">
							<Mark kind="unknown" />
							<Text class="flex-1 text-sm text-muted-foreground">{`${p().name}: ${p().errors.planning ?? ""}`}</Text>
						</View>
					</If>
					<Each of={plansOf(p())} key={(row) => row.missionId}>
						{(row) => {
							const id = row().missionId;
							const place = placeRow(`plan-${id}`, () => openPlan(id));
							return (
								<View class="py-1.5">
									<RowLink
										testID={`scope-plan-${id}`}
										title={row().title}
										accessibilityLabel={`${row().title} in ${p().name}, ${stageWord(row().stage)}. Open its planning.`}
										anchor={place.anchor}
										onPress={place.press}
									>
										<View class="flex-row items-center gap-1.5">
											<Mark kind={stageMark(row().stage)} />
											<Text
												class={row().needsYou ? "text-xs text-needs-ink" : "text-xs text-muted-foreground"}
											>
												{stageWord(row().stage)}
											</Text>
										</View>
									</RowLink>
								</View>
							);
						}}
					</Each>
				</View>
			)}
		</Each>
	);
}

/** Other projects' results since the user looked. */
export function OtherDone(props: { ctx: TodayScope }) {
	const shown = () => props.ctx.others().filter((p) => (p.today?.done.length ?? 0) > 0);
	return (
		<Each of={shown()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-done-${p().id}`} class="gap-0.5">
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Each of={p().today?.done ?? []} key={(e) => e.id}>
						{(e) => (
							<View class="flex-row items-center gap-3 py-2">
								<Mark kind="done" />
								<Text class="flex-1 text-sm text-foreground">{e().text}</Text>
								<Text class="text-xs text-faint">{e().missionTitle}</Text>
							</View>
						)}
					</Each>
				</View>
			)}
		</Each>
	);
}

function requestsOf(p: ScopeProject) {
	return p.today?.intake.requests ?? [];
}

/** Whether other projects in the scope have New requests to show, or say they could not be read. */
export function otherNewShown(ctx: TodayScope): boolean {
	return ctx
		.others()
		.some((p) => requestsOf(p).length > 0 || (p.today?.intake.trouble.length ?? 0) > 0 || !!p.errors.intake);
}

/** Other projects' new requests: nothing starts, defers or discards from them here. */
export function OtherNew(props: { ctx: TodayScope }) {
	const shown = () =>
		props.ctx
			.others()
			.filter((p) => requestsOf(p).length > 0 || (p.today?.intake.trouble.length ?? 0) > 0 || p.errors.intake);
	return (
		<Each of={shown()} key={(p) => p.id}>
			{(p) => (
				<View testID={`scope-new-${p().id}`} class="gap-0.5">
					<ProjectLabel name={p().name} stale={p().currentness === "stale"} />
					<Each
						of={[p().errors.intake ?? "", ...(p().today?.intake.trouble ?? [])].filter(Boolean)}
						key={(t) => t}
					>
						{(t) => (
							<View class="flex-row items-center gap-2.5 py-1.5">
								<Mark kind="unknown" />
								<Text class="flex-1 text-sm text-muted-foreground">{`${p().name}: ${t()}`}</Text>
							</View>
						)}
					</Each>
					<Each of={requestsOf(p())} key={(r) => r.id}>
						{(r) => (
							<View class="gap-0.5 py-1.5">
								<View class="flex-row items-center gap-2.5">
									<Mark kind="new" />
									<Text class="flex-1 text-sm text-foreground">{r().title}</Text>
								</View>
								<Text class="pl-4 text-xs text-faint">
									{[r().sourceLabel, r().place, r().age].filter(Boolean).join(" · ")}
								</Text>
							</View>
						)}
					</Each>
					<If when={p().today?.intake.more}>
						<Text class="text-xs text-faint">{p().today?.intake.more ?? ""}</Text>
					</If>
				</View>
			)}
		</Each>
	);
}

/** Other projects' delivered results. Reading does not retarget this window or grant actions. */
export function OtherToCheck(props: { ctx: TodayScope }) {
	const rows = (p: ScopeProject) =>
		p.results?.items.filter(
			(i) => i.unsettled || i.snapshot?.pendingOperationId || waitsForCheck(i.snapshot, undefined),
		) ?? [];
	const shown = () => props.ctx.others().filter((p) => rows(p).length > 0 || !p.results?.complete);
	return (
		<If when={shown().length > 0}>
			<View class="gap-1" testID="scope-to-check">
				<SectionTitle title="To check" />
				<Each of={shown()} key={(p) => p.id}>
					{(p) => (
						<View class="gap-0.5">
							<ProjectLabel name={p().name} stale={p().currentness !== "live"} />
							<Each of={rows(p())} key={(i) => i.snapshot?.targetId ?? JSON.stringify(i.subject)}>
								{(i) => (
									<View class="flex-row items-center gap-2.5 py-2">
										<Mark kind={i().unsettled || i().snapshot?.pendingOperationId ? "unknown" : "needs"} />
										<Text class="flex-1 text-sm text-foreground">{i().title}</Text>
										<Text class="text-xs text-needs-ink">
											{i().unsettled || i().snapshot?.pendingOperationId
												? "Check not confirmed"
												: "To check"}
										</Text>
									</View>
								)}
							</Each>
							<If when={!p().results?.complete}>
								<Text class="text-xs text-muted-foreground">
									{p().results?.reason ||
										"Delivered results could not all be read. This is not an empty list."}
								</Text>
							</If>
							<If when={rows(p()).length > 0}>
								<Text class="text-xs text-faint">Choose this project above to check its results here.</Text>
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
			<Text testID="scope-not-shown" class="text-xs text-faint">
				{props.ctx.showsOwn()
					? "Coming up from other projects is not shown here yet."
					: "Coming up for this project is not shown here yet."}
			</Text>
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
	const p = ctx.others()[0];
	if (!p) return `${ctx.name(ctx.scope())} is not shown.`;
	if (!p.today) return `${p.name} could not be read.`;
	const n = p.needsYou.count;
	if (n === null || !complete(p, "needsYou")) return `What needs you in ${p.name} is not fully known.`;
	return n === 0 ? `Nothing needs you in ${p.name}.` : needsWords(n, `in ${p.name}`);
}
