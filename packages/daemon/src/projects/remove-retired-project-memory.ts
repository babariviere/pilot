import { rm } from "node:fs/promises";
import { join } from "node:path";

/** This directory was exclusive to the retired project store, including deleted projects. */
export function removeRetiredProjectMemory(home: string): Promise<void> {
	return rm(join(home, "memory"), { recursive: true, force: true });
}
