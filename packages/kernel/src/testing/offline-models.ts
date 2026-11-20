/** Offline model runtime with one faux provider: no credentials, model files or network. */
import { fauxProvider, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

export async function offlineModels(options?: Parameters<typeof fauxProvider>[0]) {
	const models = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		modelsStore: new InMemoryModelsStore(),
		allowModelNetwork: false,
		refreshOnCreate: false,
	});
	const faux = fauxProvider(options);
	models.registerNativeProvider(faux.provider);
	return { models, faux };
}
