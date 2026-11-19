/** How much a slice of work needs: large for risky, cross-cutting or design-heavy work, small for contained work. */
export type WorkSize = "large" | "small";

/** One model a work profile may start, with its own thinking level. */
export interface ProfileModel {
	/** "provider/modelId". */
	model: string;
	thinking: string;
}

/**
 * A kind of work and the models that do it. Pilot keeps the list in Pi's agent settings.json under
 * `pilotWorkProfiles`. A profile's models only have to be signed in: they do not need to be in enabledModels.
 */
export interface WorkProfile {
	/** Stable lowercase key, such as "backend" or "cyber". Plans and projects name profiles by it. */
	id: string;
	name: string;
	/** One line that says which work the profile covers. The planner reads it. */
	covers: string;
	/** Off in every project until the user allows it there. */
	optInOnly: boolean;
	/** In order of preference. Pilot starts the one with the fewest working chats; ties go to the first. */
	large: ProfileModel[];
	small: ProfileModel[];
}

/** Why a start used the model it did. Recorded on the chat and shown on the mission page. */
export interface ModelRoute {
	/**
	 * user and coordinator: a model set on the task. profile: the slice's profile. default: the default model.
	 * cyber: Pilot sent a blocked turn again with the Cyber profile.
	 */
	source: "user" | "coordinator" | "profile" | "default" | "cyber";
	profile?: { id: string; name: string };
	size?: WorkSize;
	/** The first entry's model, when Pilot took a later one because the first had more working chats. */
	busier?: string;
	/** default: why no profile model started, such as "no Backend model is signed in". */
	reason?: string;
}

/** How a task's chat got, or its next start gets, its model. Shown on the mission page. */
export interface TaskModelRoute extends ModelRoute {
	taskId: string;
	/** "provider/modelId". */
	model: string;
	/** The model's display name, or its ID when it is not signed in. */
	modelName: string;
	/** The display name of `busier`. */
	busierName?: string;
}
