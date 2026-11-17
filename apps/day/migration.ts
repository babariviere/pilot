/** Native projection of the exact old/published replacement comparison. */
export type MigrationView = {
	digest: string;
	state: "preview" | "unknown" | "finished" | "rejected" | "history";
	message: string;
	oldTitle: string | null;
	newTitle: string | null;
	members: number;
	linkedTickets: number;
	oldGoal?: string | null;
	newGoal?: string | null;
	publicationId?: string | null;
	briefRevision?: number | null;
	agreement?: string | null;
	oldAgreement?: string | null;
	oldTasks?: MigrationTask[];
	newTasks?: MigrationTask[];
	keptChats?: { id: string; title: string; unpublishedWork: true | null }[];
	decisions?: { id: string; number: number; text: string; replacement?: unknown; withdrawn?: unknown }[];
	events?: { id: number; text: string }[];
	resources?: { id: string; title?: string; url: string }[];
};
export type MigrationTask = {
	id: string;
	number: number;
	title: string;
	status: string;
	body?: string;
	sessionId?: string | null;
};
export type MigrationIntent = {
	missionId: string;
	successorId: string;
	action: "read" | "finish" | "check" | "history";
	digest?: string;
};
