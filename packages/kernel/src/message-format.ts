/** Best-effort formatting guard for literal CLI messages, not a shell interpreter. */
export function messageFormatBlock(name: string, args: Record<string, unknown>, source: unknown): string | undefined {
	// Check actual nested calls, not their doubly escaped JavaScript source.
	if (name === "codemode") return undefined;
	if (/mcp__github\w*__\w*(?:create|update|edit)_pull_request/i.test(name)) {
		if ([args.title, args.body].some((value) => typeof value === "string" && value.includes("\\n"))) return REFORMAT;
	}
	if (typeof source !== "string") return undefined;
	for (const words of literalCommands(source)) {
		const command = [...words];
		if (command[0] === "env") command.shift();
		while (/^[A-Za-z_]\w*=/.test(command[0] ?? "")) command.shift();
		if (command[0] === "command") command.shift();
		if (!/^(?:.*\/)?(?:git|jj|gh)$/.test(command[0] ?? "")) continue;
		const tool = command[0]!.split("/").at(-1);
		while (command[1]?.startsWith("-")) {
			const option = command[1]!;
			command.splice(
				1,
				["-C", "-c", "-R", "--repository", "--repo", "--hostname", "--config", "--config-file"].includes(option)
					? 2
					: 1,
			);
		}
		const pr = tool === "gh" && command[1] === "pr" && ["create", "edit"].includes(command[2] ?? "");
		const commit =
			(tool === "git" && command[1] === "commit") ||
			(tool === "jj" && ["describe", "desc", "commit", "ci", "new"].includes(command[1] ?? ""));
		if (!pr && !commit) continue;
		const flags = pr ? ["--title", "-t", "--body", "-b"] : ["--message", "-m"];
		for (let i = 1; i < command.length; i++) {
			const word = command[i]!;
			if (word === "--") break;
			for (const flag of flags) {
				const value =
					word === flag
						? command[i + 1]
						: word.startsWith(`${flag}=`)
							? word.slice(flag.length + 1)
							: flag.length === 2 && word.startsWith(flag)
								? word.slice(2)
								: undefined;
				if (value?.includes("\\n")) return REFORMAT;
			}
		}
	}
	return undefined;
}

const REFORMAT =
	"Pilot: commit/PR message contains literal \\n escapes. Nothing was executed. Reformat with actual line breaks, separate -m paragraphs, or a heredoc/file (jj describe --stdin, git commit -F, gh pr create/edit --body-file). Do not pass JSON.stringify(message) inside shell quotes. Retry the corrected command.";

/** Preserve backslashes as the shell does in ordinary quotes; decode ANSI-C quoting. */
function literalCommands(source: string): string[][] {
	const commands: string[][] = [[]];
	let word = "",
		quote = "",
		started = false;
	const flush = () => {
		if (started) commands.at(-1)!.push(word);
		word = "";
		started = false;
	};
	for (let i = 0; i < source.length; i++) {
		const c = source[i]!;
		if (!quote && c === "#" && !started) {
			while (i < source.length && source[i] !== "\n") i++;
			flush();
			commands.push([]);
		} else if (!quote && c === "$" && source[i + 1] === "'") {
			quote = "ansi";
			started = true;
			i++;
		} else if (c === "\\" && quote !== "'") {
			const next = source[i + 1];
			if (next !== undefined && (!quote || quote === "ansi" || /[$`"\\\n]/.test(next))) {
				i++;
				if (quote === "ansi" && next === "n") word += "\n";
				else if (next !== "\n") word += next;
			} else word += c;
			started = true;
		} else if (quote) {
			if (c === (quote === "ansi" ? "'" : quote)) quote = "";
			else word += c;
		} else if (c === "'" || c === '"') {
			quote = c;
			started = true;
		} else if (/[;&|\n]/.test(c)) {
			flush();
			commands.push([]);
		} else if (/\s/.test(c)) flush();
		else {
			word += c;
			started = true;
		}
	}
	flush();
	return commands;
}
