import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, link, mkdir, open, rm } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { McpSetupApplyRequest, McpSetupEntry, McpSetupSnapshot, McpShareConfig } from "@pilot/protocol";
import { mcpSetupName, mcpSetupNamespace, projectMcpSetup } from "./mcp-setup-projection.ts";
import { withModelSettingsLock } from "./model-settings.ts";

const MAX_BYTES = 1_048_576;
const object = (value: unknown): value is Record<string, unknown> =>
	!!value && typeof value === "object" && !Array.isArray(value);
export class McpSetupError extends Error {
	readonly status: number;
	readonly code: string;
	constructor(status: number, code: string) {
		super(code);
		this.status = status;
		this.code = code;
	}
}
function fail(status: number, code: string): never {
	throw new McpSetupError(status, code);
}
const hash = (bytes: Buffer | undefined): string =>
	createHash("sha256")
		.update(bytes ?? "absent")
		.digest("hex");
type Raw = { bytes?: Buffer; revision: string; servers: Record<string, unknown> };

function configKey(config: McpShareConfig): string {
	return JSON.stringify(Object.fromEntries(Object.entries(config).sort(([a], [b]) => a.localeCompare(b))));
}

export function mcpSetupInput(value: unknown): McpSetupApplyRequest {
	if (
		!object(value) ||
		Object.keys(value).some((key) => !["expectedRevision", "entries"].includes(key)) ||
		typeof value.expectedRevision !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.expectedRevision) ||
		!Array.isArray(value.entries) ||
		!value.entries.length ||
		value.entries.length > 64
	)
		fail(400, "invalid_mcp_setup");
	const entries = value.entries.map((entry: unknown) => {
		if (
			!object(entry) ||
			Object.keys(entry).some((key) => !["name", "config"].includes(key)) ||
			typeof entry.name !== "string" ||
			!mcpSetupName(entry.name)
		)
			fail(400, "invalid_mcp_setup");
		const safe = projectMcpSetup(entry.name, entry.config);
		if (!safe.config) fail(400, "invalid_mcp_setup");
		return { name: entry.name, config: safe.config };
	});
	if (new Set(entries.map((entry) => mcpSetupNamespace(entry.name))).size !== entries.length)
		fail(400, "invalid_mcp_setup");
	return { expectedRevision: value.expectedRevision, entries };
}

/** Explicit native requests only. Never reads auth stores, expands secrets, launches or installs commands.
 * Pi 1.3's config editor is an unlocked in-place writer, so existing files are never modified here.
 * Initial publication uses link(2): a concurrent creator wins without either file being overwritten.
 */
