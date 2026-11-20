import { randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

/** Replace a private JSON file atomically; sync both its contents and the directory entry before acknowledgment. */
export async function durableJSON(file: string, value: unknown): Promise<void> {
	const temp = `${file}.${randomUUID()}.tmp`;
	const handle = await open(temp, "wx", 0o600);
	try {
		try {
			await handle.writeFile(JSON.stringify(value));
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temp, file);
		const directory = await open(dirname(file), "r");
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	} finally {
		await unlink(temp).catch(() => {});
	}
}
