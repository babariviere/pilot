import type { ControlExecutorBackend } from "./control-executor.ts";
import { ControlHostError } from "./control-host-policy.ts";
import { canonicalJSON } from "./operation-journal.ts";
import type { ProjectStore } from "./projects.ts";
import type { SessionManager } from "./sessions.ts";

/** Reuses the ordinary allocation, durable inbox and run-control paths, never ControlPilot/a live
 * executor conversation. The caller supplies only cached, trusted mission routing/proof readers. */
export function controlSessionBackend(
	sessions: SessionManager,
	projects: ProjectStore,
	coordinator: (missionId: string) => string | undefined,
	executionReady: ControlExecutorBackend["executionReady"] = () => false,
): ControlExecutorBackend {
	const resolveChat: ControlExecutorBackend["resolveChat"] = (id, direct) => {
		const requested = sessions.get(id);
		if (!requested || requested.archivedAt !== undefined)
			throw new ControlHostError("not_found", "Unknown or archived target chat", 404);
		const targetId = requested.missionId && !direct ? coordinator(requested.missionId) : id;
		if (!targetId)
			throw new ControlHostError("invalid_request", "Mission has no coordinator; use direct explicitly", 400);
		const target = sessions.get(targetId);
		if (!target || target.control || requested.control || target.archivedAt !== undefined)
			throw new ControlHostError(
				"capability_denied",
				"Cannot mutate a conversational Control or archived chat",
				403,
			);
		const scopes = (chat: typeof target) => [
			{ kind: "chat" as const, id: chat.id },
			...(chat.projectId ? [{ kind: "project" as const, id: chat.projectId }] : []),
			...(chat.missionId ? [{ kind: "mission" as const, id: chat.missionId }] : []),
		];
		return {
			id: targetId,
			scopes: targetId === id ? [scopes(target)] : [scopes(requested), scopes(target)],
			permission: sessions.controlPermission(targetId),
		};
	};
	return {
		reconciled: (op) => sessions.remoteControlReconciled(op),
		project: (id) => projects.list().some((p) => p.id === id),
		chat: (id) => sessions.get(id),
		resolveChat,
		executionReady,
		async prepareStart(p) {
			if (p.target.kind !== "project")
				throw new ControlHostError("delegation_required", "Placement authority is required");
			try {
				const model = await sessions.selectTaskModel(
					projects.require(p.target.projectId).path,
					p.model,
					p.thinking,
				);
				if (model.model !== p.model) throw new Error("Model changed");
			} catch {
				throw new ControlHostError(
					"invalid_request",
					"Explicit model/thinking is not available in target project",
					400,
				);
			}
		},
		async start(op, p, permission, fence) {
			if (p.target.kind !== "project")
				throw new ControlHostError("delegation_required", "Placement authority is required");
			await sessions.controlStart(
				() =>
					sessions.spawnDurable(
						{
							projectId: p.target.kind === "project" ? p.target.projectId : undefined,
							message: p.message,
							model: p.model,
							...(p.thinking ? { thinking: p.thinking } : {}),
							mode: permission.level === "investigate" ? "ask" : "build",
						},
						op.targetId,
						op.operationId,
					),
				permission,
				`control:start:${op.operationId}`,
				{
					authorizationId: permission.authorizationId,
					...(p.budgetReservation.budgetUsd ? { budgetUsd: p.budgetReservation.budgetUsd } : {}),
				},
				fence,
			);
		},
		async send(op, id, text, _permission, redirect, fence) {
			await fence();
			if (redirect) await sessions.stop(id, `control:stop:${op.operationId}`);
			await fence();
			// Stable request ID, durable original inbox ownership. Redirect cannot repeat Stop on recovery.
			await sessions.sendDurable(
				id,
				text,
				"followUp",
				`control:${redirect ? "redirect" : "send"}:${op.operationId}`,
				redirect,
			);
		},
		async run(op, id, action, fence) {
			const before = canonicalJSON(resolveChat(id, true));
			await fence();
			if (canonicalJSON(resolveChat(id, true)) !== before)
				throw new ControlHostError("identity_mismatch", "Target changed during preparation");
			if (action === "stop") await sessions.stop(id, `control:stop:${op.operationId}`);
			else await sessions.controlInputs(id, action === "pause", `control:${action}:${op.operationId}`);
		},
	};
}
