import assert from "node:assert/strict";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";

/** Minimal catalog fakes still verify that the real required auth factory registers its transport. */
export const requiredAuthRegistration = {
	refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
	unregisterProvider(name: string) {
		assert.equal(name, "anthropic");
	},
	registerProvider(name: string, config: Parameters<ModelRuntime["registerProvider"]>[1]) {
		assert.equal(name, "anthropic");
		assert.equal(typeof config.streamSimple, "function");
	},
};
