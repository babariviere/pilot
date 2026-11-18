/** Canonical pricing and caller attribution for inherited worker capabilities. */
import type { CredentialRequest } from "@pilot/kernel/credential-rpc";
import { modelLimitedOutputApis } from "../../kernel/src/funding-runtime.ts";
import type { FundingOwner, FundingRate } from "../../protocol/src/funding.ts";
import type { Funding } from "./funding.ts";
import type { SharedCatalogService } from "./shared-model-catalog.ts";

export function fundingRequests(
	funding: Funding,
	catalog: Pick<SharedCatalogService, "fundingModel">,
	owner: (session: string) => FundingOwner,
	job = "agent",
) {
	return async (session: string, request: CredentialRequest) => {
		const scope = owner(session);
		if (!request.key || !/^[A-Za-z0-9_-]{1,128}$/.test(request.key)) throw new Error("Invalid request identity");
		if (request.op === "funding-settle")
			return funding.skipped(request.key)
				? undefined
				: funding.settle(scope, request.key, request.value as FundingRate);
		// Limits off: no price lookup, reservation or refusal. Subscription holds are checked elsewhere.
		if (!(await funding.enabled())) return funding.skip(request.key);
		const p = request.value as { provider: string; model: string; api: string; outputTokens: number; hold?: unknown };
		// Limits on: a request without a verified output bound is held, with the worker's reason when it gave one.
		if (p && p.outputTokens === undefined && typeof p.hold === "string")
			throw new Error(
				p.hold.startsWith("Allowance hold:") ? p.hold.slice(0, 200) : "Allowance hold: request bound unavailable",
			);
		if (
			!p ||
			typeof p.provider !== "string" ||
			typeof p.model !== "string" ||
			!Number.isSafeInteger(p.outputTokens) ||
			p.outputTokens < 1
		)
			throw new Error("Invalid request bound");
		const model = await catalog.fundingModel(p.provider, p.model);
		if (
			!model ||
			(model.type && model.type !== "chat") ||
			!("contextWindow" in model) ||
			!("maxTokens" in model) ||
			model.api !== p.api ||
			p.outputTokens > model.maxTokens
		)
			throw new Error("Physical model bound unavailable");
		const convert = (cost: typeof model.cost) =>
			Object.fromEntries(
				(["input", "output", "cacheRead", "cacheWrite"] as const).map((k) => {
					const rates = [cost[k]];
					if (
						rates.some(
							(r) =>
								typeof r !== "number" ||
								!Number.isFinite(r) ||
								r < 0 ||
								((k === "input" || k === "output") && r === 0),
						)
					)
						throw new Error("Catalog prices unavailable");
					return [k, Math.ceil(Math.max(...rates) * 1_000_000)];
				}),
			) as unknown as FundingRate;
		const rate = convert(model.cost);
		const tiers = model.cost.tiers?.map((t) => ({ inputTokensAbove: t.inputTokensAbove, rate: convert(t) }));
		if (JSON.stringify(owner(session)) !== JSON.stringify(scope)) throw new Error("Funding owner changed");
		const receipt = await funding.reserve(
			scope,
			request.key,
			{
				provider: p.provider,
				model: p.model,
				inputTokens: model.contextWindow,
				// No request cap exists here: reserve the canonical model maximum, whatever the worker reported.
				outputTokens: modelLimitedOutputApis.has(model.api) ? model.maxTokens : p.outputTokens,
				rate,
				tiers,
			},
			job,
		);
		if (JSON.stringify(owner(session)) !== JSON.stringify(scope))
			throw new Error("Funding authority changed before dispatch");
		return receipt;
	};
}
