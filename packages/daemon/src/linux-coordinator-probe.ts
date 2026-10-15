/** Service/setup entry point. Run with the packaged Node from the actual pilotd service policy. */
import { probeLinuxCoordinatorIsolation } from "./linux-coordinator.ts";

const result = await probeLinuxCoordinatorIsolation();
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.available ? 0 : 1;
