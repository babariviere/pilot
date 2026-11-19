// The command palette: Command+K over any screen. One search field over the
// places the header reaches and the missions Today lists, by name. Choosing
// one only goes there, as the header and Today's rows do: it never sends,
// saves, approves or starts anything, and New still waits for the user to
// choose a project. Commands that act stay on their screens, behind their
// own confirmation. Escape clears the search, then closes the palette, and
// the keyboard focus goes back where it was.
import { cleanup, computed, effect, Keyboard, keymap, signal, Text, untracked, View } from "nsh";
import { Command, type CommandItem, type CommandRef, Dialog } from "nsh/base";
import { openChat } from "./chatView";
import { deliveryRoute, openCodeReview, openDelivery, reviewableCode } from "./deliveryView";
import {
	goArtifacts,
	goChanges,
	goFeedback,
	goHome,
	goLinear,
	goMission,
	goInsights,
	goNew,
	goPlan,
	goSchedules,
	goSettings,
	goSlack,
	jump,
	type Places,
	shown,
} from "./nav";
import { stageMark, stageWord } from "./PlanScreen";
import { offered, openRitual, openStandup, ritualEntry } from "./ritualView";
import { screenAgentAvailable, screenAgentOpen } from "./screenAgentOpen";
import { updateLabel } from "./UpdateScreen";
import { Action, KeyCap, KeyHint, Mark, type MarkKind, Picker } from "./ui";
import { showUpdate, updateEntry, updateOpen } from "./updateView";
import { route } from "./view";
import { stateMark, stateWord } from "./words";
import { destinationProject, searchDetail, type SearchHit, type WorkSearchPage } from "./workSearch";

/** One row: the command, a quiet word or mark beside it, and where it goes. */
type Entry = { item: CommandItem; title?: string; hint?: string; mark?: MarkKind; project?: string; run?: () => void };

function openHit(hit: SearchHit) {
	if (hit.kind === "mission") goMission(hit.target);
	else goHome();
	switch (hit.kind) {
		case "mission":
			break;
		case "chat":
			openChat(hit.target, "Today");
			break;
		case "result":
			openDelivery(hit.target, hit.title);
			break;
		case "output":
		case "knowledge":
			searchDetail.set(hit);
			break;
	}
	destinationProject.set(hit.projectName);
}

function hitEntry(hit: SearchHit): Entry {
	const labels = {
		mission: "Mission",
		chat: "Chat",
		result: "Result",
		output: "Output",
		knowledge: "Knowledge",
	};
	return {
		item: { id: hit.key, label: `${hit.title}, ${labels[hit.kind]} in ${hit.projectName}`, group: labels[hit.kind] },
		title: hit.title,
		project: hit.projectName,
		run: () => openHit(hit),
	};
}

/** A row that cannot be chosen, with the reason in place of a destination. */
function unavailable(id: string, label: string, group: string, hint: string): Entry {
	return { item: { id, label, group, disabled: true }, hint };
}

