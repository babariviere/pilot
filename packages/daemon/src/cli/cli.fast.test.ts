import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer, type RequestListener } from "node:http";
import { type TestContext, test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./cli.ts", import.meta.url));
const token = "synthetic-pilot-cli-token";

function run(args: string[], env: NodeJS.ProcessEnv = {}) {
	return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
		execFile(process.execPath, [cli, ...args], { env, timeout: 10_000 }, (error, stdout, stderr) => {
			if (!error) resolve({ code: 0, stdout, stderr });
			else if (typeof error.code === "number") resolve({ code: error.code, stdout, stderr });
			else reject(error);
		});
	});
}

async function serve(t: TestContext, handle: RequestListener) {
	const server = createServer(handle);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => {
		server.closeAllConnections();
		return new Promise<void>((resolve) => server.close(() => resolve()));
	});
	const address = server.address();
	assert(address && typeof address !== "string");
	return {
		PILOT_CLI_PORT: String(address.port),
		PILOT_CLI_TOKEN: token,
	};
}

function assertFailure(result: Awaited<ReturnType<typeof run>>, message: RegExp) {
	assert.equal(result.code, 1);
	assert.equal(result.stdout, "");
	assert.match(result.stderr, message);
	assert(!result.stderr.includes(token));
}

test("pilot help requires no credentials and describes flags and commands", async () => {
	for (const args of [[], ["--help"], ["chats", "read", "-h"]]) {
		const result = await run(args);
		assert.equal(result.code, 0);
		assert.equal(result.stderr, "");
		assert.match(result.stdout, /Usage: pilot/);
		assert.match(result.stdout, /chats read <chat-id>/);
		assert.match(result.stdout, /missions brief <mission-id>/);
		assert.match(result.stdout, /--json/);
		assert.match(result.stdout, /--before.*positive numeric/);
		assert.match(result.stdout, /--limit.*1 to 50/);
	}
});

test("pilot commands send authenticated GET requests to the fixed read API", async (t) => {
	const requests: { method?: string; url?: string; authorization?: string }[] = [];
	const env = await serve(t, (req, res) => {
		requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
		res.end('{"brief":"# A Brief","fixture":[1,2]}');
	});
	const cases = [
		[["context"], "context"],
		[["chats", "list"], "chats"],
		[["chats", "read", "chat/with?# space"], "chats/chat%2Fwith%3F%23%20space"],
		[["chats", "read", "chat-1", "--before", "42", "--limit", "50"], "chats/chat-1?before=42&limit=50"],
		[["missions", "list"], "missions"],
		[["missions", "show", "mission-1"], "missions/mission-1"],
		[["missions", "brief", "mission-1"], "missions/mission-1/brief"],
		[["missions", "tasks", "mission-1"], "missions/mission-1/tasks"],
	] as const;

	for (const [args] of cases) {
		assert.deepEqual(await run(["--json", ...args], env), {
			code: 0,
			stdout: '{"brief":"# A Brief","fixture":[1,2]}\n',
			stderr: "",
		});
	}
	assert.deepEqual(
		requests,
		cases.map(([, path]) => ({
			method: "GET",
			url: `/api/agent-cli/v1/${path}`,
			authorization: `Bearer ${token}`,
		})),
	);
});

test("pilot prints Brief bytes as text, with no output for a missing Brief", async (t) => {
	const markdown = "# Brief\n\nRead-only fixture";
	const env = await serve(t, (req, res) => {
		if (req.url === "/api/agent-cli/v1/context") {
			res.end('{"chatId":"chat-1"}');
		} else {
			res.end(JSON.stringify({ brief: req.url?.includes("/present/") ? markdown : null }));
		}
	});
	assert.deepEqual(await run(["missions", "brief", "present"], env), { code: 0, stdout: markdown, stderr: "" });
	assert.deepEqual(await run(["missions", "brief", "missing"], env), { code: 0, stdout: "", stderr: "" });
	assert.deepEqual(await run(["missions", "brief", "missing", "--json"], env), {
		code: 0,
		stdout: '{"brief":null}\n',
		stderr: "",
	});
	assert.deepEqual(await run(["context"], env), { code: 0, stdout: '{\n  "chatId": "chat-1"\n}\n', stderr: "" });
});

test("pilot preserves the cursor on an empty chat history page", async (t) => {
	const env = await serve(t, (_req, res) => res.end('{"messages":[],"more":true,"nextBefore":42}'));
	assert.deepEqual(await run(["chats", "read", "chat-1", "--limit", "1", "--json"], env), {
		code: 0,
		stdout: '{"messages":[],"more":true,"nextBefore":42}\n',
		stderr: "",
	});
});

