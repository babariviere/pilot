// Mock data only. No service, credentials, providers or writes outside this window.
import { mount, Scroll, signal, Text, View } from "nsh";
import { ModelSettingsSection } from "./ModelSettings";
import type { ModelControls, ModelSettings, SignInView } from "./modelControls";
import { modelEdit, restoreModelDraft, savedModelDraft } from "./modelSettingsDraft";
import { Action, PAGE_COLUMN } from "./ui";

const a = {
	id: "fixture/reasoner",
	provider: "fixture",
	name: "Reasoner",
	thinkingLevels: ["off", "low", "high"],
	defaultThinking: "high",
	taskDefaultThinking: "low",
	modelChangeThinking: "low",
};
const plain = {
	id: "fixture/plain",
	provider: "fixture",
	name: "Plain",
	thinkingLevels: ["off"],
	defaultThinking: "off",
	taskDefaultThinking: "off",
	modelChangeThinking: "off",
};
const initial: ModelSettings = {
	funding: {
		revision: 1,
		missionDefaultMicros: 20_000_000,
		quickFixDefaultMicros: 5_000_000,
		dailyMicros: 1_000_000,
		resetAt: "2026-11-17T00:00:00.000Z",
		background: {
			kind: "background",
			id: "day",
			limitMicros: 1_000_000,
			spentMicros: 200_000,
			uncertainMicros: 300_000,
			remainingMicros: 500_000,
		},
		accounts: [
			{
				kind: "mission",
				id: "sample-mission",
				projectId: "sample",
				limitMicros: 10_000_000,
				spentMicros: 2_000_000,
				uncertainMicros: 1_000_000,
				remainingMicros: 7_000_000,
			},
		],
		accountCount: 1,
	},
	fundedWork: [
		{
			id: "chat",
			title: "Improve the parser",
			owner: { kind: "mission", id: "sample-mission", projectId: "sample" },
			subscription: { windows: [{ label: "Week", usedPercent: 99 }] },
		},
	],
	version: 1,
	binding: "a".repeat(64),
	defaults: {
		defaultProvider: "fixture",
		defaultModel: "reasoner",
		defaultThinkingLevel: null,
		pilotTaskPriceLimit: null,
	},
	project: { id: "sample", name: "Sample project", model: null },
	scope: {
		enabledModels: ["fixture/reasoner:low", "fixture/plain"],
		candidates: [a, plain],
		projectOverride: null,
		resolution: [],
	},
	available: { models: [a, plain], defaultModel: a.id, resolvedDefaultModel: a.id },
	task: {
		models: [a, plain],
		defaultModel: a.id,
		resolvedDefaultModel: a.id,
		priceCeiling: { limit: 30, source: "reference" },
	},
	providers: [{ id: "fixture", name: "Sample provider", credential: "missing", methods: ["manual_code"] }],
	runs: [],
};
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
		if (action === "funding-settings")
			settings.set({ ...settings()!, funding: { ...settings()!.funding!, ...(value as object) } });
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
		<View class={`${PAGE_COLUMN} gap-4`}>
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
		</View>
	</Scroll>
));
