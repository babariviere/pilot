/** Background completions share the same request ledger as chats, not a second usage sum. */
import { randomUUID } from "node:crypto";
import { fundingBound, fundingPayload, fundingUsage } from "../../kernel/src/funding-runtime.ts";
import { subscriptionLimitReport } from "../../kernel/src/subscription-limit.ts";
import type { BackgroundAttribution, CompletionRuntime } from "./background-usage.ts";
import type { Funding } from "./funding.ts";
import { fundingRequests } from "./funding-requests.ts";
import type { SharedCatalogService } from "./shared-model-catalog.ts";

export function fundingBackground(
	funding: Funding,
	catalog: SharedCatalogService,
	gate?: (provider: string) => Promise<void>,
	reportLimit?: (limit: { provider: "anthropic" | "openai"; resetsAt?: string }) => Promise<void>,
) {
	return (runtime: CompletionRuntime, purpose: string, attribution?: BackgroundAttribution): CompletionRuntime => ({
		completeSimple: async (model, context, options) => {
			const owner = attribution?.mission
				? { kind: "mission" as const, id: attribution.mission.missionId, projectId: attribution.projectId }
				: { kind: "background" as const, id: "daily", projectId: attribution?.projectId };
			const request = fundingRequests(funding, catalog, () => owner, purpose);
			let reserved: { id: string; provider: string; model: string } | undefined;
			const result = await runtime.completeSimple(model, context, {
				...options,
				maxRetries: 0,
				disableContinuation: true,
				onPayload: async (payload, physical) => {
					await gate?.(physical.provider);
					const single = fundingPayload(payload, physical);
					const final = (await options?.onPayload?.(single, physical)) ?? single;
					const id = randomUUID();
					await request(purpose, {
						op: "funding-reserve",
						namespace: "pi",
						key: id,
						value: {
							provider: physical.provider,
							model: physical.id,
							api: physical.api,
							...fundingBound(physical.api, final, physical.id, physical.maxTokens),
						},
					});
					options?.signal?.throwIfAborted();
					await gate?.(physical.provider);
					reserved = { id, provider: physical.provider, model: physical.id };
					return final;
				},
			});
			const evidence = fundingUsage(result);
			const limit = subscriptionLimitReport(result.errorMessage, reserved?.provider ?? model.provider);
			if (limit) await reportLimit?.(limit);
			if (reserved && evidence && result.provider === reserved.provider && result.model === reserved.model)
				await request(purpose, { op: "funding-settle", namespace: "pi", key: reserved.id, value: evidence });
			return result;
		},
	});
}
