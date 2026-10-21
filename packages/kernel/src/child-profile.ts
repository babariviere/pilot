/** Host-owned child composition. Never import upstream child.ts, which imports file-backed todos. */
import { fileURLToPath, pathToFileURL } from "node:url";
import { PILOT_CHILD_PROFILE_PATH } from "@babariviere/pi-extensions/profile";
import { SubscriptionGate } from "@babariviere/pi-extensions/subscription-gate";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OfflineGate, offlineRequestStream } from "./connectivity.ts";
import { installCredentialBrokerHooks } from "./credential-hooks.ts";
import { subscriptionRecovery } from "./subscription-limit.ts";
import { callParentSubscriptionLimit, callParentTodo, callParentUsage, callParentUsageEpoch } from "./todo-bridge.ts";
import { createTodoTool } from "./todo-tool.ts";
import { inheritedControlPermission, nativeToolPolicy } from "./tool-policy.ts";
import { installChildUsageCapture, observeChildUsageStreams } from "./usage-capture.ts";

export default async function childProfile(pi: ExtensionAPI): Promise<void> {
	installChildUsageCapture(callParentUsage, callParentUsageEpoch);
	nativeToolPolicy(inheritedControlPermission(process.env.PILOT_CONTROL_PERMISSION))(pi);
	await installCredentialBrokerHooks();
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
		observeChildUsageStreams(registry);
		const gate = new OfflineGate();
		const subscription = new SubscriptionGate();
		const reportLimit = process.env.PILOT_TODO_BRIDGE ? callParentSubscriptionLimit : undefined;
		if (!gate.path && !reportLimit) return;
		const stream = registry.stream.bind(registry);
		const simple = registry.streamSimple.bind(registry);
		registry.stream = (model, context, options) => {
			let provider = model.provider;
			return offlineRequestStream(
				(signal) =>
					stream(model, context, {
						...options,
						signal,
						onPayload: async (payload, physical) => {
							provider = physical.provider;
							return (await options?.onPayload?.(payload, physical)) ?? payload;
						},
					} as typeof options),
				model,
				gate,
				options?.signal,
				subscriptionRecovery(() => provider, subscription, reportLimit),
			);
		};
		registry.streamSimple = (model, context, options) => {
			let provider = model.provider;
			return offlineRequestStream(
				(signal) =>
					simple(model, context, {
						...options,
						signal,
						onPayload: async (payload, physical) => {
							provider = physical.provider;
							return (await options?.onPayload?.(payload, physical)) ?? payload;
						},
					}),
				model,
				gate,
				options?.signal,
				subscriptionRecovery(() => provider, subscription, reportLimit),
			);
		};
	});
	pi.registerTool(
		createTodoTool(callParentTodo, () => {
			if (!actor) throw new Error("Child todo tool requires a started session");
			return actor;
		}),
	);
}
