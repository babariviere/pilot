import type { MissionNonCodeDelivery, MissionNonCodeDeliveryReference } from "@pilot/protocol";

/** Parse untrusted input before resolving references. This is not acceptance. */
export function parseNonCodeDelivery(value: unknown): MissionNonCodeDelivery {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("delivery must be an object");
	const input = value as Record<string, unknown>;
	if (Object.keys(input).sort().join(",") !== "checks,kind,limitations,references" || input.kind !== "non-code")
		throw new Error("delivery requires kind non-code, references, checks and limitations only");
	if (typeof input.checks !== "string" || !input.checks.trim() || input.checks.length > 2000)
		throw new Error("checks must be nonempty and at most 2000 characters");
	if (typeof input.limitations !== "string" || input.limitations.length > 1000)
		throw new Error("limitations must be a string of at most 1000 characters");
	if (!Array.isArray(input.references) || !input.references.length || input.references.length > 20)
		throw new Error("references must contain 1 to 20 items");
	const references: MissionNonCodeDeliveryReference[] = input.references.map((value: unknown) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid reference");
		const item = value as Record<string, unknown>;
		if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) throw new Error("invalid revision");
		if (item.kind === "brief" && Object.keys(item).sort().join(",") === "kind,revision")
			return { kind: "brief", revision: item.revision as number };
		if (
			item.kind === "artifact" &&
			Object.keys(item).sort().join(",") === "artifactId,kind,revision" &&
			typeof item.artifactId === "string" &&
			item.artifactId.length > 0 &&
			item.artifactId.length <= 128 &&
			item.artifactId.trim() === item.artifactId
		)
			return { kind: "artifact", artifactId: item.artifactId, revision: item.revision as number };
		throw new Error("invalid reference");
	});
	if (new Set(references.map((item) => JSON.stringify(item))).size !== references.length)
		throw new Error("duplicate reference");
	return { kind: "non-code", references, checks: input.checks.trim(), limitations: input.limitations.trim() };
}
