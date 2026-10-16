import { type FileHandle, open, statfs } from "node:fs/promises";
import { arch, release, totalmem } from "node:os";
import type { MachineInformation } from "@pilot/protocol";

interface MachineSources {
	platform: string;
	read(path: string, maximumBytes: number): Promise<string | null>;
	disk(path: string): Promise<{ totalBytes: number | null; availableBytes: number | null }>;
	kernel(): string;
	architecture(): string;
	memory(): number;
}

/** Fixed small system files only. No shell, package discovery, config sourcing or privileged reads. */
async function boundedRead(path: string, maximumBytes: number): Promise<string | null> {
	let file: FileHandle | undefined;
	try {
		file = await open(path, "r");
		const buffer = Buffer.alloc(maximumBytes + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > maximumBytes && path !== "/proc/cpuinfo") return null;
		return buffer.toString("utf8", 0, Math.min(bytesRead, maximumBytes));
	} catch {
		return null;
	} finally {
		await file?.close();
	}
}

function bytes(value: number): number | null {
	return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const sources: MachineSources = {
	platform: process.platform,
	read: boundedRead,
	async disk(path) {
		try {
			const value = await statfs(path);
			return { totalBytes: bytes(value.blocks * value.bsize), availableBytes: bytes(value.bavail * value.bsize) };
		} catch {
			return { totalBytes: null, availableBytes: null };
		}
	},
	kernel: release,
	architecture: arch,
	memory: totalmem,
};

function label(value: string | undefined): string | null {
	const clean = value?.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim();
	return clean ? clean.slice(0, 160) : null;
}

export function osLabel(text: string | null): string | null {
	// Parse data, never execute/source os-release or expand shell substitutions.
	const value = text?.match(/^PRETTY_NAME=(.*)$/m)?.[1]?.trim();
	if (!value) return null;
	return label(value.replace(/^(["'])(.*)\1$/, "$2"));
}

export function onlineCpuCount(text: string | null): number | null {
	if (!text || !/^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/.test(text.trim())) return null;
	let count = 0;
	let previous = -1;
	for (const range of text.trim().split(",")) {
		const [first, last = first] = range.split("-").map(Number) as [number, number?];
		if (first <= previous || last < first || last > 1_000_000) return null;
		count += last - first + 1;
		previous = last;
	}
	return count > 0 ? count : null;
}

/** One bounded observation per server, coalesced with a five-second cache. No background monitoring.
 * A stuck filesystem read keeps its single admission slot, even after the response deadline.
 */
export class MachineInformationReader {
	private pending?: Promise<MachineInformation>;
	private cached?: MachineInformation;
	private home: string;
	private version: string;
	private source: MachineSources;
	private deadlineMs: number;
	constructor(home: string, version: string, source: MachineSources = sources, deadlineMs = 1_500) {
		this.home = home;
		this.version = version;
		this.source = source;
		this.deadlineMs = deadlineMs;
	}

	async read(): Promise<MachineInformation> {
		if (this.cached && Date.now() - this.cached.checkedAt < 5_000) return this.cached;
		if (!this.pending) {
			this.pending = this.collect()
				.then((value) => {
					this.cached = value;
					return value;
				})
				.finally(() => {
					this.pending = undefined;
				});
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([
				this.pending,
				new Promise<MachineInformation>((resolve) => {
					timer = setTimeout(() => resolve(this.empty()), this.deadlineMs);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
	}

	private empty(): MachineInformation {
		return {
			checkedAt: Date.now(),
			runtime: { state: "running", version: this.version, nodeVersion: process.versions.node },
			service: { state: "unknown" },
			os: null,
			kernel: null,
			architecture: null,
			cpuModel: null,
			logicalCpuCount: null,
			memoryTotalBytes: null,
			disk: { scope: "runtime-data", totalBytes: null, availableBytes: null },
		};
	}

	private async collect(): Promise<MachineInformation> {
		const value = this.empty();
		const safe = async <T>(operation: () => T | Promise<T>): Promise<T | null> => {
			try {
				return await operation();
			} catch {
				return null;
			}
		};
		const linux = this.source.platform === "linux";
		const [os, cpu, online, disk] = await Promise.all([
			linux ? safe(() => this.source.read("/etc/os-release", 16_384)) : null,
			linux ? safe(() => this.source.read("/proc/cpuinfo", 65_536)) : null,
			linux ? safe(() => this.source.read("/sys/devices/system/cpu/online", 4_096)) : null,
			safe(() => this.source.disk(this.home)),
		]);
		value.os = osLabel(os);
		value.cpuModel = label(cpu?.match(/^(?:model name|Hardware)\s*:\s*(.+)$/m)?.[1]);
		value.logicalCpuCount = onlineCpuCount(online);
		value.kernel = label((await safe(() => this.source.kernel())) ?? undefined);
		value.architecture = label((await safe(() => this.source.architecture())) ?? undefined);
		const memory = await safe(() => this.source.memory());
		value.memoryTotalBytes = memory && memory > 0 ? bytes(memory) : null;
		if (disk)
			value.disk = { scope: "runtime-data", totalBytes: disk.totalBytes, availableBytes: disk.availableBytes };
		return value;
	}
}
