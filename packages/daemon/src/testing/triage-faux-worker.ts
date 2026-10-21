/** Fixture imports the production triage worker after installing a credential-free faux-only catalog. */
import { workerData } from "node:worker_threads";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

globalThis.fetch = () => {
	throw new Error("Triage accounting fixtures must stay offline");
};

const runtime = await ModelRuntime.create({
	authPath: `${workerData.agentDir}/faux-auth.json`,
	modelsPath: null,
	refreshOnCreate: false,
});
const faux = fauxProvider();
const answer = fauxAssistantMessage(workerData.malformed ? "not JSON" : '{"rules":[]}');
answer.usage.input = 11;
answer.usage.output = 7;
answer.usage.cost.total = 0.00001;
if (workerData.error) answer.stopReason = "error";
faux.setResponses([answer]);
runtime.registerNativeProvider(faux.provider);
runtime.getAvailable = async () => [faux.getModel()];
ModelRuntime.create = async () => runtime;
await import("../triage-model-worker.ts");
