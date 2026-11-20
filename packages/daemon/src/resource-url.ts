/** Mission resource links: URL validation and the tracker kinds Pilot recognizes. */
import type { MissionResourceKind, MissionResourceWrite } from "@pilot/protocol";
import { MISSION_STORE_LIMITS } from "@pilot/kernel/mission-write";
import { text } from "./validate.ts";

const MAX_URL = 2_048;
const MAX_LINEAR_KEY = 256;

/** Shared validation for saved resources and start references, before any side effects. */
export function normalizeResourceWrite(write: MissionResourceWrite) {
	if (!write || typeof write !== "object") throw new Error("Expected a resource object");
	const parsed = parseResourceUrl(text(write.url, "url", MAX_URL)!);
	if (write.linearRole !== undefined) {
		if (!["reference", "managed", "contribution"].includes(write.linearRole)) throw new Error("Invalid Linear role");
		if (parsed.kind !== "linear.issue") throw new Error("Linear roles require a Linear issue");
	}
	const title = text(write.title, "title", MISSION_STORE_LIMITS.title, { optional: true, empty: true }) || undefined;
	return { ...parsed, ...(title ? { title } : {}) };
}

/** A Linear issue identifier such as ENG-12, as a RegExp source. Stored linear_key values were made with it. */
export const LINEAR_ISSUE_ID = "[a-z0-9]+-[1-9]\\d*";
const issueId = new RegExp(`^${LINEAR_ISSUE_ID}$`, "i");

/** Workspace-scoped identifiers avoid collisions between Linear organizations. */
export function linearKey(url: string): string | undefined {
	const parts = new URL(url).pathname.split("/").filter(Boolean);
	if (!/^[a-z0-9][a-z0-9-]*$/i.test(parts[0] ?? "") || parts[1] !== "issue" || !issueId.test(parts[2] ?? ""))
		return undefined;
	const key = `${parts[0]!.toLowerCase()}/${parts[2]!.toUpperCase()}`;
	return key.length <= MAX_LINEAR_KEY ? key : undefined;
}

/** Recognize tracker links so later automation can act on them without a migration. */
export function parseResourceUrl(raw: string): { url: string; kind: MissionResourceKind; externalId?: string } {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error("url must be an absolute http(s) URL");
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("url must be an absolute http(s) URL");
	const parts = url.pathname.split("/").filter(Boolean);
	const href = url.toString();
	if (url.hostname === "linear.app") {
		if (parts[1] === "issue" && parts[2])
			return { url: href, kind: "linear.issue", externalId: parts[2].toUpperCase() };
		if (parts[1] === "project" && parts[2]) return { url: href, kind: "linear.project", externalId: parts[2] };
	}
	if (url.hostname === "github.com" && parts.length >= 4 && /^\d+$/.test(parts[3]!)) {
		const id = `${parts[0]}/${parts[1]}#${parts[3]}`;
		if (parts[2] === "pull")
			return {
				url: `https://github.com/${parts[0]}/${parts[1]}/pull/${Number(parts[3])}`,
				kind: "github.pr",
				externalId: id,
			};
		if (parts[2] === "issues") return { url: href, kind: "github.issue", externalId: id };
	}
	if (url.hostname.endsWith(".slack.com") && parts[0] === "archives" && parts[1] && /^p\d{16}$/.test(parts[2] ?? "")) {
		const ts = parts[2]!.slice(1);
		return { url: href, kind: "slack.thread", externalId: `${parts[1]}/${ts.slice(0, 10)}.${ts.slice(10)}` };
	}
	return { url: href, kind: "url" };
}
