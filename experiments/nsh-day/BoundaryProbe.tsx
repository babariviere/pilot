// Tries every way out of the TSX sandbox toward a local daemon and shows
// what happened. nsh.json declares no capabilities, so each must be refused.
import { readFile } from "fs/promises";
import { connect } from "net";
import { mount, signal, Text, View } from "nsh";
import { spawn } from "process";

const results = signal<string[]>([]);

async function attempt(name: string, run: () => Promise<unknown> | unknown) {
	try {
		await run();
		results.update((r) => [...r, `${name}: allowed`]);
	} catch (error) {
		const code = (error as { code?: string }).code ?? String(error);
		results.update((r) => [...r, `${name}: ${code}`]);
	}
}

mount(() => (
	<View class="gap-1 p-4">
		<Each of={results()}>{(line) => <Text>{line()}</Text>}</Each>
	</View>
));

void (async () => {
	await attempt("fetch", () => fetch("http://127.0.0.1:4317/v1/hello"));
	await attempt("socket", () => connect({ host: "127.0.0.1", port: 4317 }));
	await attempt("file", () => readFile("/etc/hosts", "utf8"));
	await attempt("process", () => spawn("pilotd", ["--version"]));
	results.update((r) => [...r, "done"]);
})();
