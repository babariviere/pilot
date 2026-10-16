/** GET /api/machine. A read-only observation, never a live monitoring feed. Null means unavailable. */
export interface MachineInformation {
	checkedAt: number;
	/** The responding daemon is running. This says nothing about individual agents. */
	runtime: { state: "running"; version: string; nodeVersion: string };
	/** A responding process does not prove its service manager's state. */
	service: { state: "unknown" };
	os: string | null;
	kernel: string | null;
	architecture: string | null;
	cpuModel: string | null;
	/** Online logical CPUs, not physical cores or container CPU quota. */
	logicalCpuCount: number | null;
	memoryTotalBytes: number | null;
	/** Filesystem containing the daemon data home. Nested/project mounts may differ. */
	disk: { scope: "runtime-data"; totalBytes: number | null; availableBytes: number | null };
}
