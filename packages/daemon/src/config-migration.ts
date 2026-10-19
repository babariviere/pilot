import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, link, lstat, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { getPilotConfigDir } from "./config.ts";

/** Run before config readers start. Publish exclusively, preserve bytes/modes, and never overwrite settings. */
export async function migratePilotConfig(agentDir: string, configDir = getPilotConfigDir()): Promise<void> {
	for (const [oldName, name] of [
		["pilot-databases.json", "database.json"],
		["pilot-tracking.json", "tracking.json"],
	]) {
		const source = join(agentDir, oldName);
		const destination = join(configDir, name);
		try {
			const info = await lstat(source);
			if (!info.isFile()) throw new Error("Not a regular file");
			await mkdir(configDir, { recursive: true, mode: 0o700 });
			const temp = join(configDir, `.${name}.${randomUUID()}.tmp`);
			try {
				await copyFile(source, temp, constants.COPYFILE_EXCL);
				// Same-filesystem exclusive publication, even when the old directory is on another volume.
				await link(temp, destination);
				await rm(source);
			} finally {
				await rm(temp, { force: true });
			}
		} catch (error) {
			if (["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
			// Neither config contents nor raw filesystem errors (possibly containing paths) enter logs.
			console.warn(`pilotd: could not move ${oldName} to the Pilot config directory as ${name}`);
		}
	}
}
