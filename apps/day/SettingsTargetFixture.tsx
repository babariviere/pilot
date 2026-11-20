// Mock data only: Settings opened at a target, as a task line's Change does. No service, provider or storage.
import { mount, signal, View } from "nsh";
import { scrollOf } from "./app/kept";
import { goSettings } from "./app/nav";
import { MockDayScreen, openDay } from "./app/testing/mockFeeds";
import type { ConnectionControls } from "./settings/connections/connectionControls";
import type { DiagnosisControls } from "./settings/diagnostics/diagnosisControls";
import type { ModelControls, ModelSettings } from "./settings/models/modelControls";
import { modelSettingsDemo } from "./settings/models/modelSettingsDemo";
import { ScriptedPreferences } from "./settings/preferencesDemo";
import { mirrorPreferences } from "./settings/preferencesFeed";
import { Block, Button, Buttons, Caption } from "./ui";

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
// Unread stubs, so Settings shows all its tabs: their sections say they could not read.
const connections: ConnectionControls = {
	snapshot: () => null,
	busy: () => false,
	message: () => "",
	unknown: () => [],
	async read() {},
	async probe() {},
	async write() {
		return false;
	},
	async check() {},
};
const diagnosis: DiagnosisControls = {
	snapshot: () => null,
	busy: () => false,
	message: () => "",
	operations: () => [],
	async read() {},
	async write() {
		return { accepted: false };
	},
	async check() {},
};
const day = {
	...openDay(),
	preferences: mirrorPreferences(new ScriptedPreferences()),
	models,
	connections,
	diagnosis,
};
const where = signal(-1);

mount(() => (
	<View class="flex-1">
		<Block>
			<Buttons>
				<Button
					small
					label="Change on a Cyber task"
					onPress={() => goSettings({ section: "models", profile: "cyber" })}
				/>
				<Button small label="Change on a task set by you" onPress={() => goSettings({ section: "models" })} />
				<Button small label="Where" onPress={() => where.set(scrollOf("settings"))} />
				<Caption>{`Scrolled: ${where() > 0 ? "yes" : where() === 0 ? "no" : "unknown"}`}</Caption>
			</Buttons>
		</Block>
		<MockDayScreen day={day} />
	</View>
));
