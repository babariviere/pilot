// Test fixture only: the mock mission "Faster search" opened on its overview,
// with invented tasks in each work state. Every record is mock data. The bar
// on top picks a situation; Command-Shift-U applies the next live update
// without moving the keyboard focus. Nothing here reads or sends anything real.
import { keymap, mount, signal, Text, View } from "nsh";
import type { Freshness, MissionPage, TaskLine, TaskWorkState } from "pilot-day/native";
import { TodayFeed } from "pilot-day/native";
import { anchorOnScreen, type Span } from "./contentAnchor";
import { type Day, mirrorDay } from "./day";
import type { DayFeed } from "./feeds";
import { scrollOf } from "./kept";
import { MockDayScreen, openMockChat, openPlanning } from "./mockFeeds";
import { ScriptedThreads } from "./threadDemo";
import { mirrorThreads } from "./threadFeed";
import { Action } from "./ui";
import { openMission } from "./view";

type Situation = "running" | "waiting" | "paused" | "empty" | "completed" | "unread" | "older" | "offline";
const SITUATIONS: Situation[] = ["running", "waiting", "paused", "empty", "completed", "unread", "older", "offline"];

const situation = signal<Situation>("running");
/** Live updates applied to the running mission: 0 as first read, then 1. */
const step = signal(0);
/** The page's kept scroll offset, read on "Where" so reading it changes nothing on screen. */
const where = signal("");
const longTitles = signal(false);

function task(
	id: string,
	number: number,
	title: string,
	status: TaskLine["status"],
	workState: TaskWorkState,
	more: Partial<TaskLine> = {},
): TaskLine {
	return {
		id,
		number,
		title,
		status,
		report: null,
		outputs: [],
		sessionId: null,
		workState,
		workReason: "",
		ownerTitle: "",
		body: "",
		prerequisites: [],
		...more,
	};
}

const QUEUED = "Queued in the plan only. Start permission, capacity and other holds have not been checked.";

function running(): TaskLine[] {
	const moved = step() > 0;
	return [
		task("search-1", 1, "Measure the baseline", "done", "completed"),
		task("search-2", 2, "Incremental index", "done", "completed"),
		task("search-3", 3, "Integration tests on Linux", "inProgress", "working", {
			sessionId: "w-search",
			ownerTitle: "Build · Sonnet",
			workReason: "Running the Linux test suite.",
			body: "Run the integration suite on Ubuntu and Fedora with a large workspace.",
			modelLine: "Backend · large · GPT-6.2 Sol · preferred",
			modelProfile: "backend",
		}),
		moved
			? task("search-4", 4, "Release pull request", "inProgress", "working", {
					sessionId: "w-release",
					ownerTitle: "Build · Sonnet",
					workReason: "Writing the release notes.",
					body: "Open the release pull request with the benchmark chart.",
				})
			: task("search-4", 4, "Release pull request", "todo", "queued", {
					workReason: QUEUED,
					body: "Open the release pull request with the benchmark chart.",
					modelLine: "UI · large · GPT-6.2 Sol · Claude Opus 5.5 was busier",
					modelProfile: "ui",
				}),
		task("search-5", 5, "Ranking tweaks", "todo", "dependencyBlocked", {
			workReason: "Waiting for #4 Release pull request.",
			prerequisites: [
				{ id: "search-4", number: 4, title: "Release pull request", status: moved ? "inProgress" : "todo" },
			],
		}),
		task("search-6", 6, "Docs for search", "blocked", "blocked", {
			workReason: "Marked blocked. No blocking prerequisite is recorded.",
		}),
		task("search-7", 7, "Migrate old indexes", "todo", "dependencyBlocked", {
			workReason: "Prerequisite gone-9 is unavailable; it is not known done.",
			prerequisites: [{ id: "gone-9", number: 0, title: "Prerequisite unavailable", status: "unknown" }],
		}),
		task("search-8", 8, "Benchmark review", "inReview", "review", {
			sessionId: "w-review",
			ownerTitle: "Review · Opus",
			workReason: "Commit 4be1c07 is ready for review.",
		}),
	];
}

