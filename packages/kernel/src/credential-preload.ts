// Fixed trusted preload for immutable SDK descendants, before they construct ModelRuntime.
import { installCredentialBrokerHooks } from "./credential-hooks.ts";

await installCredentialBrokerHooks({ descendants: true });

// The trusted child launch precedes adapter/profile construction. Keep its source journal
// beside its own durable storage, never beside the parent's or a cwd chosen by a model.
if (process.env.PI_CODE_MODE_SUBAGENT === "1") {
	process.once("message", (message: unknown) => {
		const launch = message as { type?: unknown; spec?: { directory?: unknown } } | undefined;
		if (launch?.type === "start" && typeof launch.spec?.directory === "string")
			process.env.PILOT_USAGE_STORAGE = launch.spec.directory;
	});
}
