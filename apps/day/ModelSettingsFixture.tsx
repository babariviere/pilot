// Mock data only. No service, credentials, providers or writes outside this window.
import { mount, Scroll, signal, Text, View } from "nsh";
import { ModelSettingsSection } from "./ModelSettings";
import type { ModelControls, ModelSettings, SignInView } from "./modelControls";
import { modelSettingsDemo } from "./modelSettingsDemo";
import { modelEdit, restoreModelDraft, savedModelDraft } from "./modelSettingsDraft";
import { Action, Page } from "./ui";

const initial = modelSettingsDemo;
const settings = signal<ModelSettings | null>(initial),
	busy = signal(false),
	message = signal("");
const unknown = signal<{ operationId: string }[]>([]),
	sends = signal(0),
	checks = signal(0),
	next = signal("");
const controls: ModelControls = {
	settings,
	busy,
	message,
	unknown,
	async read() {},
	async recovery() {
		return null;
	},
	async write(action, value, binding) {
		sends.set(sends() + 1);
		if (binding && binding !== settings()?.binding) {
			message.set("These settings changed. Read again; your edits stay here.");
			return false;
		}
		if (next() === "unknown") {
			next.set("");
			if (action === "sign-in")
				settings.set({
					...initial,
					runs: [{ id: "run", provider: "fixture", state: "waiting", reauthenticationRequired: false }],
				});
			unknown.set([{ operationId: "mock-operation" }]);
			message.set("This action is Unknown.");
			return false;
		}
		if (action === "sign-in")
			settings.set({
				...initial,
				runs: [{ id: "run", provider: "fixture", state: "waiting", reauthenticationRequired: false }],
			});
		if (action === "cancel" || action === "logout") settings.set({ ...initial, runs: [] });
		if (action === "defaults") settings.set({ ...initial, defaults: value as ModelSettings["defaults"] });
		if (action === "work-profiles") settings.set({ ...settings()!, profiles: value as ModelSettings["profiles"] });
		if (action === "funding-settings")
			settings.set({ ...settings()!, funding: { ...settings()!.funding!, ...(value as object) } });
		if (action === "funding-limits")
			settings.set({ ...settings()!, funding: { ...settings()!.funding!, enabled: value as boolean } });
		message.set("Saved.");
		return true;
	},
	async check() {
		checks.set(checks() + 1);
		unknown.set([]);
		message.set("Receipt found; nothing sent again.");
	},
	async signIn(run, action): Promise<SignInView | null> {
		if (action !== "read") {
			sends.set(sends() + 1);
			message.set("Sign-in could not be confirmed. Check sign-in; do not send the answer again.");
			return null;
		}
		return {
			run: { id: run, provider: "fixture", state: "waiting", reauthenticationRequired: false },
			challenge: { id: "challenge", type: "manual_code", url: "https://example.invalid/sign-in" },
		};
	},
};
const kept = signal("");
mount(() => (
	<Scroll class="flex-1 bg-background">
		<Page gap={4}>
			<Text>Mock data. AI settings behavior fixture.</Text>
			<View class="flex-row flex-wrap gap-2">
				<Action label="Next unknown" onPress={() => next.set("unknown")} />
				<Action label="Shared settings only" onPress={() => settings.set({ ...initial, project: null })} />
				<Action label="External edit" onPress={() => settings.set({ ...initial, binding: "b".repeat(64) })} />
				<Action
					label="SDK fallback"
					onPress={() =>
						settings.set({
							...initial,
							available: {
								...initial.available,
								defaultModel: "fixture/missing",
								resolvedDefaultModel: "fixture/plain",
							},
						})
					}
				/>
				<Action
					label="SDK outside scope"
					onPress={() =>
						settings.set({
							...initial,
							available: {
								...initial.available,
								defaultModel: "fixture/unlisted",
								resolvedDefaultModel: undefined,
							},
						})
					}
				/>
				<Action
					label="Unavailable"
					onPress={() => settings.set({ ...initial, project: { ...initial.project!, model: "fixture/missing" } })}
				/>
				<Action
					label="No reference"
					onPress={() =>
						settings.set({
							...initial,
							task: { models: [], priceCeiling: { limit: null, source: "unavailable" } },
						})
					}
				/>
				<Action
					label="Save and restore draft"
					onPress={() => {
						kept.set(savedModelDraft());
						restoreModelDraft("");
						restoreModelDraft(kept());
					}}
				/>
			</View>
			<Text testID="models-counts">{`Sends: ${sends()}, checks: ${checks()}`}</Text>
			<Text testID="models-kept">{kept()}</Text>
			<Text>{`Editing: ${modelEdit() ?? "none"}`}</Text>
			<ModelSettingsSection controls={controls} />
		</Page>
	</Scroll>
));