function tasks(now: Situation): TaskLine[] {
	const all = running();
	switch (now) {
		case "waiting":
			return all.map((t) =>
				t.id === "search-3"
					? { ...t, workState: "waitingForUser", workReason: "Which Linux distributions count for the release?" }
					: t,
			);
		case "paused":
			// Pause holds every unfinished task and keeps its reasons; review stays review.
			return all.map((t) => {
				if (t.workState === "completed" || t.workState === "review") return t;
				const reasons = ["Mission is paused.", t.workState === "working" ? "" : (t.workReason ?? "")]
					.filter((r) => r)
					.join("\n");
				const held = { ...t, workState: "held" as const, workReason: reasons };
				// #4 was not started but has an assigned chat, so its Next row links it.
				return t.id === "search-4" ? { ...held, sessionId: "w-release", ownerTitle: "Build · Sonnet" } : held;
			});
		case "completed":
			return all.map((t) => ({ ...t, status: "done", workState: "completed", workReason: "", prerequisites: [] }));
		case "empty":
		case "unread":
			return [];
		case "older":
			// An older service: no work state, owner or reason. Nothing is inferred from the status.
			return all.map((t) => ({ ...t, workState: undefined, workReason: undefined, ownerTitle: undefined }));
		default:
			return all;
	}
}

const OFFLINE: Freshness = { state: "offline", age: "6 min ago", reason: "Pilot's service is not answering." };

const base = new TodayFeed();
const keys = [
	"snapshot",
	"onChange",
	"openMission",
	"decide",
	"reply",
	"saveDraft",
	"flushDrafts",
	"openLink",
	"later",
	"check",
	"ask",
	"checkAnswer",
	"saveProgress",
	"actionLater",
	"complete",
	"checkAction",
	"pause",
	"resume",
	"checkControl",
	"stopReplanning",
	"archive",
	"reopen",
	"rename",
	"pulse",
	"dispose",
] as const;
const feed = Object.fromEntries(
	keys.map((k) => [k, (...args: unknown[]) => (base[k] as (...a: unknown[]) => unknown).apply(base, args)]),
) as unknown as DayFeed;

function page(original: MissionPage): MissionPage {
	const now = situation();
	const row = { ...original.row };
	if (now === "waiting") {
		row.state = "waiting";
		row.decisionId = base.snapshot().decisions[0]?.id ?? null;
	}
	if (now === "paused") {
		row.state = "paused";
		row.control = { ...row.control, state: "paused", canPause: false, canResume: true };
	}
	return {
		...original,
		row: longTitles()
			? { ...row, title: "Faster search across large workspaces with long project and mission names" }
			: row,
		tasks: tasks(now).map((t) =>
			longTitles()
				? {
						...t,
						title: `${t.title} across large workspaces on every supported platform`,
						sessionId: t.sessionId ?? "w-search",
					}
				: t,
		),
		tasksKnown: now !== "unread",
		brief: "Search must answer in under 200 ms for workspaces with 50,000 files.",
		decisions: ["Linux and macOS only for this release.", "Keep the old index until the new one is checked."],
		freshness: now === "offline" ? OFFLINE : original.freshness,
	};
}

feed.mission = (id: string) => {
	const original = base.mission(id);
	return original && id === "search" ? page(original) : original;
};

const day: Day = mirrorDay(feed, { chat: openMockChat(), threads: mirrorThreads(new ScriptedThreads()) });
const plans = openPlanning();

function choose(next: Situation) {
	situation.set(next);
	step.set(0);
	const today = day.today();
	day.today.set({ ...today, freshness: next === "offline" ? OFFLINE : base.snapshot().freshness });
}

/** The kept scroll offset and where the Next list and the latest report sit on screen, top..bottom. */
async function showWhere() {
	where.set("");
	const [next, report] = await Promise.all([anchorOnScreen("next"), anchorOnScreen("report")]);
	const at = (n: Span | null) => (n === null ? "none" : `${Math.round(n.top)}..${Math.round(n.bottom)}`);
	where.set(`Scroll: ${Math.round(scrollOf("mission/search"))} · next ${at(next)} · report ${at(report)}`);
}

// A live update that does not take the keyboard focus from where the user is.
keymap.bind("mod+shift+u", () => step.set(step() + 1), { when: "always" });

openMission("search");
mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 border-b border-border px-4 py-2">
			<Text class="text-xs text-muted-foreground">Mock data · situation</Text>
			<Action label="Long chat titles" onPress={() => longTitles.set(true)} />
			<Each of={SITUATIONS} key={(s) => s}>
				{(s) => <Action label={s()} testID={`situation-${s()}`} onPress={() => choose(s())} />}
			</Each>
			<Text testID="situation-step" class="text-xs text-faint">{`${situation()} · update ${step()}`}</Text>
			<Action label="Where" testID="where" onPress={() => void showWhere()} />
			<Text testID="where-text" class="text-xs text-faint">
				{where()}
			</Text>
		</View>
		<MockDayScreen day={day} plans={plans} />
	</View>
));
