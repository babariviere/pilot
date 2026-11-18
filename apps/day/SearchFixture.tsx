// Real Day screens over synthetic search and app feeds.
import { mount } from "nsh";
import { MockDayScreen } from "./mockFeeds";
import { day, plans } from "./mockSession";
import type { SearchHit } from "./workSearch";

const projects = [
	{ id: "atlas", name: "Atlas" },
	{ id: "harbor", name: "Harbor" },
];
const title = "Export comparison";
const hits: SearchHit[] = [
	{
		kind: "output",
		title,
		projectId: "harbor",
		projectName: "Harbor",
		key: "output:harbor:comparison",
		target: { sessionId: "agent", artifactId: "comparison", title, kind: "html", revision: 3, updatedAt: 1 },
	},
	{
		kind: "chat",
		title: "Export checks",
		projectId: "atlas",
		projectName: "Atlas",
		key: "chat:atlas:checks",
		target: "checks",
	},
];
day.search = {
	async read(query, projectId, cursor) {
		if (query === "offline") return null;
		if (query === "old" && projectId === "harbor") {
			return {
				projects,
				hits: cursor ? [hits[0]!] : [],
				partial: false,
				more: !cursor,
				nextCursor: cursor ? null : "older",
			};
		}
		return {
			projects,
			hits: query
				? hits.filter(
						(hit) => (!projectId || hit.projectId === projectId) && hit.title.toLowerCase().includes(query),
					)
				: [],
			partial: false,
			more: false,
		};
	},
	async output(hit) {
		const { sessionId, artifactId, kind } = hit.target;
		return {
			status: "shown",
			artifact: {
				version: 1,
				rendering: "unsupported",
				reference: { sourceSessionId: sessionId, artifactId, revision: 3 },
				metadata: { title, kind },
				content: { state: "text", source: "Before: B, A. After: A, B.", containerSha256: "", containerBytes: 23 },
			},
		};
	},
	async knowledge() {
		return null;
	},
};
mount(() => <MockDayScreen day={day} plans={plans} />);
