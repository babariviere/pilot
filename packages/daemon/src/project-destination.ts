/** Destination naming policy, independent of execution host and authentication provider. */
export const DEFAULT_PROJECT_DESTINATION_PATTERN = "~/src/{host}/{owner}/{repo}";
export interface RepositoryDestinationComponents {
	host: string;
	owner: string;
	repo: string;
}
export function projectDestination(
	components: RepositoryDestinationComponents,
	pattern = DEFAULT_PROJECT_DESTINATION_PATTERN,
): string {
	for (const [key, value] of Object.entries(components)) {
		if (
			typeof value !== "string" ||
			!/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,252}$/.test(value) ||
			value === "." ||
			value === ".."
		)
			throw new Error(`Invalid destination component: ${key}`);
	}
	if (
		pattern.length > 1024 ||
		!pattern.startsWith("~/") ||
		/[\x00-\x1f\x7f$`\\]/.test(pattern) ||
		pattern.split("/").some((p) => p === ".." || p === "." || p === "")
	)
		throw new Error("Invalid destination pattern");
	const value = pattern.replace(
		/\{(host|owner|repo)\}/g,
		(_, key: keyof RepositoryDestinationComponents) => components[key],
	);
	if (/[{}~]/.test(value.slice(2))) throw new Error("Unknown destination placeholder or unsafe expansion");
	return value;
}
