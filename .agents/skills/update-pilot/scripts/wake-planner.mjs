// Asks the idle planner of one planning mission to continue (plan-continue). Usage: wake-planner.mjs MISSION_ID
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const [missionId] = process.argv.slice(2);
if (!missionId) throw new Error("Usage: wake-planner.mjs MISSION_ID");
const home = process.env.PILOT_HOME ?? join(homedir(), ".local/share/pilot");
const base = "http://127.0.0.1:4319";
const db = new DatabaseSync(join(home, "missions.sqlite"), { readOnly: true });
const projectId = db.prepare("select project_id from missions where id = ?").get(missionId)?.project_id;
db.close();
if (!projectId) throw new Error(`No mission ${missionId}`);
const token = JSON.parse(readFileSync(join(home, "github-app-capability"), "utf8")).token;
const headers = { "x-pilot-github-capability": token, "content-type": "application/json" };
const hello = await (await fetch(`${base}/api/hello`)).json();
const read = await (
	await fetch(`${base}/api/projects/${projectId}/missions/${missionId}/planning`, { headers })
).json();
console.log("continuePlanning", JSON.stringify(read.continuePlanning));
if (!read.continuePlanning?.available) process.exit(1);
const payload = JSON.stringify({ purpose: "plan-continue" });
const host = { daemonId: hello.daemonId, lineageId: hello.lineageId };
const op = {
	schemaVersion: 1,
	operationId: randomUUID(),
	producerId: randomUUID(),
	sequence: 1,
	origin: { ...host, hostId: "local" },
	destination: { ...host, hostId: "daemon" },
	targetId: missionId,
	kind: "plan-continue",
	payload,
	payloadHash: createHash("sha256").update(payload).digest("hex"),
	bindingId: read.continuePlanning.contextDigest,
	bindingGeneration: 1,
};
const r = await fetch(`${base}/api/operations`, { method: "POST", headers, body: JSON.stringify(op) });
console.log(r.status, JSON.stringify(await r.json()));
if (!r.ok) process.exit(1);
