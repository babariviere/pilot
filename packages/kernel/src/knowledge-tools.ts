/** The `knowledge` tool: project-owned research and component documentation, kept by pilotd. */
import type { JsonValue } from "@earendil-works/chord";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "./schema.ts";

export const KNOWLEDGE_ACTIONS = [
	"list",
	"get",
	"revisions",
	"create",
	"append",
	"link",
	"unlink",
	"observe",
	"check",
	"batch",
] as const;
export type KnowledgeAction = (typeof KNOWLEDGE_ACTIONS)[number];
export type KnowledgeCall = (
	action: KnowledgeAction,
	args: Record<string, JsonValue>,
	operationId?: string,
) => Promise<JsonValue>;

export function createKnowledgeTool(call: KnowledgeCall): ToolDefinition {
	return defineTool({
		name: "knowledge",
		label: "Project knowledge",
		description: `This project's lasting research (investigation) and component documentation. Entries keep full history; missions link entries, never copy them.
- list: newest first (25, max 50); filter kind, q (literal title/synopsis text), check "needs_check", linked (this mission's links); pass cursor for more.
- get: id, optional revision. revisions: id, cursor.
- create: kind, title, synopsis, body, sources, optional taskId. append: id, expectedRevision, reason plus the complete new title/synopsis/body/sources. Never rewrite past findings: append corrections or supersessions citing what they change.
Body is readable Markdown. Investigations need headings Question, Findings (label each, observed/inferred/proposed and supported/negative/inconclusive), Limitations; include method and evidence. Components need Purpose, Interfaces or Architecture, Constraints or Gaps.
Sources cite existing records: repository {path, commit?, dirty?}, artifact {sessionId, artifactId, revision}, mission {missionId, decisionId|taskId|eventId|briefRevision}, web {url, accessedAt}, knowledge {knowledgeId, revision, relation}. Max 64 sources and 64 KiB.
Saving never marks an entry checked. After an interrupted or unknown result, retry with the same operationId.
- link/unlink (mission coordinator only): id and expectedLinkRevision from get's missionLink; link pins revision or follows current.
- observe: ids (1-50), explicit limited source observation, not a content check. GET/list/Refresh never observe. Committed repository objects only; live edits and external web changes remain unchecked.
- check: after actually checking current code and delivered scope, pass id, revision, pendingGeneration, observationToken returned by observe and coverage (evidence/limits). New revisions/events or unavailable sources leave work pending. Append content separately using normal expectedRevision; then observe/check the new revision.
- batch (coordinator only): ids and an existing open taskId. Reuse one documentation task for related pending entries; this records documentation origin but never creates/starts a worker or spends provider usage. Documentation-only changes never launch jobs; mixed code changes still need checking. Required docs belong in acceptance.`,
		parameters: Type.Object({
			action: StringEnum(KNOWLEDGE_ACTIONS),
			id: Type.Optional(Type.String({ maxLength: 128 })),
			ids: Type.Optional(Type.Array(Type.String({ maxLength: 128 }), { minItems: 1, maxItems: 50 })),
			pendingGeneration: Type.Optional(Type.Integer({ minimum: 0 })),
			observationToken: Type.Optional(Type.String({ maxLength: 64 })),
			coverage: Type.Optional(Type.String({ maxLength: 1000 })),
			revision: Type.Optional(Type.Integer({ minimum: 1 })),
			kind: Type.Optional(StringEnum(["investigation", "component"] as const)),
			q: Type.Optional(Type.String({ maxLength: 200 })),
			check: Type.Optional(StringEnum(["needs_check"] as const)),
			linked: Type.Optional(Type.Boolean()),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
			cursor: Type.Optional(Type.String({ maxLength: 1024 })),
			title: Type.Optional(Type.String({ maxLength: 200 })),
			synopsis: Type.Optional(Type.String({ maxLength: 1000 })),
			body: Type.Optional(Type.String({ maxLength: 65536 })),
			sources: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 64 })),
			reason: Type.Optional(Type.String({ maxLength: 1000 })),
			taskId: Type.Optional(Type.String({ maxLength: 128 })),
			expectedRevision: Type.Optional(Type.Integer({ minimum: 1 })),
			expectedLinkRevision: Type.Optional(Type.Integer({ minimum: 0 })),
			operationId: Type.Optional(
				Type.String({ maxLength: 128, description: "Reuse to retry an interrupted create/append." }),
			),
		}),
		executionMode: "sequential",
		annotations: { openWorldHint: false },
		async execute(id, params) {
			const { action, ...rest } = params;
			const args = rest as Record<string, JsonValue>;
			const writes = action === "create" || action === "append";
			const data = await call(action, args, writes ? (params.operationId ?? id) : undefined);
			return { content: [{ type: "text", text: JSON.stringify(data) }], details: data };
		},
	});
}
