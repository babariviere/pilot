/** Run the production worker and IPC loop with an offline model. */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter } from "../native-adapter.ts";
import { runKernelWorker } from "../worker.ts";
import { offlineModels } from "./offline-models.ts";

globalThis.fetch = () => assert.fail("The Day Insights fixture must not use the network");
const { models: runtime, faux } = await offlineModels({
	provider: "synthetic",
	models: [{ id: "terra", reasoning: true }],
});
faux.setResponses([fauxAssistantMessage("Synthetic Day report turn finished.")]);

const open = NativeAdapter.open;
NativeAdapter.open = (options) =>
	open({
		...options,
		agentDir: join(options.cwd, "..", "synthetic-agent"),
		settingsManager: SettingsManager.inMemory({ defaultTools: [] }),
		sessionOptions: { ...options.sessionOptions, modelRuntime: runtime, model: faux.getModel() },
	});
runKernelWorker();
