export class NotFound extends Error {}

export class ServiceUnavailable extends Error {}
export class Conflict extends Error {}

/** Pilot refused a planning input before sending it to the planner's chat: the planner never saw it. */
export class PlanningInputNotSent extends Conflict {
	constructor(cause: unknown) {
		super(cause instanceof Error ? cause.message : String(cause), { cause });
	}
}