/** What the palette offers now, read from the same state the header and Today show. */
function entries(places: Places): Entry[] {
	const day = places.day;
	const at = shown(places);
	const list: Entry[] = [];
	const absent: Entry[] = [];
	const place = (
		id: string,
		label: string,
		has: boolean,
		run: () => void,
		more: { keywords?: string[]; shortcut?: string; here?: boolean } = {},
	) => {
		if (!has) {
			absent.push(unavailable(`absent:${id}`, label, "Not in this window", "Not available here"));
			return;
		}
		list.push({
			item: { id, label, group: "Go to", keywords: more.keywords, shortcut: more.shortcut, checked: more.here },
			run,
		});
	};
	place("today", "Today", true, goHome, { keywords: ["home"], here: at === "today" });
	// The open result's Review code, while its page shows a Code changes row.
	const result = deliveryRoute()?.key;
	if (result && (at === "code-review" || (at === "delivery" && reviewableCode() === result))) {
		place("review-code", "Review code", true, () => openCodeReview(result), {
			keywords: ["diff", "comments", "changes"],
			shortcut: "mod+r",
			here: at === "code-review",
		});
	}
	// The service, only when it needs the user, as the header offers it.
	const update = updateEntry();
	const word = update && !updateOpen() ? updateLabel(update.service()) : "";
	if (word) place("update", word, true, showUpdate, { keywords: ["update", "service"] });
	const rituals = ritualEntry();
	const ritual = !day.search && rituals ? offered(day.today(), rituals.progress(), rituals.uncertain()) : null;
	if (ritual) {
		place(ritual, ritual === "start" ? "Start the day" : "End the day", true, () => {
			goHome();
			openRitual(ritual);
		});
	}
	place("new", "New", !!places.plans, goNew, {
		keywords: ["mission", "chat", "goal", "plan"],
		shortcut: "mod+n",
		here: at === "new",
	});
	place("changes", "Changes", !!places.changes, goChanges, {
		keywords: ["review", "diff"],
		here: at === "changes" || at === "change",
	});
	place("linear", "Linear issues", !!day.linear, goLinear, { keywords: ["tickets", "cycle"], here: at === "linear" });
	place("slack", "Slack reports", !!day.slack, goSlack, { keywords: ["requests", "triage"], here: at === "slack" });
	place("artifacts", "Artifacts", !!day.artifacts, goArtifacts, { here: at === "artifacts" });
	place("feedback", "Feedback", !!day.feedback, goFeedback, { keywords: ["bug", "idea"], here: at === "feedback" });
	place("schedules", "Schedules", !!day.schedules, goSchedules, { keywords: ["automation", "check-ins", "repair"] });
	place("insights", "Insights", !!day.insights, goInsights, {
		keywords: ["reports", "findings"],
		here: at === "insights",
	});
	// Opens the screen agent's bar over this screen. It sends nothing until the person asks.
	if (screenAgentAvailable()) {
		list.push({
			item: {
				id: "screen-agent",
				label: "Ask about this window",
				group: "Go to",
				keywords: ["screen agent", "debug", "bug"],
				shortcut: "mod+j",
			},
			run: () => screenAgentOpen.set(true),
		});
	}
	place("settings", "Settings", !!day.preferences, goSettings, {
		keywords: ["preferences"],
		shortcut: "mod+,",
		here: at === "settings",
	});
	place(
		"standup",
		day.search ? "Plan or recap" : "Standup notes",
		true,
		() => {
			goHome();
			openStandup(null);
		},
		{ keywords: ["recap"] },
	);

	// The missions Today lists. A read that failed says so: it is not an empty list.
	const today = day.today();
	if (today.freshness.state === "unreadable") {
		list.push(unavailable("missions-unread", "Missions could not be read", "Missions", "Today says why"));
	} else {
		for (const row of [...today.moving, ...today.notMoving, ...today.unreported]) {
			list.push({
				item: {
					id: `mission:${row.id}`,
					label: row.title,
					group: "Missions",
					keywords: [stateWord(row)],
					checked: at === "mission" && route() === row.id,
				},
				hint: stateWord(row),
				mark: stateMark(row),
				run: () => goMission(row.id),
			});
		}
	}

	// Missions in planning, those waiting for the user first, as Today lists them.
	const planning = places.plans?.planning();
	if (planning?.availability === "unavailable") {
		list.push(unavailable("planning-off", "Missions in planning", "Planning", "Unavailable now"));
	} else if (planning) {
		const rows = [...planning.plans.filter((p) => p.needsYou), ...planning.plans.filter((p) => !p.needsYou)];
		for (const p of rows) {
			list.push({
				item: { id: `plan:${p.missionId}`, label: p.title, group: "Planning", keywords: [stageWord(p.stage)] },
				hint: stageWord(p.stage),
				mark: stageMark(p.stage),
				run: () => goPlan(p.missionId),
			});
		}
	}
	return [...list, ...absent];
}

