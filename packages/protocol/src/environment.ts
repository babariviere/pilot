/**
 * Project environment setup. See docs/environment-setup.md.
 *
 * The profile (ProjectEnvironment) is configuration saved on the Project in projects.json. Plans, readiness and
 * errors are per-host daemon state and never sync. Hosts advertise the feature with
 * DaemonCapabilities.environmentSetup; clients must not call environment routes on hosts without it.
 */

/** A file the profile was confirmed against. Paths are relative to the checkout, "/"-separated. */
export interface EnvironmentSourcePin {
	path: string;
	/** Lowercase hex SHA-256 of the file's bytes. */
	sha256: string;
}

/** Repository files whose content the user approved. Writing one requires the native host-action capability. */
export interface ReviewPin {
	files: EnvironmentSourcePin[];
	reviewedAt: number;
}

/** Where a confirmed value came from: a cited repository line, or the user. */
export type EnvironmentValueOrigin = { path: string; line: number } | "user";

export interface EnvironmentTool {
	/** A mise registry name ("go", "golangci-lint", "node") or a mise backend reference ("aqua:owner/repo"). There is
	 * no built-in tool table: mise installs, detects and runs every tool. */
	id: string;
	/** Exact version as confirmed, without a "v" or "go" prefix. */
	version: string;
	from: EnvironmentValueOrigin;
}

export type EnvironmentExportValue = "url" | "socketUrl" | "host" | "port" | "database" | "user";
export type EnvironmentDbAccess = "allow" | "ask";

export interface EnvironmentService {
	id: string;
	kind: "postgres";
	/** The project's declared major, for example "16". For the built-in database this is a compatibility check
	 * against the host's one Pilot server, whose version belongs to the host, not the project. */
	version: string;
	/** pilot: the built-in database. compose: the project's reviewed compose file. */
	provider: "pilot" | "compose";
	/** Logical database name for provider "pilot", at most 32 characters. Defaults to the project name. Each chat
	 * workspace gets its own physical database, <name>_<project prefix>_<workspace slug>; direct mode keeps one. */
	database?: string;
	/** Agent db tool access to the built-in database. false hides it. Defaults to allow/allow. */
	dbTool?: { read: EnvironmentDbAccess; write: EnvironmentDbAccess } | false;
	/** Variables exposed to steps, checks and agents, for example { DATABASE_URL: "url" }. */
	exports: Record<string, EnvironmentExportValue>;
	/** Provider "compose" only. Changing file or service clears the review. */
	compose?: { file: string; service: string; review?: ReviewPin };
}

/** Never a shell string. script is a checkout-relative path. */
export type EnvironmentStepRun = { argv: string[] } | { script: string; args?: string[] };

export interface EnvironmentStep {
	id: string;
	title: string;
	run: EnvironmentStepRun;
	/** Repository files the approval covers. Changing run clears it. */
	review?: ReviewPin;
	/** Rerun when any of these checkout-relative files change, or when check fails. */
	inputs: string[];
	/** Optional argv; exit 0 means already done. */
	check?: string[];
	/** Tool and service IDs that must be ready first. */
	requires: string[];
	/** Default 10 minutes, at most 60. */
	timeoutMs?: number;
}

/** Saved on the Project. Configuration only; never secrets, plans or results. */
export interface ProjectEnvironment {
	/** Assigned by the daemon. Optimistic concurrency for app and automation edits. */
	revision: number;
	tools: EnvironmentTool[];
	services: EnvironmentService[];
	steps: EnvironmentStep[];
	/** Non-secret variables for steps, checks and agents. Keys that look like secrets are rejected. */
	env?: Record<string, string>;
	/** Cited inputs the profile was confirmed against; drift is a mismatch against these. */
	confirmedSources: EnvironmentSourcePin[];
	/** Ignored local files (such as .env) copied from the main checkout into each workspace. Paths only: Pilot never
	 * reads, stores or syncs their contents. */
	copyFiles?: string[];
}

