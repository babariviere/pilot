import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CredentialChannel } from "./credential-rpc.ts";

test("a credential endpoint whose daemon is gone reports a stale broker", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-credential-stale-"));
	try {
		const channel = new CredentialChannel({ socket: join(root, "absent.sock"), token: "token" });
		await assert.rejects(channel.request({ op: "list", namespace: "pi" }), (error: unknown) => {
			assert.equal((error as { code?: string }).code, "stale");
			return true;
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("a credential endpoint whose daemon goes away mid-request is stale, not broken", async () => {
	const root = mkdtempSync(join(tmpdir(), "pilot-credential-gone-"));
	try {
		const socket = join(root, "auth.sock");
		const server = createServer((connection) => connection.destroy());
		await new Promise<void>((resolve) => server.listen(socket, resolve));
		const channel = new CredentialChannel({ socket, token: "token" });
		await assert.rejects(channel.request({ op: "list", namespace: "pi" }), (error: unknown) => {
			assert.equal((error as { code?: string }).code, "stale");
			return true;
		});
		await new Promise<void>((resolve) => server.close(() => resolve()));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
