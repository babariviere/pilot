// Fixed trusted preload for immutable SDK descendants, before they construct ModelRuntime.
import { installCredentialBrokerHooks } from "./credential-hooks.ts";

await installCredentialBrokerHooks({ descendants: true });
