export interface GitHubRepositoryChoice {
	name: string;
	url: string;
	private: boolean;
}
export interface GitHubRepositoryChoices {
	repositories: GitHubRepositoryChoice[];
	truncated: boolean;
}
export interface GitHubImportRequest {
	id: string;
	url: string;
	destination: string;
}
export interface GitHubImportOperation {
	id: string;
	url: string;
	destination: string;
	phase: "queued" | "cloning" | "registering" | "confirm_existing" | "interrupted" | "cancelled" | "failed" | "done";
	projectId?: string;
	problem?: string;
}
