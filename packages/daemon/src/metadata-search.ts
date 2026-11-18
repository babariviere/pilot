/** Native title search over catalog rows and committed artifact pointers. No history or worker activity. */
import { createHash, randomUUID } from "node:crypto";
import type { ArtifactKind } from "@pilot/protocol";
import { ServiceUnavailable } from "./errors.ts";
import type { MissionStore } from "./missions.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

export const metadataSearchId = /^[A-Za-z0-9_-]{1,128}$/;
const artifactIdPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const artifactKinds = new Set<ArtifactKind>(["html", "react", "image", "swiftui", "shader", "visual", "nsh"]);
export const metadataSearchLimits = {
	// Bound synchronous row visits on the daemon request lane, even in profiles with years of history.
	catalogRows: 4096,
	// Cover a project with dozens of owners, with one inventory I/O sequence in flight per request.
	outputOwners: 32,
	// Allow about two candidates per palette hit (at most 256 KiB of pointers).
	// A warm local scan of 32 owners and 64 full-size pointers took 58 ms median.
	outputEntries: 64,
	// A 4096-pin synthetic catalog took ~100 ms for 4096 one-row probes. Keep this
	// separate from the bulk row budget to leave time for other daemon requests.
	pinProbes: 256,
	// Day's palette can show at most 30 work hits across all projects.
	results: 30,
};

// One bounded window and at most one open directory per search. Support a few overlapping
// searches, and release idle state even if the client disappears.
const MAX_SEARCHES = 8;
const CURSOR_IDLE_MS = 60_000;

type Missions = Pick<
	MissionStore,
	"durable" | "metadataSearchMissions" | "metadataSearchOutputLinks" | "metadataSearchPins"
>;
type Sessions = Pick<SessionManager, "metadataSearchSessions" | "metadataSearchArtifacts" | "ownsMetadataSession">;
type Link = ReturnType<Missions["metadataSearchOutputLinks"]>["rows"][number];
type Output = Omit<Link, "linkId"> & { kind: "output" };
type Item = { kind: "mission" | "chat"; id: string; title: string } | Output;
type Match<T extends Item = Item> = { item: T; title: string; rank: number };
type Candidate = { match: Match<Output>; link?: Link };
type SearchState = {
	scope: string;
	missions: Missions;
	sessions: Sessions;
	chats: ReturnType<Sessions["metadataSearchSessions"]>;
	chatsDone: boolean;
	missionBefore: number | null | undefined;
	linkBefore: number | null | undefined;
	owners: string[];
	ownerIndex: number;
	inventory?: NonNullable<ReturnType<Sessions["metadataSearchArtifacts"]>>;
	partial: boolean;
	matches: Match[];
	candidates: Candidate[];
	candidateIndex: number;
	probeAfter: number;
	bestPin?: Link;
};
const cursors = new Map<string, { state: SearchState; timer: ReturnType<typeof setTimeout> }>();
let active = 0;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const key = (row: Item) =>
	row.kind === "output" ? `output:${row.sessionId}:${row.artifactId}` : `${row.kind}:${row.id}`;
const newer = (a: Link, b: Link) =>
	a.revision > b.revision ||
	(a.revision === b.revision && (a.updatedAt > b.updatedAt || (a.updatedAt === b.updatedAt && a.linkId > b.linkId)));

function validPin(link: Link) {
	return (
		metadataSearchId.test(link.sessionId) &&
		artifactIdPattern.test(link.artifactId) &&
		artifactKinds.has(link.artifactKind) &&
		Number.isSafeInteger(link.revision) &&
		link.revision >= 1 &&
		Number.isSafeInteger(link.updatedAt) &&
		link.updatedAt >= 0
	);
}

async function closeSearch(state: SearchState) {
	await state.inventory?.close().catch(() => undefined);
}

