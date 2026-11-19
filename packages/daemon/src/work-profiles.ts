/** How Pilot picks a start model from work profiles, and how the mission page explains it. */
import type {
	MissionPlan,
	MissionTask,
	ModelRoute,
	ProfileModel,
	Project,
	TaskModelRoute,
	WorkProfile,
	WorkSize,
} from "@pilot/protocol";

/**
 * The profiles a project allows: exactly its edited list, so a profile added later is off there. A project never
 * edited allows every profile that is not opt-in only.
 */
export function allowedProfiles(
	profiles: readonly WorkProfile[],
	project: Pick<Project, "profilesEdited" | "allowedProfiles">,
): WorkProfile[] {
	if (project.profilesEdited) return profiles.filter((p) => project.allowedProfiles?.includes(p.id));
	return profiles.filter((p) => !p.optInOnly);
}

/**
 * The profile and size a published plan gave a task's slice. Old plans name owners and no size: they count as large
 * and have no profile.
 */
export function sliceRoute(
	plan: MissionPlan | undefined,
	taskId: string,
): { profile?: string; size: WorkSize } | undefined {
	const sliceId = plan?.publication?.tasks.find((t) => t.taskId === taskId)?.sliceId;
	const slice = sliceId === undefined ? undefined : plan?.slices.find((s) => s.id === sliceId);
	if (!slice) return undefined;
	return { ...(slice.profile ? { profile: slice.profile } : {}), size: slice.size ?? "large" };
}

/** What Pilot knows about each model right now. In memory only: no provider call. */
export interface ModelState {
	signedIn(model: string): boolean;
	/** Rate-limited or out of quota, from the saved limit state. */
	limited(model: string): boolean;
	/** The user's chats on this model that work right now. */
	working(model: string): number;
	name(model: string): string;
}

export type ProfilePick =
	| { entry: ProfileModel; route: ModelRoute }
	| { entry?: undefined; route: ModelRoute & { source: "default"; reason: string } };

/**
 * The entry with the fewest working chats, skipping models that are not signed in or at their limit. A tie goes to
 * the first in list order. With every entry skipped, the default model starts and the route says why.
 */
export function pickProfileModel(
	profile: WorkProfile,
	size: WorkSize,
	state: ModelState,
	source: "profile" | "cyber" = "profile",
): ProfilePick {
	const base = { profile: { id: profile.id, name: profile.name }, size };
	const entries = profile[size];
	const usable = entries.filter((e) => state.signedIn(e.model) && !state.limited(e.model));
	if (!usable.length) {
		const reason = !entries.length
			? `${profile.name} has no ${size} models`
			: entries.every((e) => !state.signedIn(e.model))
				? `no ${profile.name} ${size} model is signed in`
				: `every ${profile.name} ${size} model is signed out or at its limit`;
		return { route: { source: "default", ...base, reason } };
	}
	let best = usable[0]!;
	for (const e of usable) if (state.working(e.model) < state.working(best.model)) best = e;
	const first = entries[0]!;
	const route: ModelRoute = { source, ...base };
	if (best !== first) {
		if (usable.includes(first)) route.busier = first.model;
		else
			route.reason = state.signedIn(first.model)
				? `${state.name(first.model)} is at its limit`
				: `${state.name(first.model)} is not signed in`;
	}
	return { entry: best, route };
}

/**
 * The mission page line for a task: the route its chat recorded, else how its next start would pick, in the same
 * order as the start. Undefined: the default model, for no reason worth showing.
 */
export function taskModelRoute(
	task: Pick<MissionTask, "id" | "preferredModel" | "preferredModelSetBy">,
	chat: { model?: string; modelRoute?: ModelRoute } | undefined,
	next: () => { model?: string; route: ModelRoute } | undefined,
	state: Pick<ModelState, "name">,
): TaskModelRoute | undefined {
	const line = (model: string | undefined, route: ModelRoute): TaskModelRoute | undefined =>
		model
			? {
					taskId: task.id,
					model,
					modelName: state.name(model),
					...route,
					...(route.busier ? { busierName: state.name(route.busier) } : {}),
				}
			: undefined;
	if (chat?.modelRoute) return line(chat.model, chat.modelRoute);
	if (chat) return undefined;
	if (task.preferredModel)
		return line(task.preferredModel, { source: task.preferredModelSetBy === "user" ? "user" : "coordinator" });
	const planned = next();
	if (!planned || (planned.route.source === "default" && !planned.route.reason)) return undefined;
	return line(planned.model ?? "", planned.route);
}

/** The provider error that blocks a turn as cyber work. Matched exactly, never guessed from other failures. */
export const CYBER_BLOCK = "Cyber safeguards flagged this message";

export function isCyberBlock(outcomeReason: string | undefined): boolean {
	return !!outcomeReason?.includes(CYBER_BLOCK);
}

/** Whether a model is in any of the profile's lists. */
export function profileHasModel(profile: WorkProfile, model: string | undefined): boolean {
	return !!model && [...profile.large, ...profile.small].some((e) => e.model === model);
}