/** The palette's surface while it is open: one search field over one list. */
function Open(props: {
	places: Places;
	/** Closes the palette and gives the keyboard back. */
	onClose: () => void;
	/** Puts the palette away after the window already went elsewhere: the new screen keeps its focus. */
	onAway: () => void;
	anchor: (ref: CommandRef) => void;
}) {
	const query = signal("");
	const project = signal<string | null>(null);
	const projects = signal<WorkSearchPage["projects"]>([]);
	const page = signal<WorkSearchPage | null>(null);
	const reading = signal(false);
	const failed = signal(false);
	const retry = signal(0);
	const cursor = signal<string | undefined>(undefined);
	const source = props.places.day.search;
	let pending: (() => Promise<void>) | undefined;
	let running = false;
	const drain = async () => {
		if (running) return;
		running = true;
		try {
			while (pending) {
				const next = pending;
				pending = undefined;
				await next();
			}
		} finally {
			running = false;
		}
	};
	if (source) {
		effect(() => {
			const text = query().trim();
			const selected = project();
			const offset = cursor();
			retry();
			let current = true;
			page.set(null);
			failed.set(false);
			reading.set(true);
			const timer = setTimeout(
				() => {
					pending = async () => {
						const reply = await source.read(text, selected, offset).catch(() => null);
						if (!current) return;
						if (reply) projects.set(reply.projects);
						page.set(reply);
						failed.set(!reply);
						reading.set(false);
					};
					void drain();
				},
				text ? 250 : 0,
			);
			cleanup(() => {
				current = false;
				pending = undefined;
				clearTimeout(timer);
			});
		});
	}
	const all = computed(() => {
		const search = query().trim().toLowerCase();
		const local = entries(props.places).filter((entry) => {
			if (source && (entry.item.group === "Missions" || entry.item.group === "Planning")) return false;
			return [entry.item.label, ...(entry.item.keywords ?? [])].some((word) => word.toLowerCase().includes(search));
		});
		return [...local, ...(page()?.hits ?? []).map(hitEntry)];
	});
	const items = () => all().map((e) => e.item);
	const find = (id: string) => all().find((e) => e.item.id === id);
	// Over every screen's own Escape while the palette is open: the search
	// first, then the palette. An input method that is composing keeps Escape.
	keymap.bind(
		"escape",
		() => {
			if (query() !== "") query.set("");
			else props.onClose();
		},
		{ when: "always" },
	);
	// The screen behind keeps its commits (send, save, next) while the palette
	// covers it: those keys do nothing here, so nothing runs out of sight.
	keymap.bind({ "mod+enter": () => {}, "mod+s": () => {} }, { when: "always" });
	// A shortcut that moves the window elsewhere (New, Settings) puts the palette away.
	const from = untracked(() => shown(props.places));
	effect(() => {
		if (shown(props.places) !== from) untracked(props.onAway);
	});
	return (
		<Command
			testID="palette"
			ref={props.anchor}
			items={items()}
			filterable={false}
			query={query()}
			onQueryChange={({ query: next }) => {
				cursor.set(undefined);
				query.set(next);
			}}
			loading={!!source && reading()}
			onCancel={props.onClose}
			onSelect={({ id }) => {
				const chosen = find(id);
				if (!chosen?.run || chosen.item.disabled) return;
				props.onClose();
				if (id === "today") chosen.run();
				else jump(props.places, chosen.run);
			}}
			autoFocus
			placeholder="Search your work or go to a place…"
			accessibilityLabel="Search results and places"
			searchAccessibilityLabel="Search work and places"
			class="overflow-hidden rounded-xl border border-border bg-popover shadow-md"
			searchBarClass="flex-row items-center border-b border-border px-3.5"
			searchClass="h-11 flex-1 text-sm text-foreground placeholder:text-faint"
			searchSuffix={<Action label="Close search" onPress={props.onClose} />}
			listClass="max-h-80 p-1"
			groupClass="px-2.5 pb-1 pt-2 text-xs text-faint"
			separatorClass="mx-1.5 my-1 h-px bg-border"
			itemClass="group min-h-8 flex-row items-center rounded-lg px-2.5 py-1.5 focus:bg-accent checked:bg-selection disabled:opacity-60"
			renderItem={(entry) => (
				<View class="flex-1 flex-row items-center gap-2.5">
					<If when={find(entry.id)?.mark}>
						<Mark kind={find(entry.id)?.mark as MarkKind} />
					</If>
					<Text class="min-w-0 flex-1 truncate text-sm text-popover-foreground">
						{find(entry.id)?.title ?? entry.label}
					</Text>
					<If when={find(entry.id)?.project}>
						<Text class="max-w-32 truncate text-xs text-muted-foreground">{find(entry.id)?.project ?? ""}</Text>
					</If>
					<If when={find(entry.id)?.hint}>
						<Text class="shrink-0 text-xs text-faint">{find(entry.id)?.hint ?? ""}</Text>
					</If>
					<If when={entry.checked}>
						<Text class="shrink-0 text-xs text-faint">Shown now</Text>
					</If>
					<If when={entry.shortcutLabel}>
						<KeyCap label={entry.shortcutLabel ?? ""} />
					</If>
				</View>
			)}
			empty={
				<View testID="palette-empty" class="gap-1 px-3 py-6">
					<Text class="text-center text-sm text-muted-foreground">
						{failed() || page()?.partial || page()?.more
							? "No matches from the work Pilot could read."
							: `Nothing matches “${query()}”.`}
					</Text>
					<Text class="text-center text-xs text-faint">
						{source ? "Try another title or project." : "The palette finds places and the missions Today lists."}
					</Text>
				</View>
			}
			footer={
				<View class="gap-2 border-t border-border px-3.5 py-2">
					<If when={!!source}>
						<View class="flex-row flex-wrap items-center gap-2">
							<Picker
								testID="search-project"
								label="Search project"
								items={[
									{ value: "all", title: "All projects" },
									...projects().map((p) => ({ value: p.id, title: p.name })),
								]}
								value={project() ?? "all"}
								placeholder="All projects"
								onChange={(value) => {
									cursor.set(undefined);
									project.set(value === "all" ? null : value);
								}}
							/>
							<Text class="flex-1 text-xs text-muted-foreground">
								{reading()
									? "Searching…"
									: failed()
										? "Work search is unavailable."
										: page()?.partial
											? "Some work could not be read. Try one project or search again."
											: page()?.more
												? "More work may match. Narrow your search."
												: ""}
							</Text>
							<If when={failed()}>
								<Action label="Try again" onPress={() => retry.update((n) => n + 1)} />
							</If>
							<If when={page()?.nextCursor}>
								<Action label="Search more" onPress={() => cursor.set(page()?.nextCursor ?? undefined)} />
							</If>
						</View>
					</If>
					<View class="flex-row items-center gap-4">
						<KeyHint keys="↑↓" label="move" />
						<KeyHint keys="↩" label="open" />
						<KeyHint keys="esc" label="close" />
					</View>
				</View>
			}
		/>
	);
}

