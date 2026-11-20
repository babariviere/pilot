// The window's top bar: the path at the top left ("Pilot / Today ▾", "Pilot / Today / Native desktop app ▾"),
// then the window's commands at the right. "Pilot" always goes to Today; the part before the last one is Back
// (one level up, as Escape is); the last part, where you are, opens a menu of the places every screen can reach.
// At the right: a notice when work is paused for sleep or Pilot's service needs the user, quiet icons for
// Changes, Feedback, Artifacts and Settings, Search with Command+K (the palette) and New. It stays put while the
// screens below it change, so the way out is always in the same place.
import { keymap, signal, windowSize } from "nsh";
import type { Changes } from "./changeFeed";
import type { Day } from "./day";
import { deliveryRoute, deliveryTitles } from "./deliveryView";
import {
	type Back,
	backTarget,
	goArtifacts,
	goChanges,
	goFeedback,
	goHome,
	goInsights,
	goLinear,
	goNew,
	goSchedules,
	goSettings,
	goSlack,
	jump,
	type Places,
	type Shown,
	shown,
} from "./nav";
import { Palette } from "./Palette";
import { PowerPause } from "./PowerPause";
import type { Plans } from "./planning";
import { planRoute } from "./planView";
import { updateLabel } from "./UpdateScreen";
import { Button, Logo, MenuItem, PathBar, PathMenu, PathNote, PathSegment, PathSlash } from "./ui";
import { showUpdate, updateEntry, updateOpen } from "./updateView";
import { dataSource, route } from "./view";
import { destinationProject } from "./workSearch";

/** The keystroke that opens New, as the platform writes it. */
export const NEW_KEYS = keymap.label("mod+n");
/** The keystroke that opens Settings, as the platform writes it. */
export const SETTINGS_KEYS = keymap.label("mod+,");

/** Below this width the bar keeps its icons and drops their words. */
const NARROW = 640;

/** The name of each kind of screen, as the path's last part says it. */
const PLACE_NAMES: Record<Shown, string> = {
	today: "Today",
	new: "New",
	mission: "Mission",
	plan: "Plan",
	chat: "Chat",
	delivery: "Result",
	"code-review": "Review code",
	thread: "Discussion",
	settings: "Settings",
	feedback: "Feedback",
	linear: "Linear issues",
	slack: "Slack reports",
	insights: "Insights",
	artifacts: "Artifacts",
	update: "Update",
	changes: "Changes",
	change: "Change",
	ritual: "Daily notes",
	"search-detail": "Saved item",
	"scoped-question": "Agent question",
};

/** Where the window is, by name: a mission's or a plan's title when it has one. */
function placeName(places: Places): string {
	const at = shown(places);
	if (at === "mission") return places.day.feed.mission(route() ?? "")?.row.title || PLACE_NAMES.mission;
	if (at === "plan") {
		const plan = planRoute();
		const id = plan?.kind === "plan" ? plan.missionId : "";
		return places.day.feed.mission(id)?.row.title || PLACE_NAMES.plan;
	}
	if (at === "delivery") {
		const place = deliveryRoute();
		return place?.title || (place ? deliveryTitles()[place.key] : "") || PLACE_NAMES.delivery;
	}
	return PLACE_NAMES[at];
}

/** The places the path's menu reaches: the ones this window has. Choosing one only goes there. */
function placeItems(places: Places): { id: string; label: string; here: boolean; go: () => void }[] {
	const day = places.day;
	const at = shown(places);
	const all = [
		{ id: "today", label: "Today", has: true, here: at === "today", go: goHome },
		{
			id: "changes",
			label: "Changes",
			has: !!places.changes,
			here: at === "changes" || at === "change",
			go: goChanges,
		},
		{ id: "linear", label: "Linear issues", has: !!day.linear, here: at === "linear", go: goLinear },
		{ id: "slack", label: "Slack reports", has: !!day.slack, here: at === "slack", go: goSlack },
		{ id: "artifacts", label: "Artifacts", has: !!day.artifacts, here: at === "artifacts", go: goArtifacts },
		{ id: "insights", label: "Insights", has: !!day.insights, here: at === "insights", go: goInsights },
		{ id: "feedback", label: "Feedback", has: !!day.feedback, here: at === "feedback", go: goFeedback },
		{ id: "schedules", label: "Schedules", has: !!day.schedules, here: false, go: goSchedules },
		{ id: "settings", label: "Settings", has: !!day.preferences, here: at === "settings", go: () => goSettings() },
	];
	return all.filter((p) => p.has).map(({ id, label, here, go }) => ({ id, label, here, go }));
}

