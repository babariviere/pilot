/** Replay-only service fixtures. Never executes a process, opens a socket or records a miss. */
import { readFile } from "node:fs/promises";
import type { TrackingJson } from "@pilot/protocol";
import type { Runner } from "../workspaces.ts";

export interface CassetteEntry {
	request: unknown;
	response: TrackingJson;
}

function canonical(value: unknown): string {
	const visiting = new Set<object>();
	const json = (item: unknown): TrackingJson => {
		if (item === null || typeof item === "string" || typeof item === "boolean") return item;
		if (typeof item === "number" && Number.isFinite(item)) return item;
		if (!item || typeof item !== "object" || visiting.has(item))
			throw new Error("Cassette values must be acyclic JSON");
		visiting.add(item);
		try {
			// Arrays preserve every position. Unlike JSON.stringify, undefined/hole values are rejected.
			if (Array.isArray(item)) return Array.from(item, json);
			if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null)
				throw new Error("Cassette values must be plain JSON objects");
			const object = item as Record<string, unknown>;
			return Object.fromEntries(
				Object.keys(object)
					.sort()
					.filter((key) => object[key] !== undefined)
					.map((key) => [key, json(object[key])]),
			);
		} finally {
			visiting.delete(item);
		}
	};
	return JSON.stringify(json(value));
}
export class Cassette {
	private index = 0;
	private readonly entries: Array<{ request: string; response: string }>;
	constructor(privateName: string, entries: CassetteEntry[]) {
		this.name = privateName;
		this.entries = entries.map((entry) => ({
			request: canonical(entry.request),
			response: canonical(entry.response),
		}));
	}
	readonly name: string;
	replay<T extends TrackingJson = TrackingJson>(request: unknown): T {
		const entry = this.entries[this.index];
		// Do not print request bodies, headers, arguments or fixture responses in failures.
		if (!entry || entry.request !== canonical(request))
			throw new Error(`Cassette ${this.name}: unmatched request #${this.index + 1}`);
		this.index++;
		return JSON.parse(entry.response) as T;
	}
	assertDone(): void {
		if (this.index !== this.entries.length)
			throw new Error(`Cassette ${this.name}: ${this.entries.length - this.index} unused responses`);
	}
}

export async function loadCassette(path: URL): Promise<Cassette> {
	const document = JSON.parse(await readFile(path, "utf8"));
	if (
		document?.version !== 1 ||
		!Array.isArray(document.entries) ||
		document.entries.some(
			(entry: unknown) =>
				!entry ||
				typeof entry !== "object" ||
				!Object.hasOwn(entry, "request") ||
				!Object.hasOwn(entry, "response"),
		)
	)
		throw new Error("Invalid cassette document");
	return new Cassette(path.pathname.split("/").at(-1)!, document.entries);
}

/** Match the executable and complete argv. Cwd/timeouts/env are transport details, never recorded. */
export function cassetteRunner(cassette: Cassette): Runner {
	return async (file, args, _cwd, _timeoutMs, signal) => {
		signal?.throwIfAborted();
		const output = cassette.replay({ file, args });
		if (typeof output !== "string") throw new Error("Runner cassettes must return stdout strings");
		return output;
	};
}

/** Match the fixed source tool and all JSON arguments, including pagination and scope filters. */
export function cassetteSource(
	cassette: Cassette,
): (tool: string, args: Record<string, unknown>) => Promise<TrackingJson> {
	return async (tool, args) => cassette.replay({ tool, args });
}
