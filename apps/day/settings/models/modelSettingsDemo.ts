// Mock data only: one AI settings read for fixtures. No service, credentials or providers.
import type { ModelSettings } from "./modelControls";

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
export const modelSettingsDemo: ModelSettings = {
	funding: {
		revision: 1,
		enabled: true,
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
	profiles: [
		{
			id: "backend",
			name: "Backend",
			covers: "Services, APIs and jobs.",
			optInOnly: false,
			large: [
				{ model: a.id, thinking: "medium" },
				{ model: plain.id, thinking: "off" },
			],
			small: [{ model: plain.id, thinking: "off" }],
		},
		{
			id: "cyber",
			name: "Cyber",
			covers: "Security work.",
			optInOnly: true,
			large: [{ model: "fixture/unlisted", thinking: "high" }],
			small: [{ model: "fixture/unlisted", thinking: "high" }],
		},
	],
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
