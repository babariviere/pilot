/** Catalog-value funding. These amounts are not provider bills or subscription balances. */
export type FundingKind = "mission" | "quick_fix" | "background";
export interface FundingOwner {
	kind: FundingKind;
	id: string;
	projectId?: string;
}
export interface FundingAccount extends FundingOwner {
	limitMicros: number | null;
	spentMicros: number;
	uncertainMicros: number;
	remainingMicros: number | null;
	heldMaximumMicros?: number;
}
export interface FundingView {
	revision: number;
	/** False when the user turned spending limits off for every project. Nothing reserves or refuses for cost. */
	enabled: boolean;
	missionDefaultMicros: number | null;
	quickFixDefaultMicros: number | null;
	dailyMicros: number | null;
	resetAt: string;
	background: FundingAccount;
	accounts: FundingAccount[];
	accountCount: number;
	backgroundJobs?: { job: string; projectId: string | null; spentMicros: number; uncertainMicros: number }[];
}
export interface FundingRate {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}
export interface FundingTokens extends FundingRate {
	cacheWrite1h?: number;
}
export interface FundingQuote {
	provider: string;
	model: string;
	inputTokens: number;
	outputTokens: number;
	rate: FundingRate;
	tiers?: { inputTokensAbove: number; rate: FundingRate }[];
}
