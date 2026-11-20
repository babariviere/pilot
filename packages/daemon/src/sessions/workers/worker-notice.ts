/**
 * Node's watch mode reports a worker's module graph to the parent port. It is not a worker protocol reply.
 * Node posts more than one notice kind: `watch:import` for the module graph and `watch:require` for each
 * resolved specifier. A notice that is not recognised would be taken for the worker's answer, so the whole
 * `watch:` family is ignored.
 */
export function isWatchNotice(message: unknown): boolean {
	if (typeof message !== "object" || message === null) return false;
	return Object.keys(message).some((key) => key.startsWith("watch:"));
}
