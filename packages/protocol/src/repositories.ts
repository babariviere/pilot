/** All paths are daemon-relative strings, never client file URLs. */
export interface RepositoryDirectory {
	name: string;
	path: string;
}
export interface RepositoryDirectoryPage {
	rootId: string;
	path: string;
	entries: RepositoryDirectory[];
	nextOffset?: number;
	truncated: boolean;
}
export interface RepositorySelection {
	rootId: string;
	path: string;
}
export interface SessionFileContent {
	path: string;
	text: string;
	truncated: boolean;
	binary: boolean;
}
