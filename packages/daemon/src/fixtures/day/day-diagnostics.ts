/** Isolated real native diagnostics settings and receipt storage. No providers. */

import { join } from "node:path";
import { serveCommands } from "../commands.ts";
import { mock } from "node:test";
import { ModelCatalog } from "../../models/models.ts";
import { nativePlanningFixture } from "../../missions/planning/native-mission-planning.fixture.ts";
import { TelemetrySettingsService } from "../../runtime/telemetry/telemetry-settings.ts";

mock.method(ModelCatalog.prototype, "listTaskModels", async () => ({ models: [] }));
let writes = 0,
	lost = false;
const update = TelemetrySettingsService.prototype.update;
mock.method(
	TelemetrySettingsService.prototype,
	"update",
	async function (this: TelemetrySettingsService, ...args: Parameters<typeof update>) {
		writes++;
		const result = await update.apply(this, args);
		if (lost) {
			lost = false;
			throw new Error("Simulated lost domain acknowledgement");
		}
		return result;
	},
);
const f = await nativePlanningFixture({ diagnostics: true });
console.log(
	JSON.stringify({
		ledger: join(f.home, "commands.jsonl"),
		source: {
			profile: f.home,
			port: Number(new URL(f.root).port),
			home: { daemonId: f.hello.daemonId, lineageId: f.hello.lineageId },
			project_id: f.project.id,
			project_path: f.project.path,
		},
	}),
);
await serveCommands(async (c) => {
	if (c.action === "lost") lost = true;
	return { writes, sessions: f.sessions.list().length };
});
await f.close();
