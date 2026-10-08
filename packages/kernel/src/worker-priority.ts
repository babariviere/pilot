import { constants, getPriority, setPriority } from "node:os";

/** Keep background agents and their inherited build subprocesses below interactive UI work. */
export function lowerWorkerPriority(
	read: () => number = () => getPriority(0),
	write: (priority: number) => void = (priority) => setPriority(0, priority),
): void {
	try {
		const current = read();
		const background = constants.priority.PRIORITY_BELOW_NORMAL;
		if (current < background) write(background);
	} catch {
		// Scheduling policy is best-effort. Unsupported hosts must still run their sessions.
	}
}
