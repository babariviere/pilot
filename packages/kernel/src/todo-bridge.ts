/** Private, bounded parent capability for child workers. Only the parent owns Harness writes. */
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TodoArgs, TodoCall, TodoResult } from "./todos.ts";

const MAX_REQUEST_BYTES = 512 * 1024;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const BRIDGE_ENV = "PILOT_TODO_BRIDGE";

export async function startTodoBridge(call: TodoCall): Promise<{ close(): Promise<void> }> {
	const directory = await mkdtemp(join(tmpdir(), "pt-"));
	await chmod(directory, 0o700);
	const socketPath = join(directory, "s");
	const token = randomBytes(32).toString("hex");
	let active = 0;
	let stopped = false;
	let drained: (() => void) | undefined;
	const server = createServer(async (req, res) => {
		res.setHeader("content-type", "application/json");
		if (req.method !== "POST" || req.url !== "/todo" || req.headers.authorization !== `Bearer ${token}`) {
			res.writeHead(403).end(JSON.stringify({ error: "Todo bridge unavailable" }));
			req.resume();
			return;
		}
		if (stopped || active >= 8) {
			res.writeHead(503).end(JSON.stringify({ error: "Todo bridge busy" }));
			req.resume();
			return;
		}
		active++;
		try {
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of req) {
				bytes += chunk.length;
				if (bytes > MAX_REQUEST_BYTES) throw new Error("Todo request too large");
				chunks.push(chunk);
			}
			const { args, actor } = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			const result = await call(args, actor);
			res.end(JSON.stringify({ result }));
		} catch (error) {
			res.writeHead(400).end(
				JSON.stringify({ error: error instanceof Error ? error.message : "Invalid todo request" }),
			);
		} finally {
			active--;
			if (!active) drained?.();
		}
	});
	server.maxConnections = 16;
	server.requestTimeout = 30_000;
	server.headersTimeout = 10_000;
	server.timeout = 30_000;
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(socketPath, () => {
				server.off("error", reject);
				resolve();
			});
		});
		await chmod(socketPath, 0o600);
	} catch (error) {
		server.close();
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
	const previous = process.env[BRIDGE_ENV];
	const config = JSON.stringify({ socketPath, token });
	process.env[BRIDGE_ENV] = config;
	let closing: Promise<void> | undefined;
	return {
		close: () =>
			(closing ??= (async () => {
				stopped = true;
				if (process.env[BRIDGE_ENV] === config) {
					if (previous === undefined) delete process.env[BRIDGE_ENV];
					else process.env[BRIDGE_ENV] = previous;
				}
				const closed = new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()));
					server.closeIdleConnections();
				});
				// Even a disconnected child can own an admitted commit. Drain it before Harness closes.
				if (active)
					await new Promise<void>((resolve) => {
						drained = resolve;
					});
				server.closeAllConnections();
				await closed;
				await rm(directory, { recursive: true, force: true });
			})()),
	};
}

/** No fallback to checkout files or a second SQLite writer when a parent is unavailable. */
export function callParentTodo(args: TodoArgs, actor: string): Promise<TodoResult> {
	const config = process.env[BRIDGE_ENV];
	if (!config) return Promise.reject(new Error("Parent chat todos are unavailable"));
	const { socketPath, token } = JSON.parse(config);
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath,
				path: "/todo",
				method: "POST",
				headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			},
			(res) => {
				const chunks: Buffer[] = [];
				let bytes = 0;
				res.on("data", (chunk: Buffer) => {
					bytes += chunk.length;
					if (bytes > MAX_RESPONSE_BYTES) req.destroy(new Error("Todo response too large"));
					else chunks.push(chunk);
				});
				res.on("error", reject);
				res.on("end", () => {
					try {
						const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
						if (data.error || res.statusCode !== 200) throw new Error(data.error ?? "Parent todo request failed");
						resolve(data.result);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(30_000, () => req.destroy(new Error("Parent todo request timed out")));
		req.end(JSON.stringify({ args, actor }));
	});
}