test("pilot rejects invalid commands and configuration before making a request", async (t) => {
	let requests = 0;
	const env = await serve(t, (_req, res) => {
		requests++;
		res.end("{}");
	});
	const cases = [
		[["unknown"], /Unknown command/],
		[["context", "--project", "other"], /Invalid option/],
		[["chats", "read"], /Expected one chat ID/],
		[["missions", "show", ".."], /Expected one mission ID/],
		[["missions", "tasks", "a", "b"], /Expected one mission ID/],
		[["chats", "list", "--before", "entry"], /only available with 'pilot chats read'/],
		[["chats", "read", "chat", "--limit"], /missing option value/],
		[["chats", "read", "chat", "--limit", "0"], /--limit must be an integer from 1 to 50/],
		[["chats", "read", "chat", "--limit", "51"], /--limit must be an integer from 1 to 50/],
		[["chats", "read", "chat", "--limit", "1.5"], /--limit must be an integer from 1 to 50/],
		[["chats", "read", "chat", "--before=0"], /--before must be a positive integer/],
		[["chats", "read", "chat", "--before=-1"], /--before must be a positive integer/],
		[["chats", "read", "chat", "--before", "entry-a"], /--before must be a positive integer/],
		[["chats", "read", "chat", "--before", "9007199254740992"], /--before must be a positive integer/],
	] as const;
	for (const [args, message] of cases) assertFailure(await run([...args], env), message);
	assertFailure(await run(["context"], { PILOT_CLI_PORT: env.PILOT_CLI_PORT }), /CLI access is not available/);
	assertFailure(await run(["context"], { PILOT_CLI_TOKEN: token }), /CLI access is not available/);
	assertFailure(
		await run(["context"], { ...env, PILOT_CLI_PORT: "127.0.0.1:80" }),
		/PILOT_CLI_PORT must be an integer/,
	);
	assertFailure(
		await run(["context"], { ...env, PILOT_CLI_TOKEN: `${token}\r\nInjected: yes` }),
		/valid Bearer token/,
	);
	assert.equal(requests, 0);
});

test("pilot reports HTTP failures and invalid responses without printing response bodies", async (t) => {
	const env = await serve(t, (req, res) => {
		if (req.url?.endsWith("/context")) {
			res.writeHead(401).end(JSON.stringify({ error: req.headers.authorization }));
		} else if (req.url?.endsWith("/chats")) {
			res.end(`not JSON: ${req.headers.authorization}`);
		} else if (req.url?.endsWith("/other-chat")) {
			res.writeHead(404).end(JSON.stringify({ error: req.headers.authorization }));
		} else {
			res.end(JSON.stringify({ brief: { text: req.headers.authorization } }));
		}
	});
	assertFailure(await run(["context", "--json"], env), /HTTP 401/);
	assertFailure(await run(["chats", "list"], env), /did not return valid JSON/);
	assertFailure(await run(["chats", "read", "other-chat"], env), /not found in this Pilot session's scope/i);
	assertFailure(await run(["missions", "brief", "mission"], env), /invalid Brief/);
});

test("pilot refuses redirects without contacting the destination", async (t) => {
	const requests: (string | undefined)[] = [];
	const env = await serve(t, (req, res) => {
		requests.push(req.url);
		if (req.url?.endsWith("/context")) {
			res.writeHead(302, { Location: "/redirect-target" }).end();
		} else {
			res.end("{}");
		}
	});
	assertFailure(await run(["context"], env), /Redirects are not allowed/);
	assert.deepEqual(requests, ["/api/agent-cli/v1/context"]);
});

test("pilot keeps authenticated requests off environment proxies", async (t) => {
	const env = await serve(t, (_req, res) => res.end("{}"));
	let proxyRequests = 0;
	const proxy = await serve(t, (_req, res) => {
		proxyRequests++;
		res.writeHead(502).end();
	});
	assert.deepEqual(
		await run(["context"], {
			...env,
			NODE_USE_ENV_PROXY: "1",
			HTTP_PROXY: `http://127.0.0.1:${proxy.PILOT_CLI_PORT}`,
			NO_PROXY: "example.invalid",
		}),
		{ code: 0, stdout: "{}\n", stderr: "" },
	);
	assert.equal(proxyRequests, 0);
});

test("pilot times out when the daemon stalls after sending headers", async (t) => {
	let startedBody = false;
	const env = await serve(t, (_req, res) => {
		res.writeHead(200).write('{"brief":');
		startedBody = true;
	});
	assertFailure(await run(["context"], env), /did not finish the request within 5 seconds/);
	assert(startedBody);
});
