/** Models offered to clients: the user's pi model scope (`enabledModels`), else every authenticated model. */
import { join } from "node:path";
import {
	getAgentDir,
	ModelRuntime,
	resolveModelScopeWithDiagnostics,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type { ModelList, ModelOption } from "@pilot/protocol";

const TTL_MS = 60_000;

export class ModelCatalog {
	private runtime?: Promise<ModelRuntime>;
	private readonly cache = new Map<string, { at: number; list: Promise<ModelList> }>();

	constructor(private readonly agentDir = getAgentDir()) {}

	/** Scope and default follow pi's settings for `cwd` (global plus project settings). */
	list(cwd: string): Promise<ModelList> {
		const cached = this.cache.get(cwd);
		if (cached && Date.now() - cached.at < TTL_MS) return cached.list;
		const list = this.load(cwd);
		this.cache.set(cwd, { at: Date.now(), list });
		list.catch(() => this.cache.delete(cwd));
		return list;
	}

	private async load(cwd: string): Promise<ModelList> {
		this.runtime ??= ModelRuntime.create({
			authPath: join(this.agentDir, "auth.json"),
			modelsPath: join(this.agentDir, "models.json"),
			allowModelNetwork: false,
		});
		const runtime = await this.runtime;
		const settings = SettingsManager.create(cwd, this.agentDir);
		const provider = settings.getDefaultProvider();
		const model = settings.getDefaultModel();
		const defaultModel = provider && model ? `${provider}/${model}` : model;
		const patterns = settings.getEnabledModels();
		let models: ModelOption[];
		if (patterns?.length) {
			const { scopedModels } = await resolveModelScopeWithDiagnostics(patterns, runtime);
			models = scopedModels.map(({ model, thinkingLevel }) => option(model, thinkingLevel));
		} else {
			models = (await runtime.getAvailable()).map((model) => option(model));
		}
		const seen = new Set<string>();
		models = models.filter((entry) => !seen.has(entry.id) && seen.add(entry.id));
		return { models, ...(defaultModel ? { defaultModel } : {}) };
	}
}

function option(
	model: { provider: string; id: string; name?: string; reasoning?: boolean },
	thinking?: string,
): ModelOption {
	return {
		id: `${model.provider}/${model.id}`,
		provider: model.provider,
		name: model.name || model.id,
		...(model.reasoning ? { reasoning: true } : {}),
		...(thinking ? { thinking } : {}),
	};
}
