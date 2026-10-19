/** Host-local settings. Responses never carry connection URLs or credential query parameters. */
export interface DatabaseConnectionSettings {
	scheme: string;
	host: string;
	port: string;
	database: string;
	user: string;
	hasCredentials: boolean;
	access: "ask" | "allow";
}
export interface DatabaseEnvironmentSettings {
	name: string;
	read?: DatabaseConnectionSettings;
	write?: DatabaseConnectionSettings;
}
export interface ProjectDatabaseSettings {
	revision: string;
	environments: DatabaseEnvironmentSettings[];
}
export interface DatabaseConnectionUpdate {
	/** Omit to retain the stored URL, including all credentials and parameters. */
	url?: string;
	/** Omit to retain the stored policy (or the default ask for a new connection). */
	access?: "ask" | "allow";
}
export interface ProjectDatabaseSettingsUpdate {
	revision: string;
	/** Replaces this project's environment list only. Omitted modes/environments are removed. */
	environments: { name: string; read?: DatabaseConnectionUpdate; write?: DatabaseConnectionUpdate }[];
}
