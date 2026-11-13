// Headless fixture only. No daemon, worker, provider or storage. Settings
// over scripted project preferences (preferencesDemo.ts): `Next …` picks
// what the next Save does, "Save and reopen" keeps the window as a close or
// an update saves it and shows it again in a fresh window state, and
// "Draft elsewhere" leaves unsaved preferences for another project.
import { mount, signal, Text, View } from "nsh";
import { openDay } from "./day";
import { MockDayScreen } from "./mockFeeds";
import { type PreferencesDemoNext, ScriptedPreferences } from "./preferencesDemo";
import { mirrorPreferences } from "./preferencesFeed";
import { preferencesDraft } from "./preferencesView";
import { Action } from "./ui";
import { captureView, restoreView, startFresh } from "./updateView";

const preferences = new ScriptedPreferences();
const day = { ...openDay(), preferences: mirrorPreferences(preferences) };

const NEXT: PreferencesDemoNext[] = ["stale", "unknown", "reject"];

/** The unsaved preferences the last saved window kept. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Text testID="counts">{`Saves: ${preferences.saves()} · Checks: ${preferences.checks()}`}</Text>
			<Each of={NEXT} key={(n) => n}>
				{(n) => <Action label={`Next ${n()}`} onPress={() => preferences.next.set(n())} />}
			</Each>
			<Action label="Unreadable" onPress={() => preferences.mode.set("unreadable")} />
			<Action label="History pages of 2" onPress={() => preferences.page.set(2)} />
			<Action label="History fails" onPress={() => preferences.historyFails.set(true)} />
			<Action label="Empty project" onPress={() => preferences.empty()} />
			<Action
				label="Draft elsewhere"
				onPress={() =>
					preferencesDraft.set({
						projectId: "other-project",
						baseRevision: 1,
						entries: [{ key: "x", id: null, text: "Other project's words" }],
					})
				}
			/>
			<Action
				label="Save and reopen"
				onPress={() => {
					const v = captureView(day.today());
					kept.set((v.preferences ?? []).join(" | "));
					startFresh();
					restoreView(v, undefined, day.today(), false, true);
				}}
			/>
			<Text testID="kept">{`Kept: [${kept()}]`}</Text>
		</View>
		<MockDayScreen day={day} />
	</View>
));
