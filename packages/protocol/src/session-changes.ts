/** One file in a session's changes. */
export interface ChangedFile {
	path: string;
	status: "added" | "modified" | "deleted" | "renamed" | "untracked";
	additions: number;
	deletions: number;
	previousPath?: string;
}

/** GET /api/sessions/:id/changes: the working copy against the point the session branched from. */
export interface SessionChanges {
	base: string;
	branch?: string;
	files: ChangedFile[];
	/** Unified diff, capped at 1 MiB. */
	diff: string;
	truncated: boolean;
}

/** GET /api/sessions/:id/changes/branch: branch/bookmark only, without scanning changed files. */
export interface SessionBranch {
	branch?: string;
}

/** GET /api/sessions/:id/changes/summary: change metadata without file details or a diff. */
export interface SessionChangeSummary {
	base: string;
	branch?: string;
	fileCount: number;
	additions: number;
	deletions: number;
}
