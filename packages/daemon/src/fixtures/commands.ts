/** Command loop for the native-test fixtures: a Rust test writes one JSON command per stdin line and reads one
 * JSON reply per command from stdout. "quit" ends the loop. */
import { createInterface } from "node:readline";

export interface FixtureCommand {
	action: string;
	value?: unknown;
}

export async function serveCommands(reply: (command: FixtureCommand) => unknown): Promise<void> {
	for await (const line of createInterface({ input: process.stdin })) {
		const command: FixtureCommand = JSON.parse(line);
		if (command.action === "quit") break;
		console.log(JSON.stringify(await reply(command)));
	}
	// The native parent can keep its pipe open while it waits for an orderly exit.
	process.stdin.destroy();
}