export async function searchProjectMetadata(
	projects: Pick<ProjectStore, "require">,
	missions: Missions,
	sessions: Sessions,
	projectId: string,
	query: string,
	knownSecret: string,
	cursor?: string,
): Promise<{ projectId: string; items: Item[]; more: boolean; partial: boolean; nextCursor: string | null }> {
	projects.require(projectId);
	const q = query.toLowerCase();
	const scope = createHash("sha256")
		.update(JSON.stringify([projectId, q, knownSecret]))
		.digest("hex");
	let state: SearchState;
	if (cursor !== undefined) {
		const found = artifactIdPattern.test(cursor) ? cursors.get(cursor) : undefined;
		if (
			!found ||
			found.state.scope !== scope ||
			found.state.missions !== missions ||
			found.state.sessions !== sessions
		)
			throw new Error("Invalid or expired metadata search cursor; start a new search");
		state = found.state;
		cursors.delete(cursor);
		clearTimeout(found.timer);
	} else {
		if (active + cursors.size >= MAX_SEARCHES) {
			const oldest = cursors.entries().next().value;
			if (!oldest) throw new ServiceUnavailable("Metadata search is busy; try again");
			const [token, idle] = oldest;
			cursors.delete(token);
			clearTimeout(idle.timer);
			active++;
			try {
				await closeSearch(idle.state);
			} finally {
				active--;
			}
		}
		state = {
			scope,
			missions,
			sessions,
			chats: sessions.metadataSearchSessions(projectId),
			chatsDone: false,
			missionBefore: undefined,
			linkBefore: undefined,
			owners: [],
			ownerIndex: 0,
			partial: false,
			matches: [],
			candidates: [],
			candidateIndex: 0,
			probeAfter: 0,
		};
	}
	active++;
	let nextCursor: string | null = null;
	try {
		await missions.durable();
		projects.require(projectId);
		const { catalogRows, outputOwners, outputEntries, pinProbes, results } = metadataSearchLimits;
		const owns = (id: string) => sessions.ownsMetadataSession(projectId, id);
		const tokens = q.split(/\s+/u);
		const match = <T extends Item>(item: T): Match<T> | undefined => {
			// Leave out oversized titles rather than matching on a prefix clients cannot use as the title.
			if (
				!item.title.trim() ||
				Buffer.byteLength(item.title) > 640 ||
				(knownSecret && item.title.includes(knownSecret))
			)
				return;
			const title = item.title.toLowerCase();
			if (tokens.every((token) => title.includes(token)))
				return { item, title, rank: title === q ? 0 : title.startsWith(q) ? 1 : 2 };
		};

		// Drain this window before reading another. Rank the hits found so far, not the entire catalog.
		if (!state.matches.length && state.candidateIndex === state.candidates.length) {
			const candidates = new Map<string, Candidate>();
			const add = (item: Item) => {
				const hit = match(item);
				if (hit) state.matches.push(hit);
			};
			const addOutput = (item: Output, link?: Link) => {
				const hit = match(item);
				if (!hit) return;
				const id = key(item);
				const previous = candidates.get(id);
				if (!previous || (link && (!previous.link || newer(link, previous.link))))
					candidates.set(id, { match: hit, link });
			};
			if (state.missionBefore !== null) {
				const window = missions.metadataSearchMissions(projectId, catalogRows, state.missionBefore);
				state.missionBefore = window.next ?? null;
				for (const row of window.rows) if (metadataSearchId.test(row.id)) add({ kind: "mission", ...row });
			}
			if (state.linkBefore !== null) {
				const window = missions.metadataSearchOutputLinks(projectId, catalogRows, state.linkBefore);
				state.linkBefore = window.next ?? null;
				for (const link of window.rows) {
					if (!validPin(link) || !owns(link.sessionId)) continue;
					const { linkId: _, ...item } = link;
					addOutput({ kind: "output", ...item }, link);
				}
			}
			if (!state.chatsDone && state.ownerIndex === state.owners.length) {
				const window = state.chats(catalogRows);
				state.chatsDone = !window.more;
				state.ownerIndex = 0;
				state.owners = window.rows.map(({ id }) => id);
				for (const row of window.rows) if (owns(row.id)) add({ kind: "chat", ...row });
			}
			let remaining = outputEntries;
			for (
				let owners = 0;
				owners < outputOwners && remaining > 0 && state.ownerIndex < state.owners.length;
				owners++
			) {
				const id = state.owners[state.ownerIndex]!;
				if (!owns(id)) {
					await closeSearch(state);
					state.inventory = undefined;
				} else {
					state.inventory ??= sessions.metadataSearchArtifacts(projectId, id);
				}
				const inventory = await state.inventory?.read(remaining);
				if (inventory) {
					remaining -= inventory.visited;
					state.partial ||= inventory.partial;
					if (owns(id)) {
						for (const row of inventory.rows) {
							addOutput({
								kind: "output",
								artifactId: row.id,
								sessionId: id,
								title: row.title,
								artifactKind: row.kind,
								revision: row.revision,
								updatedAt: row.updatedAt,
							});
						}
					}
					if (inventory.more) break;
				}
				state.inventory = undefined;
				state.ownerIndex++;
			}
			state.candidates = [...candidates.values()];
			state.candidateIndex = 0;
		}

		// A pin in a later link window still takes priority over latest.json. Resolve the same
		// canonical pin on every page without keeping a set that grows with the whole catalog.
		let probes = pinProbes;
		while (probes > 0 && state.candidateIndex < state.candidates.length) {
			const candidate = state.candidates[state.candidateIndex]!;
			const { item } = candidate.match;
			if (owns(item.sessionId)) {
				const window = missions.metadataSearchPins(
					projectId,
					item.sessionId,
					item.artifactId,
					probes,
					state.probeAfter,
				);
				probes -= Math.max(1, window.visited);
				for (const link of window.rows)
					if (validPin(link) && (!state.bestPin || newer(link, state.bestPin))) state.bestPin = link;
				if (window.next !== undefined) {
					state.probeAfter = window.next;
					break;
				}
				if (state.bestPin?.linkId === candidate.link?.linkId) state.matches.push(candidate.match);
			}
			state.candidateIndex++;
			state.probeAfter = 0;
			state.bestPin = undefined;
		}
		projects.require(projectId);
		state.matches.sort((a, b) => a.rank - b.rank || compare(a.title, b.title) || compare(key(a.item), key(b.item)));
		const items = state.matches
			.splice(0, results)
			.map(({ item }) => item)
			.filter((item) => (item.kind === "output" ? owns(item.sessionId) : item.kind !== "chat" || owns(item.id)));
		const incomplete =
			!state.chatsDone ||
			state.missionBefore !== null ||
			state.linkBefore !== null ||
			state.ownerIndex < state.owners.length ||
			state.candidateIndex < state.candidates.length;
		if (incomplete || state.matches.length) {
			const token = randomUUID();
			const timer = setTimeout(() => {
				cursors.delete(token);
				active++;
				void closeSearch(state).finally(() => {
					active--;
				});
			}, CURSOR_IDLE_MS).unref();
			cursors.set(token, { state, timer });
			nextCursor = token;
		}
		return { projectId, items, more: nextCursor !== null, partial: incomplete || state.partial, nextCursor };
	} finally {
		try {
			if (nextCursor === null) await closeSearch(state);
		} finally {
			active--;
		}
	}
}
