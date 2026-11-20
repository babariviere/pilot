/** Which chat results the user has reviewed. Daemon-owned so the dashboard can count unread results. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** Per-session high-water mark: results with `outcomeAt` at or below it are reviewed. */
export class ReviewStore {
	private marks = new Map<string, number>();
	private readonly listeners = new Set<() => void>();
	private saving: Promise<void> = Promise.resolve();
	private readonly file: string;

	/** Loads synchronously: the file holds one small number per reviewed chat. */
	constructor(home: string) {
		this.file = join(home, "reviews.json");
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			if (parsed && typeof parsed === "object")
				for (const [id, at] of Object.entries(parsed))
					if (typeof at === "number" && Number.isFinite(at)) this.marks.set(id, at);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				console.warn(`pilotd: ignoring reviews.json: ${error}`);
		}
	}

	/** A result is unread until its version is at or below the mark. */
	isUnread(sessionId: string, outcomeAt: number): boolean {
		const mark = this.marks.get(sessionId);
		return mark === undefined || mark < outcomeAt;
	}

	/** Marks only move forward. Returns whether anything changed. */
	mark(updates: Iterable<{ sessionId: string; outcomeAt: number }>): boolean {
		let changed = false;
		for (const { sessionId, outcomeAt } of updates) {
			const mark = this.marks.get(sessionId);
			if (mark !== undefined && mark >= outcomeAt) continue;
			this.marks.set(sessionId, outcomeAt);
			changed = true;
		}
		if (changed) {
			this.persist();
			for (const listener of this.listeners) listener();
		}
		return changed;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** Resolves when pending writes are on disk. */
	flush(): Promise<void> {
		return this.saving;
	}

	private persist(): void {
		const snapshot = `${JSON.stringify(Object.fromEntries(this.marks))}\n`;
		this.saving = this.saving
			.catch(() => undefined)
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
				const temp = `${this.file}.${randomUUID()}.tmp`;
				await writeFile(temp, snapshot, { mode: 0o600 });
				await rename(temp, this.file);
			});
		this.saving.catch((error: unknown) => console.warn(`pilotd: could not save reviews: ${error}`));
	}
}
