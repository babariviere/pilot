// The window's one header: Pilot at the top left, which always goes to
// Today; one Back that goes up a level; and the few places every screen can
// reach: an update that needs the user, Changes, Artifacts, Feedback, Settings and New. It stays put while
// the screens below it change, so the way out is always in the same place.
// Command+K opens the palette over any screen: the same places, and the
// missions Today lists, by name.
import { keymap, Text, View, windowSize } from "nsh";
import type { Changes } from "./changeFeed";
import type { Day } from "./day";
import {
	type Back,
	backTarget,
	goArtifacts,
	goFeedback,
	goChanges,
	goHome,
	goNew,
	goSettings,
	jump,
	type Places,
	shown,
} from "./nav";
import { Palette } from "./Palette";
import { PowerPause } from "./PowerPause";
import type { Plans } from "./planning";
import { updateLabel } from "./UpdateScreen";
import { Action, Icon, Pressable } from "./ui";
import { showUpdate, updateEntry, updateOpen } from "./updateView";
import { dataSource } from "./view";
import { destinationProject } from "./workSearch";

/** The keystroke that opens New, as the platform writes it. */
export const NEW_KEYS = keymap.label("mod+n");
/** The keystroke that opens Settings, as the platform writes it. */
export const SETTINGS_KEYS = keymap.label("mod+,");

/** Below this width the header keeps its icons and drops their words. */
const NARROW = 640;

/** Pilot's mark and name: the way home. */
function Home() {
	return (
		<Pressable
			testID="home"
			accessibilityLabel="Pilot. Go to Today"
			tooltip="Today"
			onPress={goHome}
			class="h-8 flex-row items-center gap-2 rounded-lg px-2 hover:bg-accent active:bg-accent"
		>
			<View class="size-4 rounded-md bg-primary" />
			<Text class="text-sm font-semibold text-foreground">Pilot</Text>
		</Pressable>
	);
}

/** The Changes place: how many reviews wait, said to screen readers too. */
function ChangesPlace(props: { changes: Changes; narrow: boolean; onPress: () => void }) {
	const waiting = () => props.changes.list().waiting.length;
	return (
		<Action
			label="Changes"
			icon="changes"
			iconOnly={props.narrow}
			badge={waiting() > 0 ? String(waiting()) : undefined}
			testID="changes-open"
			accessibilityLabel={waiting() > 0 ? `Changes, ${waiting()} to review` : "Changes"}
			onPress={props.onPress}
		/>
	);
}

/** The header over every screen of `props.day`. */
export function AppHeader(props: { day: Day; plans?: Plans; changes?: Changes }) {
	const places: Places = { day: props.day, plans: props.plans, changes: props.changes };
	const back = () => backTarget(places);
	const at = () => shown(places);
	const narrow = () => windowSize().width < NARROW;
	// Pilot's service, only when it needs the user: an update, a registration, a lost answer.
	const update = () => {
		const entry = updateEntry();
		return entry && !updateOpen() ? updateLabel(entry.service()) : "";
	};
	const newWork = () => jump(places, goNew);
	const settings = () => jump(places, goSettings);
	if (props.plans) keymap.bind("mod+n", newWork);
	if (props.day.preferences) keymap.bind("mod+,", settings);
	return (
		<View testID="app-header" class="h-12 flex-row items-center gap-1 border-b border-border bg-background px-3">
			<Home />
			<Each of={back() ? [back() as Back] : []} key={(b) => b.label}>
				{(b) => (
					<View class="min-w-0 shrink flex-row items-center gap-1">
						<View class="mx-1 h-4 w-px bg-border" />
						<Pressable
							testID="back"
							accessibilityLabel={b().accessibilityLabel}
							tooltip="Back  Esc"
							onPress={() => back()?.go()}
							class="h-8 min-w-0 shrink flex-row items-center gap-1 rounded-lg pl-1.5 pr-2.5 hover:bg-accent active:bg-accent"
						>
							<Icon name="back" />
							<Text class="shrink truncate text-sm text-muted-foreground">{b().label}</Text>
						</Pressable>
					</View>
				)}
			</Each>
			<If when={destinationProject() && at() !== "today" && at() !== "search-detail" && !narrow()}>
				<Text class="max-w-32 shrink truncate px-2 text-xs text-muted-foreground">{destinationProject()}</Text>
			</If>
			<View class="flex-1" />
			<If when={props.day.power?.view().paused}>
				<PowerPause power={props.day.power!} narrow={narrow()} />
			</If>
			<If when={update()}>
				<Action label={update()} icon="update" testID="update-open" onPress={showUpdate} />
			</If>
			<If when={props.changes && at() !== "changes"}>
				<ChangesPlace
					changes={props.changes as Changes}
					narrow={narrow()}
					onPress={() => jump(places, goChanges)}
				/>
			</If>
			<Palette places={places} narrow={narrow()} />
			<If when={props.day.feedback && at() !== "feedback"}>
				<Action
					label="Feedback"
					icon="notes"
					iconOnly
					testID="feedback-open"
					onPress={() => jump(places, goFeedback)}
				/>
			</If>
			<If when={props.day.artifacts && at() !== "artifacts"}>
				<Action
					label="Artifacts"
					icon="document"
					iconOnly
					testID="artifacts-open"
					onPress={() => jump(places, goArtifacts)}
				/>
			</If>
			<If when={props.day.preferences && at() !== "settings"}>
				<Action
					label="Settings"
					icon="settings"
					iconOnly
					shortcut={SETTINGS_KEYS}
					testID="settings-open"
					onPress={settings}
				/>
			</If>
			<If when={props.plans && at() !== "new"}>
				<View class="pl-1">
					<Action
						label="New"
						variant="outline"
						icon="plus"
						iconOnly={narrow()}
						shortcut={NEW_KEYS}
						testID="new-open"
						onPress={newWork}
					/>
				</View>
			</If>
			<If when={dataSource() === "mock"}>
				<View class="ml-2 rounded-md border border-dashed border-border-strong px-1.5 py-0.5">
					<Text class="text-xs text-faint">Mock data</Text>
				</View>
			</If>
		</View>
	);
}
