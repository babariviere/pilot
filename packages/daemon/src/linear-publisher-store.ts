import type { SQLInputValue } from "node:sqlite";

export interface IssueText {
	title: string;
	description: string;
}
export interface IssueIdentity {
	uuid: string;
	identifier: string;
	url: string;
}
interface Mapping extends IssueIdentity {
	taskId: string;
	title: string;
	baseline: IssueText;
}
interface Edge {
	from: string;
	to: string;
}
export type Pending =
	| { kind: "create" | "update"; taskId: string; after: IssueText; marker: string; uuid?: string; guard?: string }
	| { kind: "link"; from: string; to: string };

export interface PublisherState {
	parent?: IssueIdentity & { teamId: string };
	mappings: Mapping[];
	edges: Edge[];
	pending?: Pending;
}

export const LINEAR_PUBLISHER_SCHEMA = `
CREATE TABLE IF NOT EXISTS linear_publisher_projects (
	project_id TEXT PRIMARY KEY,
	revision INTEGER NOT NULL,
	enabled INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS linear_publisher_missions (
	mission_id TEXT PRIMARY KEY,
	state TEXT NOT NULL
);
`;

interface Port {
	one(sql: string, ...params: SQLInputValue[]): Record<string, SQLInputValue> | undefined;
	run(sql: string, ...params: SQLInputValue[]): void;
	transaction<T>(work: () => T): T;
	durable(): Promise<void>;
}

/** Keep issue identities even if a task is dropped. Do not touch mission links or status management. */
export class LinearPublisherStore {
	private readonly port: Port;
	constructor(port: Port) {
		this.port = port;
	}
	durable() {
		return this.port.durable();
	}
	setting(projectId: string) {
		const row = this.port.one(
			"SELECT revision, enabled FROM linear_publisher_projects WHERE project_id=?",
			projectId,
		);
		return { revision: Number(row?.revision ?? 0), enabled: row?.enabled === 1 };
	}
	async set(projectId: string, enabled: boolean) {
		this.port.transaction(() =>
			this.port.run(
				`INSERT INTO linear_publisher_projects (project_id, revision, enabled) VALUES (?, 1, ?)
			 ON CONFLICT(project_id) DO UPDATE SET revision=revision+1, enabled=excluded.enabled`,
				projectId,
				Number(enabled),
			),
		);
		await this.port.durable();
	}
	get(missionId: string): PublisherState {
		const row = this.port.one("SELECT state FROM linear_publisher_missions WHERE mission_id=?", missionId);
		return row ? (JSON.parse(String(row.state)) as PublisherState) : { mappings: [], edges: [] };
	}
	async save(missionId: string, state: PublisherState) {
		this.port.transaction(() =>
			this.port.run(
				`INSERT INTO linear_publisher_missions (mission_id, state) VALUES (?, ?)
			 ON CONFLICT(mission_id) DO UPDATE SET state=excluded.state`,
				missionId,
				JSON.stringify(state),
			),
		);
		await this.port.durable();
	}
}
