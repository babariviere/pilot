import { PiReload } from "../pi-reload.ts";
import type { SessionManager } from "../sessions.ts";

/** Offline server fixtures keep the same multi-listener and bridge ownership contracts as sessions. */
export function sessionObservers() {
	const changes = new Set<Parameters<SessionManager["onChange"]>[0]>();
	const artifacts = new Set<Parameters<SessionManager["onArtifactsChanged"]>[0]>();
	const reviews = new Set<() => void>();
	const power = new Set<() => void>();
	let bridge: Parameters<SessionManager["setPlanningBridge"]>[0] | undefined;
	return {
		piReload: new PiReload<never>(
			() => false,
			async () => {
				throw new Error("No fixture worker to reload");
			},
		),
		onChange: ((listener) => {
			changes.add(listener);
			return () => {
				changes.delete(listener);
			};
		}) satisfies SessionManager["onChange"],
		onArtifactsChanged: ((listener) => {
			artifacts.add(listener);
			return () => {
				artifacts.delete(listener);
			};
		}) satisfies SessionManager["onArtifactsChanged"],
		onInsightsReviewChange: ((listener) => {
			reviews.add(listener);
			return () => {
				reviews.delete(listener);
			};
		}) satisfies SessionManager["onInsightsReviewChange"],
		onPowerResume: ((listener) => {
			power.add(listener);
			return () => {
				power.delete(listener);
			};
		}) satisfies SessionManager["onPowerResume"],
		setPlanningBridge: ((next) => {
			if (bridge) throw new Error("Planning bridge already installed in fixture");
			bridge = next;
			return () => {
				if (bridge === next) bridge = undefined;
			};
		}) satisfies SessionManager["setPlanningBridge"],
		emit(session: Parameters<Parameters<SessionManager["onChange"]>[0]>[0]) {
			for (const listener of changes) listener(session);
			if (session.role === "insights" && !session.working) for (const listener of reviews) listener();
		},
	};
}
