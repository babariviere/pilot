import assert from "node:assert/strict";
import { test } from "node:test";
import { packagedSystemEventsHelperPath, systemEventsHelperPath } from "./system-events-helper.ts";

test("packaged SystemEvents stays bound to its runtime bundle", () => {
	assert.equal(
		packagedSystemEventsHelperPath("/private/Next.app/Contents/Resources/runtime/packages/daemon/src"),
		"/private/Next.app/Contents/Helpers/PilotSystemEvents.app",
	);
	assert.equal(packagedSystemEventsHelperPath("/repo/packages/daemon/src"), undefined);
});

test("development SystemEvents needs an explicit helper, not an obsolete GUI build", () => {
	const previous = process.env.PILOT_SYSTEM_EVENTS_HELPER_APP;
	try {
		delete process.env.PILOT_SYSTEM_EVENTS_HELPER_APP;
		assert.throws(() => systemEventsHelperPath(), /Set PILOT_SYSTEM_EVENTS_HELPER_APP/);
		process.env.PILOT_SYSTEM_EVENTS_HELPER_APP = "/fixture/Helpers/PilotSystemEvents.app";
		assert.equal(systemEventsHelperPath(), "/fixture/Helpers/PilotSystemEvents.app");
	} finally {
		if (previous === undefined) delete process.env.PILOT_SYSTEM_EVENTS_HELPER_APP;
		else process.env.PILOT_SYSTEM_EVENTS_HELPER_APP = previous;
	}
});
