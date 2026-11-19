/** Disposable configuration fixture. No accounts, credentials, source history or worker activation. */
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DayInsightsPayload, DayInsightsSettings, DurableOperation, ModelOption } from "@pilot/protocol";
import { DayInsights } from "../day-insights.ts";
import { InsightsWorkspace } from "../insights-workspace.ts";
import { MissionService } from "../mission-service.ts";
import { MissionStore } from "../missions.ts";
import type { ModelCatalog } from "../models.ts";
import { OperationJournal, payloadHash } from "../operation-journal.ts";
import { ProjectStore } from "../projects.ts";
import { SessionManager } from "../sessions.ts";
import { TerminalManager } from "../terminals.ts";
import { createDaemonFixtureServer } from "./daemon-server.ts";
import { offlineSessionOptions } from "./offline-session-options.ts";

export async function createDayInsightsFixture() {
	const root = await mkdtemp(join(tmpdir(), "pilot-day-insights-"));
	const home = join(root, "home"),
		path = join(root, "source-project");
	await mkdir(path);
	const projects = new ProjectStore(home);
	await projects.load();
	const project = await projects.create({ path });
	const store = new MissionStore(join(home, "missions.sqlite"));
	const host = { hostId: "daemon", daemonId: "synthetic-day", lineageId: "synthetic-day" };
	const journal = new OperationJournal(join(home, "operations"), host);
	const model: ModelOption = {
		id: "synthetic/terra",
		provider: "synthetic",
		name: "Terra 6.1",
		thinkingLevels: ["low", "high"],
	};
	let catalog = [model],
		calls = 0;
	const models = {
		list: async () => {
			calls++;
			return { models: catalog };
		},
	};
	const service = new DayInsights({
		home,
		host,
		admissionEpoch: "synthetic-day-epoch",
		projects,
		models,
		store: store.dayInsights,
		workspace: store.insightsWorkspace,
	});
	const settings: DayInsightsSettings = {
		model: model.id,
		source: { projects: [project.id], excludeProjects: [], excludeSessions: [] },
		weekly: null,
		allowance: { perReportMicros: 1000000, monthlyMicros: 10000000, basis: "catalog_estimate" },
	};
	let sequence = 0;
	const operation = (payload: DayInsightsPayload): DurableOperation => {
		const raw = JSON.stringify(payload);
		return {
			schemaVersion: 1,
			operationId: randomUUID(),
			producerId: "native-day-fixture",
			sequence: ++sequence,
			origin: { ...host, hostId: "local" },
			destination: { ...host, hostId: "local" },
			kind: "day-insights",
			targetId: payload.owner.workspaceId,
			payload: raw,
			payloadHash: payloadHash(raw),
		};
	};
	return {
		home,
		root,
		host,
		projects,
		project,
		store,
		journal,
		service,
		models,
		model,
		settings,
		operation,
		catalogCalls: () => calls,
		setCatalog: (value: ModelOption[]) => {
			catalog = value;
		},
		run: (op: DurableOperation) => journal.execute(op, (op, entry) => service.admit(op, entry.firstEntry)),
		close: async () => {
			await store.close();
			await rm(root, { recursive: true, force: true });
		},
	};
}

/** Host tracking claims only. No grant/session/rule/provider is created. */
export async function seedDayInsightsTracking(f: Awaited<ReturnType<typeof createDayInsightsFixture>>) {
	const workspace = new InsightsWorkspace({
		home: f.home,
		host: f.host,
		projects: f.projects,
		models: f.models,
		store: f.store.insightsWorkspace,
		journal: f.journal,
		legacyGuard: () => {},
	});
	const preview = await workspace.preflight(f.project.id, f.model.id);
	if (!preview.payload) throw new Error(preview.reason ?? "Fixture reservation unavailable");
	const owner = preview.payload.owner,
		raw = JSON.stringify(preview.payload);
	const reservation: DurableOperation = {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: "native-tracking-fixture",
		sequence: 1,
		origin: { ...f.host, hostId: "local" },
		destination: { ...f.host, hostId: "local" },
		kind: "insights-workspace-reserve",
		targetId: owner.workspaceId,
		payload: raw,
		payloadHash: payloadHash(raw),
	};
	const receipt = await f.journal.execute(reservation, (op) => workspace.admit(op));
	if (receipt.state !== "accepted") throw new Error("Fixture reservation refused");
	const authority = { owner, home: f.home, projectPath: f.project.path };
	const lease = {
		authority,
		revision: 1,
		revalidate: () => {
			f.store.insightsWorkspace.current(authority);
		},
	};
	const findingKey = randomUUID(),
		reportKey = randomUUID();
	await f.store.insightsWorkspace.write(
		lease,
		JSON.stringify({
			action: "propose",
			key: findingKey,
			expectedRevision: 0,
			operationId: randomUUID(),
			patternKey: "synthetic-repeated-searches",
			evidence: [],
			draft: {
				title: "Repeated source searches",
				priority: "medium",
				observation: "Synthetic report repeats repository searches.",
				uncertainty: "No live history or measured saving.",
				proposedChange: "Test a small reusable context note.",
				expectedBenefit: "Fewer repeated searches; unverified.",
				targets: [],
				implementationLinks: [],
			},
		}),
	);
	await f.store.insightsWorkspace.write(
		lease,
		JSON.stringify({
			action: "save_report",
			key: reportKey,
			expectedRevision: 0,
			operationId: randomUUID(),
			record: {
				status: "partial",
				windowStart: "2026-11-01T00:00:00Z",
				windowEnd: "2026-11-02T00:00:00Z",
				markdown: "Synthetic partial review. One possible repeated-search pattern needs user review.",
				checkpoints: [],
				findingKeys: [findingKey],
				gaps: ["Synthetic fixture only; source history was not read."],
			},
		}),
	);
	return { owner, findingKey, reportKey, workspace };
}

/** Real loopback HTTP fixture for the native app. Caller owns close(); never use the user's home. */
export async function startDayInsightsFixture() {
	const f = await createDayInsightsFixture();
	let starts = 0;
	const sessions = new SessionManager(
		f.home,
		f.projects,
		undefined,
		{
			worker: () => {
				starts++;
				throw new Error("Day fixture forbids every worker start");
			},
		},
		{},
		offlineSessionOptions({ diagnosticHost: f.host }),
	);
	const missionService = new MissionService(f.store, sessions, f.projects);
	await sessions.load();
	const server = createDaemonFixtureServer({
		config: { home: f.home, host: "127.0.0.1", port: 0 },
		sessions,
		projects: f.projects,
		models: f.models as unknown as ModelCatalog,
		terminals: new TerminalManager(),
		missions: { store: f.store, service: missionService },
		nativeAuthority: {
			authenticate: async (token: unknown) => {
				if (token !== "synthetic-day-native") throw new Error("Native fixture capability required");
			},
		},
		hello: {
			...f.host,
			daemonVersion: "synthetic-day",
			protocolVersion: 1,
			minimumClientProtocolVersion: 1,
			platform: "darwin",
			arch: "arm64",
			capabilities: {
				powerManagement: false,
				systemSleepEvents: false,
				swiftUIArtifacts: false,
				coordinatorIsolation: true,
				independentExecution: true,
			},
		},
	});
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	return {
		...f,
		server,
		sessions,
		nativeToken: "synthetic-day-native",
		starts: () => starts,
		url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
		close: async () => {
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			await sessions.shutdown();
			await f.close();
		},
	};
}
