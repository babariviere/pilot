/**
 * One line in pilotd.log that traces what happened (an operation settled, a planning step changed), so a
 * stuck mission can be followed from the log. Test runs (`node --test`) skip these lines to keep output short.
 */
const quiet = !!process.env.NODE_TEST_CONTEXT;

export function trace(line: string): void {
	if (!quiet) console.log(line);
}
