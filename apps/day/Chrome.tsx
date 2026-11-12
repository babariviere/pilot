// The window's one header: Pilot at the top left, which always goes to
// Today; one Back that goes up a level; and the few places every screen can
// reach: an update that needs the user, Changes and New. It stays put while
// the screens below it change, so the way out is always in the same place.
import { keymap, Text, View, windowSize } from "nsh";
import { Button } from "nsh/base";
import type { Changes } from "./changeFeed";
import { showChanges } from "./changesView";
import type { Day } from "./day";
import { type Back, backTarget, goHome, type Places, shown } from "./nav";
import type { Plans } from "./planning";
import { openNew } from "./planView";
import { updateLabel } from "./UpdateScreen";
import { Action, Icon } from "./ui";
import { showUpdate, updateEntry, updateOpen } from "./updateView";
import { dataSource } from "./view";

/** The keystroke that opens New, as the platform writes it. */
export const NEW_KEYS = keymap.label("mod+n");

/** Below this width the header keeps its icons and drops their words. */
const NARROW = 640;

/** Opens New from wherever the user is. Drafts stay where they are. */
function goNew() {
	goHome();
	openNew();
}

/** Opens Changes from wherever the user is. */
function goChanges() {
	goHome();
	showChanges();
}

/** Pilot's mark and name: the way home. */
function Home() {
	return (
		<Button
			testID="home"
			accessibilityLabel="Pilot. Go to Today"
			tooltip="Today"
			onPress={goHome}
			class="h-8 flex-row items-center gap-2 rounded-lg px-2 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<View class="size-4 rounded-md bg-primary" />
			<Text class="text-sm font-semibold text-foreground">Pilot</Text>
		</Button>
	);
}

/** The Changes place: how many reviews wait, said to screen readers too. */
function ChangesPlace(props: { changes: Changes; narrow: boolean }) {
	const waiting = () => props.changes.list().waiting.length;
	return (
		<Button
			testID="changes-open"
			accessibilityLabel={waiting() > 0 ? `Changes, ${waiting()} to review` : "Changes"}
			tooltip={props.narrow ? "Changes" : undefined}
			onPress={goChanges}
			class="h-8 flex-row items-center gap-1.5 rounded-lg px-2.5 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
		>
			<Icon name="changes" />
			<If when={!props.narrow}>
				<Text class="text-sm text-muted-foreground">Changes</Text>
			</If>
			<If when={waiting() > 0}>
				<View class="h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5">
					<Text class="text-xs font-semibold text-foreground">{String(waiting())}</Text>
				</View>
			</If>
		</Button>
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
	if (props.plans) keymap.bind("mod+n", goNew);
	return (
		<View testID="app-header" class="h-12 flex-row items-center gap-1 border-b border-border bg-background px-3">
			<Home />
			<Each of={back() ? [back() as Back] : []} key={(b) => b.label}>
				{(b) => (
					<View class="min-w-0 shrink flex-row items-center gap-1">
						<View class="mx-1 h-4 w-px bg-border" />
						<Button
							testID="back"
							accessibilityLabel={b().accessibilityLabel}
							tooltip="Back  Esc"
							onPress={() => back()?.go()}
							class="h-8 min-w-0 shrink flex-row items-center gap-1 rounded-lg pl-1.5 pr-2.5 hover:bg-accent active:bg-accent focus-visible:ring-2 focus-visible:ring-ring/40"
						>
							<Icon name="back" />
							<Text class="shrink truncate text-sm text-muted-foreground">{b().label}</Text>
						</Button>
					</View>
				)}
			</Each>
			<View class="flex-1" />
			<If when={update()}>
				<Action label={update()} icon="update" testID="update-open" onPress={showUpdate} />
			</If>
			<If when={props.changes && at() !== "changes"}>
				<ChangesPlace changes={props.changes as Changes} narrow={narrow()} />
			</If>
			<If when={props.plans && at() !== "new"}>
				<View class="pl-1">
					<Action
						label="New"
						outline
						icon="plus"
						iconOnly={narrow()}
						shortcut={NEW_KEYS}
						testID="new-open"
						onPress={goNew}
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
