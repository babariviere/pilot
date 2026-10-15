/** Host-owned child composition. Never import upstream child.ts, which imports file-backed todos. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_CHILD_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
	});
	pi.registerTool(
		createTodoTool(callParentTodo, () => {
			if (!actor) throw new Error("Child todo tool requires a started session");
			return actor;
		}),
	);
}
