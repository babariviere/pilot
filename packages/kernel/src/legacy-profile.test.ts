import assert from "node:assert/strict";
import { test } from "node:test";
import type { KernelSpec } from "./protocol.ts";
import { KernelSession, type KernelSessionHooks } from "./session.ts";

test("obsolete coordinator envelopes fail before opening storage or initializing tools", async () => {
	await assert.rejects(
		KernelSession.open({ control: true } as unknown as KernelSpec, {} as KernelSessionHooks),
		/Retained conversation cannot execute/,
	);
});