/**
 * One host's layer on top of the shared profile. Stored only in that host's projects.json, never synced, and it
 * always wins there: entries replace shared ones with the same ID, remove drops shared IDs, env merges by key and
 * copyFiles adds paths.
 */
export interface ProjectEnvironmentOverride {
	/** Assigned by the daemon, independent of the shared profile's revision. */
	revision: number;
	tools?: EnvironmentTool[];
	services?: EnvironmentService[];
	/** Review pins here are this host's own. */
	steps?: EnvironmentStep[];
	/** Shared tool, service or step IDs this host does not use. */
	remove?: string[];
	env?: Record<string, string>;
	copyFiles?: string[];
}

/** PUT /api/projects/:id/environment. The daemon assigns environment.revision = expectedRevision + 1.
 * Review pins can be added or changed only with the native host-action capability. */
export interface ProjectEnvironmentUpdateRequest {
	environment: Omit<ProjectEnvironment, "revision">;
	/** Current profile revision, 0 when the project has none. */
	expectedRevision: number;
}

/** HTTP 409 for a stale expectedRevision. Re-read, never overwrite automatically. */
export interface ProjectEnvironmentConflict {
	error: "environment_conflict";
	revision: number;
}

/** PUT /api/projects/:id/environment/override. Same revision and review-pin rules as the shared profile.
 * An empty layer ({}) clears every override while keeping the revision history. */
export interface ProjectEnvironmentOverrideUpdateRequest {
	override: Omit<ProjectEnvironmentOverride, "revision">;
	/** Current override revision, 0 when the project has none. */
	expectedRevision: number;
}

/** Where a finding was read. excerpt is at most 120 characters of the cited line. */
export interface EnvironmentFindingSource {
	path: string;
	line: number;
	excerpt: string;
	sha256: string;
}

export type EnvironmentFindingKind = "exact" | "minimum" | "range" | "major" | "hint" | "unknown";

/** One declaration read from a repository file. Discovery never executes anything. */
export interface EnvironmentFinding {
	/** Normalized: "go", "golangci-lint", "node", "pnpm", "postgres". */
	subject: string;
	kind: EnvironmentFindingKind;
	/** Normalized: "go1.23.4" and "v1.23.4" become "1.23.4". Ranges keep their text, for example ">=20". */
	value?: string;
	source: EnvironmentFindingSource;
	/** For example "provided by go tool" or "alias lts/*". */
	note?: string;
}

/**
 * proposed: exact findings agree and satisfy every constraint (services: a major version).
 * conflict: exact findings disagree or violate a constraint; the user picks one or enters a version.
 * needs_version: only constraints or unknown values; the user enters a version. Pilot never picks "latest".
 * hint_only: only README or CI mentions, which never choose a version.
 */
export type EnvironmentSubjectStatus = "proposed" | "conflict" | "needs_version" | "hint_only";

export interface EnvironmentSubject {
	subject: string;
	category: "tool" | "service";
	status: EnvironmentSubjectStatus;
	/** The proposed version (exact for tools, major for services). */
	value?: string;
	/** The finding the proposed value came from. */
	from?: { path: string; line: number };
	findings: EnvironmentFinding[];
	/** Hints that disagree with the proposal, and constraints that could not be checked. */
	notes: string[];
	/** Declared as a go.mod tool directive: `go tool <name>` provides it at the module version. */
	goTool?: boolean;
}

/** A setup step or post-run check proposed from a Makefile or justfile target. Never run by discovery. */
export interface EnvironmentStepCandidate {
	id: string;
	title: string;
	run: { argv: string[] };
	purpose: "setup" | "check";
	/** The single suggested setup step, when there is an obvious one. */
	proposed: boolean;
	source: EnvironmentFindingSource;
}

