import { randomBytes } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { OperationHost } from "@pilot/protocol";
import { SetupError } from "../../setup/setup-error.ts";

export const PILOT_CAPABILITY_HEADER = "x-pilot-github-capability";

/** Native host authority. The filename and header keep their historical GitHub naming. */
export class NativeAppCapability {
	private readonly token = randomBytes(32).toString("hex");
	private published?: Promise<void>;
	private readonly home: string;
	private readonly identity: OperationHost;
	constructor(home: string, identity: OperationHost) {
		this.home = home;
		this.identity = identity;
	}
	open(): Promise<void> {
		this.published ??= this.publish();
		return this.published;
	}
	private async publish(): Promise<void> {
		const file = join(this.home, "github-app-capability");
		await writeFile(`${file}.tmp`, JSON.stringify({ ...this.identity, token: this.token }), { mode: 0o600 });
		await rename(`${file}.tmp`, file);
	}
	async authenticate(token: unknown): Promise<void> {
		await this.open();
		if (typeof token !== "string" || token.length !== 64 || token !== this.token)
			throw new SetupError(403, "This operation requires the native app's host-authenticated GitHub action.");
	}
}
