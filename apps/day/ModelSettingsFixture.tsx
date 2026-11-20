// Mock data only. No service, credentials, providers or writes outside this window.
// The AI and Allowances tabs of Settings on one panel, as the behaviour tests need both.
import { mount, Scroll, signal } from "nsh";
import { FundingSettings } from "./FundingSettings";
import { ModelSettingsSection } from "./ModelSettings";
import type { ModelControls, ModelSettings, SignInView } from "./modelControls";
import { modelSettingsDemo } from "./modelSettingsDemo";
import { modelEdit, restoreModelDraft, savedModelDraft } from "./modelSettingsDraft";
import { Block, Button, Buttons, Caption, Column, Page, Panel } from "./ui";

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
	<Scroll class="flex-1">
		<Page width="form">
			<Block>
				<Caption>Mock data. AI settings behavior fixture.</Caption>
				<Buttons>
					<Button label="Next unknown" onPress={() => next.set("unknown")} />
					<Button label="Shared settings only" onPress={() => settings.set({ ...initial, project: null })} />
					<Button label="External edit" onPress={() => settings.set({ ...initial, binding: "b".repeat(64) })} />
					<Button
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
					<Button
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
					<Button
						label="Unavailable"
						onPress={() =>
							settings.set({ ...initial, project: { ...initial.project!, model: "fixture/missing" } })
						}
					/>
					<Button
						label="No reference"
						onPress={() =>
							settings.set({
								...initial,
								task: { models: [], priceCeiling: { limit: null, source: "unavailable" } },
							})
						}
					/>
					<Button
						label="Save and restore draft"
						onPress={() => {
							kept.set(savedModelDraft());
							restoreModelDraft("");
							restoreModelDraft(kept());
						}}
					/>
				</Buttons>
				<Caption testID="models-counts">{`Sends: ${sends()}, checks: ${checks()}`}</Caption>
				<Caption testID="models-kept">{kept()}</Caption>
				<Caption>{`Editing: ${modelEdit() ?? "none"}`}</Caption>
			</Block>
			<Panel>
				<Column>
					<ModelSettingsSection controls={controls} />
					<FundingSettings controls={controls} />
				</Column>
			</Panel>
		</Page>
	</Scroll>
));
