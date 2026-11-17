/** Paths literally named by the user, not paths suggested by an agent or an attachment. */
export function namedFeedbackPaths(text: string): string[] {
	const paths: string[] = [];
	// Quotes keep spaces. Bare paths stop at whitespace; punctuation belongs in quotes.
	const pattern = /`((?:\/|~\/)[^`\n]+)`|"((?:\/|~\/)[^"\n]+)"|(?:^|\s)((?:\/|~\/)[^\s<>"`]+)(?=$|\s)/g;
	for (const match of text.matchAll(pattern)) {
		const path = match[1] ?? match[2] ?? match[3]?.replace(/[.,;:!?)]*$/, "");
		if (
			path &&
			path !== "/" &&
			path !== "~/" &&
			path.length <= 4096 &&
			!path.includes("\0") &&
			!path.split(/[\\/]/).includes("..") &&
			!paths.includes(path)
		)
			paths.push(path);
		if (paths.length === 8) break;
	}
	return paths;
}
