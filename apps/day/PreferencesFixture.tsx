// Headless fixture only. No daemon, worker, provider or storage. Settings
// over scripted project preferences (preferencesDemo.ts): `Next …` picks
// what the next Save does, "Save and reopen" keeps the window as a close or
// an update saves it and shows it again in a fresh window state, and
// "Draft elsewhere" leaves unsaved preferences for another project.
import { mount, signal, View } from "nsh";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import { captureView, restoreView, startFresh } from "./app/windowState";
import { type PreferencesDemoNext, ScriptedPreferences } from "./settings/preferencesDemo";
import { mirrorPreferences } from "./settings/preferencesFeed";
import { preferencesDraft } from "./settings/preferencesView";
import { scriptedSchedules } from "./settings/schedules/schedulesDemo";
import { Block, Button, Buttons, Caption } from "./ui";

const preferences = new ScriptedPreferences();
const day = { ...openDay(), preferences: mirrorPreferences(preferences), schedules: scriptedSchedules().controls };

const NEXT: PreferencesDemoNext[] = ["stale", "unknown", "reject"];

/** The unsaved preferences the last saved window kept. */
const kept = signal("");

mount(() => (
	<View class="flex-1">
		<Block>
			<Buttons>
				<Caption testID="counts">{`Saves: ${preferences.saves()} · Checks: ${preferences.checks()}`}</Caption>
				<Each of={NEXT} key={(n) => n}>
					{(n) => <Button small label={`Next ${n()}`} onPress={() => preferences.next.set(n())} />}
				</Each>
				<Button small label="Unreadable" onPress={() => preferences.mode.set("unreadable")} />
				{/* A read as Pilot starts one on its own (a change, the window coming back). */}
				<Button small label="Fixture read" onPress={() => void day.preferences.source.read()} />
				<Button small label="History pages of 2" onPress={() => preferences.page.set(2)} />
				<Button small label="History fails" onPress={() => preferences.historyFails.set(true)} />
				<Button small label="Empty project" onPress={() => preferences.empty()} />
				<Button
					small
					label="Draft elsewhere"
					onPress={() =>
						preferencesDraft.set({
							projectId: "other-project",
							baseRevision: 1,
							entries: [{ key: "x", id: null, text: "Other project's words" }],
						})
					}
				/>
				<Button
					small
					label="Save and reopen"
					onPress={() => {
						const v = captureView(day.today());
						kept.set((v.preferences ?? []).join(" | "));
						startFresh();
						restoreView(v, undefined, day.today(), false, true);
					}}
				/>
				<Caption testID="kept">{`Kept: [${kept()}]`}</Caption>
			</Buttons>
		</Block>
		<MockDayScreen day={day} />
	</View>
));