/**
 * The palette over the window's screens, and its Command+K. It is built
 * anew each time it opens, with an empty search.
 */
export function Palette(props: { places: Places; narrow: boolean }) {
	const open = signal(false);
	let search: CommandRef | undefined;
	// The search field lets the keyboard go first, so the dialog gives it
	// back to what had it before (a draft's field, a row).
	const close = () => {
		Keyboard.dismiss();
		open.set(false);
	};
	keymap.bind("mod+k", () => (open() ? close() : open.set(true)));
	return (
		<>
			<Action
				label="Search"
				icon="search"
				iconOnly={props.narrow}
				variant="outline"
				shortcut={keymap.label("mod+k")}
				testID="search-open"
				onPress={() => open.set(true)}
			/>
			<If when={open()}>
				<Dialog
					testID="palette-dialog"
					accessibilityLabel="Go to"
					animation="fade"
					// The search field takes the keyboard once the palette is up, so typing and the arrow keys work at once.
					onOpen={() => search?.focus()}
					onOpenChange={(e) => {
						if (!e.open) open.set(false);
					}}
					backdropClass="bg-background/50"
					class="mx-auto mt-16 w-full max-w-xl px-4"
				>
					<Open
						places={props.places}
						onClose={close}
						onAway={() => open.set(false)}
						anchor={(ref) => (search = ref)}
					/>
				</Dialog>
			</If>
		</>
	);
}
