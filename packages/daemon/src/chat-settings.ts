/** Private host settings, independent of pi settings and credentials. One daemon owns this store. */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ChatSettings, ChatSettingsPatch } from "@pilot/protocol";
import { Conflict, ServiceUnavailable } from "./errors.ts";

export class InvalidChatSettings extends Error {}

function patch(value: unknown): ChatSettingsPatch {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new InvalidChatSettings("Invalid chat settings");
	const input = value as Record<string, unknown>;
	if (
		Object.keys(input).length !== 2 ||
		!Object.hasOwn(input, "autoHandoff") ||
		!Object.hasOwn(input, "expectedRevision") ||
		typeof input.autoHandoff !== "boolean" ||
		typeof input.expectedRevision !== "string" ||
		!input.expectedRevision.length
	)
		throw new InvalidChatSettings("Expected exactly autoHandoff and expectedRevision");
	return { autoHandoff: input.autoHandoff, expectedRevision: input.expectedRevision };
}

async function syncDirectory(directory: string): Promise<void> {
	const parent = await open(directory, "r");
	try {
		await parent.sync();
	} finally {
		await parent.close();
	}
}

/** Success means both the replacement file and its directory entry were synced. */
async function replace(file: string, value: ChatSettings): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(`${JSON.stringify(value)}\n`);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		await syncDirectory(directory);
	} finally {
		await unlink(temporary).catch(() => undefined);
	}
}

export class ChatSettingsService {
	private value?: ChatSettings;
	private available = false;
	private saving: Promise<unknown> = Promise.resolve();
	private readonly listeners = new Set<(settings: ChatSettings) => void>();
	private readonly file: string;
	private readonly persist: typeof replace;
	private constructor(file: string, persist: typeof replace) {
		this.file = file;
		this.persist = persist;
	}

	static async open(home: string, persist = replace): Promise<ChatSettingsService> {
		const service = new ChatSettingsService(join(home, "chat-settings.json"), persist);
		try {
			let value: ChatSettings;
			try {
				value = JSON.parse(await readFile(service.file, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				value = { schemaVersion: 1, autoHandoff: false, revision: randomUUID() };
				await persist(service.file, value);
			}
			if (
				value?.schemaVersion !== 1 ||
				typeof value.autoHandoff !== "boolean" ||
				typeof value.revision !== "string" ||
				!value.revision.length ||
				Object.keys(value).some((key) => !["schemaVersion", "autoHandoff", "revision"].includes(key))
			)
				throw new Error("Unsupported chat settings");
			await chmod(service.file, 0o600);
			// A prior daemon may have exited after rename but before directory sync completed.
			const handle = await open(service.file, "r");
			try {
				await handle.sync();
			} finally {
				await handle.close();
			}
			await syncDirectory(dirname(service.file));
			service.value = value;
			service.available = true;
		} catch {
			// Never overwrite corrupt, inaccessible or newer settings with defaults.
		}
		return service;
	}

	settings(): ChatSettings {
		if (!this.available || !this.value)
			throw new ServiceUnavailable("Chat settings persistence is unavailable or unconfirmed; restart to recover");
		return { ...this.value };
	}

	update(input: unknown): Promise<ChatSettings> {
		const next = patch(input);
		const operation = this.saving.then(async () => {
			const current = this.settings();
			if (next.expectedRevision !== current.revision)
				throw new Conflict("Chat settings revision conflict; GET /api/chat-settings before retrying");
			const value: ChatSettings = { schemaVersion: 1, autoHandoff: next.autoHandoff, revision: randomUUID() };
			try {
				await this.persist(this.file, value);
			} catch {
				// Rename may have succeeded. Do not advertise either outcome or accept another CAS.
				this.available = false;
				throw new ServiceUnavailable("Chat settings save outcome is unconfirmed; restart to recover");
			}
			this.value = value;
			for (const listener of this.listeners) {
				try {
					listener({ ...value });
				} catch {}
			}
			return { ...value };
		});
		this.saving = operation.catch(() => undefined);
		return operation;
	}

	onChange(listener: (settings: ChatSettings) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
}
