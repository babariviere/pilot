#!/usr/bin/env node
import { parseArgs } from "node:util";

const help = `Usage: pilot <command> [--json]

Commands:
  context                                      Show the current Pilot context
  chats list                                   List chats
  chats read <chat-id> [--before <id>] [--limit <n>]
                                               Read a page of chat history
  missions list                                List missions
  missions show <mission-id>                   Show a mission
  missions brief <mission-id>                  Print a mission's Brief as raw text
  missions tasks <mission-id>                  List a mission's tasks

Options:
  --json       Print compact JSON for any command
  --before    Read history before a positive numeric entry ID (chats read only)
  --limit     Request 1 to 50 chat entries (chats read only)
  -h, --help  Show this help without connecting to Pilot

Read access is limited to your current chat and its attached mission.
`;

const options = {
	help: { type: "boolean", short: "h" },
	json: { type: "boolean" },
	before: { type: "string" },
	limit: { type: "string" },
} as const;

function parseCommand(args: string[]) {
	try {
		return parseArgs({ args, options, allowPositionals: true });
	} catch {
		throw new Error("Invalid option or missing option value. Run 'pilot --help' for usage.");
	}
}

function idSegment(kind: "chat" | "mission", id: string | undefined, extra: string[]): string {
	// A URL parser normalizes dot segments even when they are percent-encoded.
	if (!id || id === "." || id === ".." || extra.length) {
		throw new Error(`Expected one ${kind} ID. Run 'pilot --help' for usage.`);
	}
	return encodeURIComponent(id);
}

function commandPath([group, action, id, ...extra]: string[]): string {
	if (group === "context" && action === undefined) return "context";
	if ((group === "chats" || group === "missions") && action === "list" && id === undefined) return group;
	if (group === "chats" && action === "read") return `chats/${idSegment("chat", id, extra)}`;
	if (group === "missions" && (action === "show" || action === "brief" || action === "tasks")) {
		const mission = `missions/${idSegment("mission", id, extra)}`;
		return action === "show" ? mission : `${mission}/${action}`;
	}
	throw new Error("Unknown command or unexpected arguments. Run 'pilot --help' for usage.");
}

function pageInteger(flag: "before" | "limit", value: string): string {
	const number = Number(value);
	const max = flag === "limit" ? 50 : Number.MAX_SAFE_INTEGER;
	if (!/^\d+$/.test(value) || number < 1 || number > max) {
		throw new Error(
			flag === "limit"
				? "--limit must be an integer from 1 to 50."
				: "--before must be a positive integer within JavaScript's safe integer range.",
		);
	}
	return String(number);
}

async function readPilot(path: string, query: URLSearchParams): Promise<unknown> {
	const port = process.env.PILOT_CLI_PORT;
	const token = process.env.PILOT_CLI_TOKEN;
	if (!port || !token) {
		throw new Error("Pilot CLI access is not available. Run from a Pilot session with CLI access.");
	}
	if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
		throw new Error("PILOT_CLI_PORT must be an integer from 1 to 65535.");
	}
	if (!/^[a-zA-Z0-9._~+/=-]+$/.test(token)) {
		throw new Error("PILOT_CLI_TOKEN is not a valid Bearer token.");
	}

	const url = new URL(`http://127.0.0.1:${Number(port)}/api/agent-cli/v1/${path}`);
	url.search = query.toString();
	// This is a standalone loopback client, even when Node's environment proxy is enabled.
	process.env.no_proxy = url.hostname;
	// One deadline covers both the local request and reading the response body.
	const signal = AbortSignal.timeout(5_000);
	const timeoutMessage = "The Pilot daemon did not finish the request within 5 seconds.";
	let response: Response;
	try {
		response = await fetch(url, {
			method: "GET",
			headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
			redirect: "error",
			signal,
		});
	} catch {
		throw new Error(
			signal.aborted ? timeoutMessage : "Could not reach the Pilot daemon directly. Redirects are not allowed.",
		);
	}

	if (!response.ok) {
		// Do not print server error bodies, which could contain request credentials.
		void response.body?.cancel().catch(() => {});
		if (response.status === 404) {
			throw new Error(
				"Not found in this Pilot session's scope (HTTP 404). Check the current chat and attached mission with 'pilot context'.",
			);
		}
		const detail = response.status === 401 ? ": check CLI access" : response.status === 403 ? ": access denied" : "";
		throw new Error(`Pilot daemon returned HTTP ${response.status}${detail}.`);
	}
	try {
		return await response.json();
	} catch {
		throw new Error(signal.aborted ? timeoutMessage : "The Pilot daemon did not return valid JSON.");
	}
}

async function main(args: string[]): Promise<void> {
	const { positionals, values } = parseCommand(args);
	if (values.help || args.length === 0) {
		process.stdout.write(help);
		return;
	}
	const path = commandPath(positionals);
	const query = new URLSearchParams();
	if ((values.before !== undefined || values.limit !== undefined) && !path.startsWith("chats/")) {
		throw new Error("--before and --limit are only available with 'pilot chats read'.");
	}
	if (values.before !== undefined) query.set("before", pageInteger("before", values.before));
	if (values.limit !== undefined) query.set("limit", pageInteger("limit", values.limit));

	const data = await readPilot(path, query);
	if (positionals[0] === "missions" && positionals[1] === "brief") {
		if (
			typeof data !== "object" ||
			data === null ||
			!("brief" in data) ||
			(data.brief !== null && typeof data.brief !== "string")
		) {
			throw new Error("The Pilot daemon returned an invalid Brief.");
		}
		if (!values.json) {
			process.stdout.write(data.brief ?? "");
			return;
		}
	}
	process.stdout.write(`${JSON.stringify(data, null, values.json ? 0 : 2)}\n`);
}

try {
	await main(process.argv.slice(2));
} catch (error) {
	process.stderr.write(`pilot: ${error instanceof Error ? error.message : "CLI request failed."}\n`);
	process.exitCode = 1;
}
