// Mock data only: Settings opened at a target, as a task line's Change does. No service, provider or storage.
import { mount, signal, Text, View } from "nsh";
import { scrollOf } from "./kept";
import { MockDayScreen, openDay } from "./mockFeeds";
import type { ModelControls, ModelSettings } from "./modelControls";
import { modelSettingsDemo } from "./modelSettingsDemo";
import { goSettings } from "./nav";
import { ScriptedPreferences } from "./preferencesDemo";
import { mirrorPreferences } from "./preferencesFeed";
import { Action } from "./ui";

const settings = signal<ModelSettings | null>(modelSettingsDemo);
const models: ModelControls = {
	settings,
	busy: () => false,
	message: () => "",
	unknown: () => [],
	async read() {},
	async write(action, value) {
		if (action === "work-profiles") settings.set({ ...settings()!, profiles: value as ModelSettings["profiles"] });
		return true;
	},
	async check() {},
	async recovery() {
		return null;
	},
	async signIn() {
		return null;
	},
};
const day = { ...openDay(), preferences: mirrorPreferences(new ScriptedPreferences()), models };
const where = signal(-1);

mount(() => (
	<View class="flex-1">
		<View class="flex-row flex-wrap items-center gap-1 px-6 pt-2">
			<Action label="Change on a Cyber task" onPress={() => goSettings({ section: "models", profile: "cyber" })} />
			<Action label="Change on a task set by you" onPress={() => goSettings({ section: "models" })} />
			<Action label="Where" onPress={() => where.set(scrollOf("settings"))} />
			<Text>{`Scrolled: ${where() > 0 ? "yes" : where() === 0 ? "no" : "unknown"}`}</Text>
		</View>
		<MockDayScreen day={day} />
	</View>
));
