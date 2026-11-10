/** Monotonic admission history, not a process-tree exit receipt. Never clears on Stop/exit/reopen. */
import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { dirname } from "node:path";

const CLEAN = '{"schema":1,"state":"clean"}';
const UNKNOWN = '{"schema":1,"state":"unknown"}';

export class JobHistory {
	private uncertain = false;
	private saving?: Promise<void>;
	private readonly file?: string;
	private constructor(file?: string) {
		this.file = file;
	}

	/** Only a caller with a newly created durable conversation may initialize missing history. */
	static async open(file?: string, fresh = false): Promise<JobHistory> {
		const history = new JobHistory(file);
		if (!file) return history;
		try {
			const fd = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
			try {
				const stat = await fd.stat();
				if (!stat.isFile() || stat.size !== Buffer.byteLength(CLEAN)) history.uncertain = true;
				else history.uncertain = (await fd.readFile("utf8")) !== CLEAN;
			} finally {
				await fd.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !fresh) history.uncertain = true;
			else {
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				try {
					const fd = await open(
						file,
						constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
						0o600,
					);
					try {
						await fd.writeFile(CLEAN);
						await fd.sync();
					} finally {
						await fd.close();
					}
					const parent = await open(dirname(file), constants.O_RDONLY);
					try {
						await parent.sync();
					} finally {
						await parent.close();
					}
				} catch {
					history.uncertain = true;
				}
			}
		}
		return history;
	}

	/** Must settle durably BEFORE a jobs start delegate can run. A failed write blocks admission. */
	admit(): Promise<void> {
		if (this.saving) return this.saving;
		this.uncertain = true;
		this.saving = this.file
			? (async () => {
					const fd = await open(this.file!, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
					try {
						const stat = await fd.stat();
						if (!stat.isFile() || stat.size > 128) throw new Error("Job admission history is unavailable");
						await fd.writeFile(UNKNOWN);
						await fd.truncate(Buffer.byteLength(UNKNOWN));
						await fd.sync();
					} finally {
						await fd.close();
					}
					const parent = await open(dirname(this.file!), constants.O_RDONLY);
					try {
						await parent.sync();
					} finally {
						await parent.close();
					}
				})()
			: Promise.resolve();
		return this.saving;
	}

	assertClear(): void {
		if (this.uncertain) throw new Error("Lifecycle job descendant exit is unconfirmed");
	}
}
