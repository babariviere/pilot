import type { DurableOperation, MissionThread } from "@pilot/protocol";
import { Conflict, NotFound } from "../../runtime/contracts/errors.ts";
import { canonicalJSON, payloadHash } from "../../transport/operations/operation-journal.ts";
import type { MissionDbPort } from "../mission-database.ts";

export const MISSION_THREAD_SCHEMA = `
CREATE TABLE IF NOT EXISTS mission_threads (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY(mission_id,id)
);
CREATE TABLE IF NOT EXISTS mission_thread_events (
 mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
 operation_id TEXT NOT NULL, digest TEXT NOT NULL, result TEXT NOT NULL,
 PRIMARY KEY(mission_id,operation_id)
);`;
/** Only topic metadata and immutable operation results. Original entries stay in session storage. */
export class MissionThreadStore {
	private readonly port: MissionDbPort;
	constructor(port: MissionDbPort) {
		this.port = port;
	}
	list(id: string): MissionThread[] {
		return this.port
			.all("SELECT record FROM mission_threads WHERE mission_id=? ORDER BY rowid", id)
			.map((r) => JSON.parse(String(r.record)));
	}
	get(id: string, topicId: string): MissionThread {
		const row = this.port.one("SELECT record FROM mission_threads WHERE mission_id=? AND id=?", id, topicId);
		if (!row) throw new NotFound("Unknown mission topic");
		return JSON.parse(String(row.record));
	}
	lookup(op: DurableOperation): MissionThread | undefined {
		const row = this.port.one(
			"SELECT digest,result FROM mission_thread_events WHERE mission_id=? AND operation_id=?",
			op.targetId,
			op.operationId,
		);
		if (!row) return;
		if (row.digest !== payloadHash(canonicalJSON(op))) throw new Conflict("Topic operation identity changed");
		return JSON.parse(String(row.result));
	}
	write(op: DurableOperation, work: () => MissionThread): MissionThread {
		return this.port.transaction(() => {
			const prior = this.lookup(op);
			if (prior) return prior;
			const count = this.port.one("SELECT COUNT(*) n FROM mission_thread_events WHERE mission_id=?", op.targetId);
			if (Number(count?.n) >= 2048) throw new Conflict("Topic event storage is full");
			const topic = work();
			this.port.run(
				"INSERT INTO mission_threads VALUES(?,?,?) ON CONFLICT(mission_id,id) DO UPDATE SET record=excluded.record",
				op.targetId,
				topic.id,
				canonicalJSON(topic),
			);
			this.port.run(
				"INSERT INTO mission_thread_events VALUES(?,?,?,?)",
				op.targetId,
				op.operationId,
				payloadHash(canonicalJSON(op)),
				canonicalJSON(topic),
			);
			return topic;
		});
	}
	/**
	 * Pilot's own change to a topic (its thread chat, handoff, resolution or moved history), not a user operation:
	 * no operation event, a new revision. Returns the saved topic.
	 */
	amend(id: string, topicId: string, change: (topic: MissionThread) => void): MissionThread {
		const saved = this.port.transaction(() => {
			const topic = this.get(id, topicId);
			change(topic);
			topic.revision++;
			this.port.run(
				"UPDATE mission_threads SET record=? WHERE mission_id=? AND id=?",
				canonicalJSON(topic),
				id,
				topicId,
			);
			return topic;
		});
		this.port.changed(id);
		return saved;
	}
	/** The open or later topic whose thread chat is `sessionId`, if any. */
	ofChat(id: string, sessionId: string): MissionThread | undefined {
		return this.list(id).find((t) => t.chat?.sessionId === sessionId);
	}
}