/** GET /api/projects/:id/environment/discovery. Read-only and bounded; never runs repository content. */
export interface EnvironmentDiscovery {
	projectId: string;
	computedAt: number;
	subjects: EnvironmentSubject[];
	steps: EnvironmentStepCandidate[];
	/** Every file read, with its hash, for confirmedSources. */
	sources: EnvironmentSourcePin[];
	/** Files skipped because of bounds, links or non-regular files. */
	skipped: { path: string; reason: "too_large" | "not_regular" | "limit" | "unreadable" }[];
	/** A file, total-byte or count bound was hit; findings may be incomplete. */
	truncated: boolean;
	/** Root .env and .env.* files that Git ignores, by name only (never opened): suggestions for copyFiles. */
	localFiles: string[];
}

/** The daemon that computed a plan or raised an error. Clients add the display name they know. */
export interface EnvironmentHostRef {
	daemonId: string;
	lineageId?: string;
	platform: string;
	arch: string;
}

export type EnvironmentPlanAction = "none" | "install" | "start" | "review" | "run" | "manual";
/** docker: Pilot's Postgres container on hosts without Homebrew or system Postgres. */
export type EnvironmentInstaller = "mise" | "go-tool" | "homebrew" | "docker" | "system" | "compose" | "pilot";

export interface EnvironmentPlanItem {
	/** "go", "postgres", "mise", "step:setup". */
	subject: string;
	required: string;
	/** What the probes found at a matching version, or the closest candidate. */
	present?: { version: string; path: string };
	action: EnvironmentPlanAction;
	installer?: EnvironmentInstaller;
	/** Exact argv Pilot would run. For approval "user-runs", the commands the user would run. */
	commands: string[][];
	/** plan: covered by confirming the plan. user-runs: Pilot never runs these (sudo, manual installs). */
	approval: "plan" | "user-runs";
	/** Network hosts involved. Sizes are omitted when unknown; Pilot never guesses them. */
	impact: { network: string[]; downloadBytes?: number; diskBytes?: number };
	note?: string;
}

/** GET /api/projects/:id/environment/plan. A preview: computing it changes nothing on the host. */
export interface EnvironmentPlan {
	host: EnvironmentHostRef;
	projectId: string;
	/** Shared profile revision. */
	profileRevision: number;
	/** This host's override revision, 0 when it has none. */
	overrideRevision: number;
	/** SHA-256 covering both revisions, probe results and items. Applying requires the current hash. */
	planHash: string;
	computedAt: number;
	items: EnvironmentPlanItem[];
}

export type EnvironmentReadinessState = "ready" | "setting_up" | "not_ready" | "unknown";

export interface EnvironmentItemReadiness {
	/** Profile tool, service or step ID. */
	id: string;
	kind: "tool" | "service" | "step";
	state: "ready" | "not_ready" | "unknown";
	version?: string;
	checkedAt?: number;
	/** Short reason for not_ready, for example "missing" or "needs review". */
	detail?: string;
}

/** Readiness of one workspace (steps) on one host (tools and services). Unknown is never shown as ready. */
export interface EnvironmentReadiness {
	state: EnvironmentReadinessState;
	/** The workspace's source files drift from the profile. */
	outdated?: boolean;
	checkedAt?: number;
	items: EnvironmentItemReadiness[];
	/** First failing check, with its suggested fix. */
	error?: EnvironmentError;
}

/** Offline host index entry: no commands, paths or output. */
export interface EnvironmentReadinessSummary {
	projectId: string;
	state: EnvironmentReadinessState;
	checkedAt?: number;
	items: { id: string; version?: string; state: EnvironmentItemReadiness["state"] }[];
}

export interface EnvironmentError {
	/** "Install golangci-lint 1.61.0", "Start Postgres 16", "make setup". */
	step: string;
	host: { ref: EnvironmentHostRef; name: string };
	/** Display argv, redacted. */
	command: string;
	/** "exit 2", "timed out after 10 min", "interrupted", "needs review". */
	outcome: string;
	/** Last 40 lines, at most 4 KiB, redacted. */
	output: string;
	/** One or two sentences from a fixed table, never from a model. */
	fix: string;
	at: number;
}

/** Error codes for environment routes. */
export interface EnvironmentRouteError {
	error: "environment_unavailable" | "invalid_environment" | "native_action_required";
	message?: string;
}