/** The top bar over every screen of `props.day`. */
export function AppHeader(props: { day: Day; plans?: Plans; changes?: Changes }) {
	const places: Places = { day: props.day, plans: props.plans, changes: props.changes };
	const back = () => backTarget(places);
	const at = () => shown(places);
	const narrow = () => windowSize().width < NARROW;
	const menu = signal(false);
	// Pilot's service, only when it needs the user: an update, a registration, a lost answer.
	const update = () => {
		const entry = updateEntry();
		return entry && !updateOpen() ? updateLabel(entry.service()) : "";
	};
	const waiting = () => props.changes?.list().waiting.length ?? 0;
	const newWork = () => jump(places, goNew);
	const settings = () => jump(places, goSettings);
	if (props.plans) keymap.bind("mod+n", newWork);
	if (props.day.preferences) keymap.bind("mod+,", settings);
	return (
		<PathBar
			testID="app-header"
			trailing={
				<>
					<If when={props.day.power?.view().paused}>
						<PowerPause power={props.day.power!} narrow={narrow()} />
					</If>
					<If when={update()}>
						<Button label={update()} icon="update" testID="update-open" onPress={showUpdate} />
					</If>
					<If when={props.changes && at() !== "changes"}>
						<Button
							label="Changes"
							kind="quiet"
							icon="changes"
							iconOnly
							count={waiting() > 0 ? waiting() : undefined}
							testID="changes-open"
							accessibilityLabel={waiting() > 0 ? `Changes, ${waiting()} to review` : "Changes"}
							onPress={() => jump(places, goChanges)}
						/>
					</If>
					<If when={props.day.feedback && at() !== "feedback"}>
						<Button
							label="Feedback"
							kind="quiet"
							icon="notes"
							iconOnly
							testID="feedback-open"
							onPress={() => jump(places, goFeedback)}
						/>
					</If>
					<If when={props.day.artifacts && at() !== "artifacts"}>
						<Button
							label="Artifacts"
							kind="quiet"
							icon="document"
							iconOnly
							testID="artifacts-open"
							onPress={() => jump(places, goArtifacts)}
						/>
					</If>
					<If when={props.day.preferences && at() !== "settings"}>
						<Button
							label="Settings"
							kind="quiet"
							icon="settings"
							iconOnly
							shortcut={SETTINGS_KEYS}
							testID="settings-open"
							onPress={settings}
						/>
					</If>
					<Palette places={places} narrow={narrow()} />
					<If when={props.plans && at() !== "new"}>
						<Button
							label="New"
							icon="plus"
							iconOnly={narrow()}
							shortcut={NEW_KEYS}
							testID="new-open"
							onPress={newWork}
						/>
					</If>
					<If when={dataSource() === "mock"}>
						<PathNote text="Mock data" dashed />
					</If>
				</>
			}
		>
			<Logo />
			<PathSegment
				testID="home"
				label="Pilot"
				accessibilityLabel="Pilot. Go to Today"
				tooltip="Today"
				onPress={goHome}
			/>
			<Each of={back() ? [back() as Back] : []} key={(b) => b.label}>
				{(b) => (
					<>
						<PathSlash />
						<PathSegment
							testID="back"
							label={b().label}
							accessibilityLabel={b().accessibilityLabel}
							tooltip="Back  Esc"
							onPress={() => back()?.go()}
						/>
					</>
				)}
			</Each>
			<PathSlash />
			<PathMenu label={placeName(places)} open={menu()} onOpenChange={(open) => menu.set(open)} testID="place-menu">
				<Each of={placeItems(places)} key={(p) => p.id}>
					{(p) => (
						<MenuItem
							label={p().label}
							hint={p().here ? "Shown now" : undefined}
							testID={`place-${p().id}`}
							onSelect={() => {
								menu.set(false);
								if (p().id === "today") p().go();
								else jump(places, p().go);
							}}
						/>
					)}
				</Each>
			</PathMenu>
			<If when={destinationProject() && at() !== "today" && at() !== "search-detail" && !narrow()}>
				<PathNote text={destinationProject()} />
			</If>
		</PathBar>
	);
}
