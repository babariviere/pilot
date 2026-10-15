/** Host-owned child composition. Never import upstream child.ts, which imports file-backed todos. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_CHILD_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OfflineGate, offlineRequestStream } from "./connectivity.ts";
import { callParentTodo } from "./todo-bridge.ts";
import { createTodoTool } from "./todo-tool.ts";

export default async function childProfile(pi: ExtensionAPI): Promise<void> {
	for (const name of ["sandbox", "apply-patch", "web", "browser"]) {
		const path = fileURLToPath(new URL(`../extensions/${name}/index.ts`, pathToFileURL(PILOT_CHILD_PROFILE_PATH)));
		const { default: factory } = await import(path);
		factory(pi);
	}
	let actor: string | undefined;
	pi.on("session_start", (_event, ctx) => {
		actor = ctx.sessionManager.getSessionId();
		// Child adapters dispatch through this public registry. Keep the immutable shared
		// extension dependency unchanged, and gate only requests, not native tool execution.
		const registry = ctx.modelRegistry;
		const gate = new OfflineGate();
		if (!gate.path) return;
		const stream = registry.stream.bind(registry);
		const simple = registry.streamSimple.bind(registry);
		registry.stream = (model, context, options) =>
			offlineRequestStream(
				(signal) => stream(model, context, { ...options, signal } as typeof options),
				model,
				gate,
				options?.signal,
			);
		registry.streamSimple = (model, context, options) =>
			offlineRequestStream((signal) => simple(model, context, { ...options, signal }), model, gate, options?.signal);
	});
	pi.registerTool(
		createTodoTool(callParentTodo, () => {
			if (!actor) throw new Error("Child todo tool requires a started session");
			return actor;
		}),
	);
}