export class McpSetupStore {
	readonly path: string;
	private readonly options: { path?: string; beforeCommit?: () => Promise<void> };
	constructor(agentDir = getAgentDir(), options: { path?: string; beforeCommit?: () => Promise<void> } = {}) {
		this.options = options;
		this.path = join(agentDir, "mcp.json");
	}
	private async raw(): Promise<Raw> {
		let file: Awaited<ReturnType<typeof open>> | undefined;
		try {
			file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
			const before = await file.stat({ bigint: true });
			if (!before.isFile() || before.size > BigInt(MAX_BYTES)) fail(503, "mcp_setup_unreadable");
			const buffer = Buffer.alloc(MAX_BYTES + 1);
			const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
			const after = await file.stat({ bigint: true });
			if (
				bytesRead > MAX_BYTES ||
				BigInt(bytesRead) !== before.size ||
				before.mtimeNs !== after.mtimeNs ||
				before.ctimeNs !== after.ctimeNs
			)
				fail(503, "mcp_setup_unreadable");
			const bytes = buffer.subarray(0, bytesRead),
				value: unknown = JSON.parse(bytes.toString("utf8"));
			if (!object(value) || (Object.hasOwn(value, "mcpServers") && !object(value.mcpServers)))
				fail(503, "mcp_setup_unreadable");
			const servers = (value.mcpServers ?? {}) as Record<string, unknown>;
			if (Object.keys(servers).length > 64) fail(503, "mcp_setup_unreadable");
			return { bytes, revision: hash(bytes), servers };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { revision: hash(undefined), servers: {} };
			if (error instanceof McpSetupError) throw error;
			throw new McpSetupError(503, "mcp_setup_unreadable");
		} finally {
			await file?.close();
		}
	}
	private async executable(command: string): Promise<boolean> {
		for (const directory of (this.options.path ?? process.env.PATH ?? "")
			.split(delimiter)
			.filter(isAbsolute)
			.slice(0, 32)) {
			try {
				const path = join(directory, command);
				await access(path, constants.X_OK);
				const file = await open(path, constants.O_RDONLY);
				try {
					if ((await file.stat()).isFile()) return true;
				} finally {
					await file.close();
				}
			} catch {
				/* Missing/unusable dependencies are metadata, never installation commands. */
			}
		}
		return false;
	}
	async read(): Promise<McpSetupSnapshot> {
		const raw = await this.raw(),
			entries: McpSetupEntry[] = [];
		let invalidNames = 0;
		for (const [name, config] of Object.entries(raw.servers)) {
			if (!mcpSetupName(name)) {
				invalidNames++;
				continue;
			}
			const entry = projectMcpSetup(name, config);
			if (entry.config?.command) entry.dependencyAvailable = await this.executable(entry.config.command);
			entries.push(entry);
		}
		return {
			schemaVersion: 1,
			writeMode: "initial_only",
			revision: raw.revision,
			exists: raw.bytes !== undefined,
			entries,
			invalidNames,
		};
	}
	async apply(value: unknown): Promise<McpSetupSnapshot> {
		const input = mcpSetupInput(value);
		try {
			await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
			await withModelSettingsLock(
				this.path,
				async (assertOwned) => {
					const raw = await this.raw();
					if (
						input.entries.every((entry) => {
							const existing = Object.hasOwn(raw.servers, entry.name)
								? projectMcpSetup(entry.name, raw.servers[entry.name])
								: undefined;
							return existing?.config && configKey(existing.config) === configKey(entry.config);
						})
					)
						return; // Lost acknowledgment: read-only exact desired-value reconciliation.
					if (raw.revision !== input.expectedRevision) fail(409, "mcp_setup_conflict");
					if (raw.bytes !== undefined) fail(409, "mcp_setup_existing_config");
					for (const entry of input.entries) {
						if (entry.config.command && !(await this.executable(entry.config.command)))
							fail(422, "mcp_setup_dependency_missing");
					}
					const next = `${JSON.stringify(
						{ mcpServers: Object.fromEntries(input.entries.map((entry) => [entry.name, entry.config])) },
						null,
						2,
					)}\n`;
					if (Buffer.byteLength(next) > MAX_BYTES) fail(400, "invalid_mcp_setup");
					const temporary = `${this.path}.${randomUUID()}.tmp`;
					try {
						const file = await open(temporary, "wx", 0o600);
						try {
							await file.writeFile(next);
							await file.sync();
						} finally {
							await file.close();
						}
						await this.options.beforeCommit?.();
						assertOwned();
						try {
							await link(temporary, this.path);
						} catch (error) {
							if ((error as NodeJS.ErrnoException).code === "EEXIST") fail(409, "mcp_setup_conflict");
							throw error;
						}
						const directory = await open(dirname(this.path), constants.O_RDONLY);
						try {
							await directory.sync();
						} finally {
							await directory.close();
						}
					} finally {
						await rm(temporary, { force: true });
					}
				},
				undefined,
				true,
			);
			const result = await this.read();
			if (
				!input.entries.every((entry) =>
					result.entries.some(
						(row) => row.name === entry.name && row.config && configKey(row.config) === configKey(entry.config),
					),
				)
			)
				fail(409, "mcp_setup_conflict");
			return result;
		} catch (error) {
			if (error instanceof McpSetupError) throw error;
			throw new McpSetupError(503, "mcp_setup_unavailable");
		}
	}
}
