/** Run the production worker and IPC loop with an offline model. */
import assert from "node:assert/strict";
import { join } from "node:path";
import {
	fauxAssistantMessage,
	fauxProvider,
	InMemoryCredentialStore,
	InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { NativeAdapter } from "../native-adapter.ts";
import { runKernelWorker } from "../worker.ts";

globalThis.fetch = () => assert.fail("The Day Insights fixture must not use the network");
const runtime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
	modelsStore: new InMemoryModelsStore(),
	allowModelNetwork: false,
	refreshOnCreate: false,
});
const faux = fauxProvider({ provider: "synthetic", models: [{ id: "terra", reasoning: true }] });
runtime.registerNativeProvider(faux.provider);
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
