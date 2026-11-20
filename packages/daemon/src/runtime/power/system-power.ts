/** Private authenticated helper frames, not a client API. Unknown power state fails closed. */
export interface SystemPowerState {
	available: boolean;
	sleepAt?: number;
	wakeToken?: string;
	fullWake: boolean;
}
export interface SystemPowerSource {
	subscribePower(listener: (state: SystemPowerState) => void): () => void;
	setPowerActive(active: boolean): void;
}
export function parseSystemPowerState(value: unknown): SystemPowerState | undefined {
	if (!value || typeof value !== "object") return;
	const v = value as SystemPowerState & { type?: string };
	if (
		v.type !== "power" ||
		typeof v.available !== "boolean" ||
		typeof v.fullWake !== "boolean" ||
		(v.sleepAt !== undefined && (!Number.isFinite(v.sleepAt) || v.sleepAt < 0)) ||
		(v.wakeToken !== undefined && (typeof v.wakeToken !== "string" || !/^\d+:\d{1,6}$/.test(v.wakeToken)))
	)
		return;
	return { available: v.available, sleepAt: v.sleepAt, wakeToken: v.wakeToken, fullWake: v.available && v.fullWake };
}
