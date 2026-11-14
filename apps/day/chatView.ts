// The read-only chat page's place: the chat Pilot started that the user
// opened, over the screen it was opened from. Opening and leaving it only
// change where the user is; they send nothing.
import { signal } from "nsh";
import { glide } from "./motion";

/** The open chat page and the name of the screen under it, for Back. */
export type ChatPlace = { sessionId: string; from: string };

export const chatRoute = signal<ChatPlace | null>(null);

/** Opens chat `sessionId` over the screen named `from`, such as "Feedback". */
export function openChat(sessionId: string, from: string) {
	glide();
	chatRoute.set({ sessionId, from });
}

/** Back to the screen under it. */
export function closeChat() {
	chatRoute.set(null);
}
