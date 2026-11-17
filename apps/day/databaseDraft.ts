import { signal } from "nsh";

export const databaseDraft = signal({
	projectId: "",
	binding: "",
	name: "",
	mode: "read",
	host: "",
	user: "",
	database: "",
	transport: "verified",
	exception: "",
});
export function savedDatabaseDraft(): string {
	return JSON.stringify(databaseDraft());
}
export function restoreDatabaseDraft(text: string) {
	try {
		const v = JSON.parse(text);
		if (v && Object.keys(databaseDraft()).every((k) => typeof v[k] === "string")) databaseDraft.set(v);
	} catch {
		/* No valid saved draft. Opening never submits it. */
	}
}
