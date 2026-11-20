import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { FundingTokens } from "@pilot/protocol";
import { type FundingBound, installFundingRuntime } from "../funding/funding-runtime.ts";

/** Host receipt for one atomic reservation against both dedicated Insights allowances. */
export interface DayInsightsReservation {
	requestId: string;
	perReportReserved: true;
	monthlyReserved: true;
}
export interface DayInsightsRequestAdmission {
	reserve(id: string, model: Model<Api>, bound: FundingBound): Promise<DayInsightsReservation>;
	settle(id: string, usage: FundingTokens): Promise<void>;
}

/** Install only on the app-owned closed report runtime, never on source chats. No global-off bypass. */
export function installDayInsightsRuntime(runtime: ModelRuntime, admission: DayInsightsRequestAdmission): void {
	installFundingRuntime(runtime, {
		waitBeforeReserve: true,
		reserve: async (id, model, bound) => {
			if (!("outputTokens" in bound)) throw new Error("Insights allowance hold: verified request bound unavailable");
			const receipt = await admission.reserve(id, model, bound);
			if (
				!receipt ||
				receipt.requestId !== id ||
				receipt.perReportReserved !== true ||
				receipt.monthlyReserved !== true
			)
				throw new Error("Insights allowance hold: both reservations are required");
		},
		settle: (id, usage) => admission.settle(id, usage),
	});
}
