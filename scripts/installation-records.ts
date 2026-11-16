import { open } from "node:fs/promises";
import { dirname } from "node:path";

/** Create-only evidence. Keep partial files on failure: their presence prevents replay. */
export async function writeNewDurableFile(path: string, bytes: string): Promise<void> {
	const file = await open(path, "wx", 0o600);
	try {
		await file.writeFile(bytes);
		await file.sync();
	} finally {
		await file.close();
	}
	const parent = await open(dirname(path), "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}
