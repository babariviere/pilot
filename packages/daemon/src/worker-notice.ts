/** Node's watch mode reports a worker's imported modules to the parent port. It is not a worker protocol reply. */
export function isWatchNotice(message: unknown): boolean {
	return (
		typeof message === "object" &&
		message !== null &&
		Array.isArray((message as { "watch:import"?: unknown })["watch:import"])
	);
}
