// Window-local corrected follow-ups. Capturing and restoring never send input.
import { signal } from "nsh";

const notes = signal<Record<string, string>>({});
/** Same 12,000-byte queued-input budget as standalone chat creation, not a new draft-storage limit. */
export const RECOVERY_INPUT_BYTES = 12_000;
export function recoveryBytes(text: string): number {
	let bytes = 0;
	for (const ch of text) {
		const c = ch.codePointAt(0) ?? 0;
		bytes += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
	}
	return bytes;
}
export const recoveryNote = (id: string) => notes()[id] ?? "";
export function setRecoveryNote(id: string, text: string) {
	notes.update((all) => {
		const next = { ...all };
		if (text) next[id] = text;
		else delete next[id];
		return next;
	});
}
export const savedRecoveryNotes = () => Object.entries(notes()).map(([id, text]) => `${id}\n${text}`);
export function restoreRecoveryNotes(lines: string[]) {
	const next: Record<string, string> = {};
	for (const line of lines) {
		const at = line.indexOf("\n");
		if (at > 0 && /^[A-Za-z0-9_-]{1,128}$/.test(line.slice(0, at))) next[line.slice(0, at)] = line.slice(at + 1);
	}
	notes.set(next);
}
