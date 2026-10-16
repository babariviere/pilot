/** Service/setup entry point. Run with the packaged Node from the actual pilotd service policy. */
import { rename, writeFile } from "node:fs/promises";
import { probeLinuxCoordinatorIsolation } from "./linux-coordinator.ts";

const result = await probeLinuxCoordinatorIsolation();
// Service ExecStartPre records its own policy result without preventing an otherwise healthy daemon.
if (process.argv[2] === "--output" && process.argv[3]) {
	const file = process.argv[3];
	const temporary = `${file}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(result)}\n`, { mode: 0o600, flag: "wx" });
	await rename(temporary, file);
}
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.available ? 0 : 1;
