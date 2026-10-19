# Project environment setup (design)

**Status: design proposal, not implemented.** Section 13 records the choices confirmed in review; the final
design is confirmed before implementation starts.
It extends the planned lifecycle hooks (setup on workspace creation and after restore) with reproducible
toolchains, a built-in database and reviewed project scripts. Scope is **setup only**: there are no teardown scripts,
archive-time hooks or automatic service shutdown.

A project's environment goes through five stages. The profile is shared by the project's linked hosts; every
other stage runs on the host that runs the chats:

1. **Discover** declared versions, services and setup entry points by reading repository files. Nothing runs.
2. **Profile**: the user confirms what the project needs. It is saved in daemon project settings as a shared
   layer synced to the project's linked hosts, plus an optional override layer per host.
3. **Plan**: the host's daemon checks what is present and proposes installs, without changing anything.
4. **Apply**: after confirmation in the app, the daemon installs missing tools and starts the built-in database.
   Each new or restored workspace then gets the listed local files, its own database and the reviewed project steps.
5. **Ready**: readiness checks say whether the workspace can build and test, and post-run checks rely on them.

## Goals and boundaries

- Get a fresh or restored workspace ready to work without guessing versions or running unreviewed code.
- Every install or script run is previewed per host and confirmed in the app. Chat messages and agents never
  approve anything.
- Steps are idempotent, so reruns after restore, version bumps and failures are safe.
- Setup never touches existing databases, credentials or secrets. Services it creates belong to Pilot. It copies
  the local files the user lists (such as `.env`) without reading, storing or syncing their contents.
- Toolchains come from mise. Pilot keeps no table of known tools: tool IDs are mise registry names.
- Each chat workspace gets its own built-in Postgres database on any host, for setup steps, checks and the agent's
  `db` tool, so parallel chats never share migrations.
- Not in scope: teardown or cleanup on archive, copying installs or plans between hosts, cloud
  environments, container images for whole workspaces, and services other than Postgres in the first version.

Prior art: Berth gives each worktree its own ports and a slug used in database names, layers repository config,
kits and each machine's own config (most specific wins), and pins repository config by hash. Pilot follows the
same shape with per-workspace databases (section 5), a shared profile with a per-host override (section 2) and
hash-pinned script review (section 4). Conductor copies ignored files such as `.env` into new workspaces, as
local files do here (section 2). Cursor and Devin recommend agent-led setup, and Devin keeps lint and test
commands as context it never runs; both are later work (section 15).

## What this builds on

| Existing piece | How environment setup uses it |
| --- | --- |
| `ProjectStore` (`packages/daemon/src/projects.ts`), `projects.json` with atomic writes and validated sub-objects such as `tracking` | The profile is a new validated `environment` object on `Project`, like other automation settings |
| Workspace preparation in `SessionManager` (`meta.preparing` → `meta.workspace` saved → `dissociate` → worker start) | The `workspace.created` trigger fires after `meta.workspace` is saved, before the first turn is admitted |
| Workspace restore (`restoreWorkspaceHeld`, `meta.workspaceReset`) and legacy clone pruning | The `workspace.restored` trigger fires where `workspaceReset` is set today. The kernel already tells the agent that dependencies are gone; setup reinstalls them instead |
| `copyLocalConfigs` copies ignored `mise.local.toml` variants into new workspaces | Discovery reads those copies as user-level declarations, never runs mise on them. Local files (section 2) extend the same copy rules to the files a profile lists |
| `subprocesses` pool and `run` (`subprocess.ts`, `workspaces.ts`): off-thread, detached process groups, timeouts, output caps | Probes, installs and steps run through the planned bounded shell runner, built on this pool |
| `runtimeEnvironment` (`packages/kernel/src/runtime-environment.ts`): sparse PATH, never sources login files | Probes use the same rule. Resolved tool directories are prepended to the agent's and checks' PATH instead of relying on shell activation |
| Native host-action capability (`x-pilot-github-capability`, read over verified SSH or the local filesystem), used by model scope and GitHub setup | Required for saving approvals, confirming plans and approving scripts. Never exposed to agents |
| Database grants: app decision → pilotd request ID, messages never grant | Same rule for install and script approvals |
| `db` tool and `pilot-databases.json` (`databases.ts`): per-project environments, read and write connections, `allow` or `ask` | The chat's built-in database is added as an environment in memory; the user's file is never edited |
| Scoped models sync (`docs/devboxes.md`): saved intent on the Mac, per-host apply with hash checks, Synced, Pending and Conflict states | Same saved intent and per-host apply for the shared profile layer, without a Conflict state (section 2) |
| mise registry and install records (`mise registry`, `<mise data>/installs/<tool>/<version>`) | Tool IDs and the app's tool picker come from the host's registry; presence is read from install records |
| `RepositoryBindings` and **Set up on devbox**: explicit, host-qualified links between a project's placements | Defines which projects share a profile. Matching names or paths never link projects |
| Linux bootstrap prerequisite plans (`docs/ssh-bootstrap.md`): detects apt/dnf/yum, reports argv plans, never runs sudo | Same installer detection and the same "show, never run sudo" rule |
| `DaemonCapabilities` in hello, offline host index (`docs/remote-lifecycle.md`) | A new capability flag gates the feature per host; the offline index keeps a small readiness summary |
| `NeedsYouReason`, one-line automatic timeline events (`AutomaticEvents.swift`), `redactDiagnosticText` | Environment errors use one new reason kind and one event kind, with redacted output |
| `credential-setup` (`setup.ts`, `SetupService`) | Unrelated. To avoid confusion, code and UI call this feature **Environment**, not Setup |

## 1. Discovery

Discovery reads a fixed list of files from the project's checkout on the host (`project.path`), or from a
chat's workspace when checking for drift. It never executes anything: no `mise`, `make`, `just`, `go`,
`npm`, `docker compose config` or shell. Several of these tools run repository content when invoked
(mise `[env]` and `[hooks]`, Makefile `$(shell …)`, `go` toolchain downloads, compose interpolation), so
discovery parses the files itself.

### Sources

| Source | What is read | Finding |
| --- | --- | --- |
| `.tool-versions` | `tool version…` lines; first version is the default, others listed | exact per tool |
| `mise.toml`, `.mise.toml`, `mise/config.toml`, `.config/mise.toml` and the copied `mise.local.toml` variants | `[tools]` values (string, array, or table with `version`) | exact, or range for prefixes such as `"1.23"` |
| `go.mod` | `go` line (minimum toolchain since Go 1.21), `toolchain` line, `tool` directives (Go 1.24+) | `go` minimum, `toolchain` exact; `tool` entries mark tools provided through `go tool` at the required module version |
| `.go-version`, `.nvmrc`, `.node-version`, `.python-version` | first non-comment line | exact; aliases such as `lts/*` become an unknown version with the alias shown |
| `package.json` | `packageManager` (`pnpm@9.12.0+sha512…`), `engines.node` | exact package manager (hash kept for integrity), node range |
| `compose.yaml`, `compose.yml`, `docker-compose.yml`, `docker-compose.yaml` | services' `image`, `ports`, `healthcheck`, environment variable **names** | service and major version from the image tag (`postgres:16-alpine` → postgres 16); `latest` or no tag is unknown |
| `Makefile`, `GNUmakefile`, `justfile`, `.justfile` | target and recipe names; literal `*_VERSION` assignments (`GOLANGCI_LINT_VERSION ?= v1.61.0`) | candidate setup steps and checks (`setup`, `bootstrap`, `deps`, `tools`, `migrate`, `lint`, `test`); exact pins for named tools |
| `README.md`, `CONTRIBUTING.md` (first 64 KiB) | phrases such as "Go 1.22+" or "PostgreSQL 15 or later" | hint only |
| `.github/workflows/*.yml` (at most 32 files) | `setup-go`/`setup-node` versions, `golangci-lint-action` version, `services` images | hint only (see open questions) |

Bounds: at most 64 files, 256 KiB each and 2 MiB total. Files are opened relative to the checkout with the
same rules as the session file route: regular files only, no symlinks or traversal. Parsing runs off the
daemon event loop. Secret values are never kept: compose environment values, `.env` files and anything
that looks like a credential are not read into findings.

Discovery also suggests **local files** (section 2): ignored files at the checkout root named `.env` or
`.env.*`, listed by name only with the same `git ls-files --others --ignored` call `copyLocalConfigs` uses.
Their contents are never opened.

### Findings and conflicts

Each finding cites its source:

```ts
interface EnvironmentFinding {
	subject: string; // mise registry name ("go", "golangci-lint", "node", "pnpm"), or "postgres"
	kind: "exact" | "minimum" | "range" | "major" | "hint" | "unknown";
	value?: string; // normalized: "go1.23.4" and "v1.23.4" become "1.23.4"
	source: { path: string; line: number; excerpt: string; sha256: string }; // excerpt ≤ 120 chars
}
```

Tool subjects are mise registry names; there is no Pilot table of known tools. Discovery maps the files it
understands to registry names (`go.mod` → `go`, `.nvmrc` → `node`, `packageManager` → `pnpm`), resolves
aliases the way mise does (`golang` → `go`), and lower-cases Makefile `*_VERSION` names with dashes
(`GOLANGCI_LINT_VERSION` → `golangci-lint`). A name the host's registry does not know is shown as unknown, not
dropped. Postgres is not a tool: `postgresql` findings become the `postgres` service subject. Each subject
resolves to one of:

- **Proposed**: all exact findings agree and satisfy every minimum, range and major finding.
- **Conflict**: exact findings disagree, or an exact value violates a constraint from another declaration.
  The app lists every finding with its file and line, and the user picks one or enters a version. Conflicts
  block only that subject; the rest of the profile can still be saved.
- **Needs a version**: only constraints exist (for example `go 1.22` without a `toolchain` line). The plan
  offers versions already present on the host that satisfy them; otherwise the user enters one. Pilot never
  picks "latest".
- Hints never choose a version. A hint that disagrees with the chosen version shows as a note, not a conflict
  ("README mentions Go 1.21+").

The chosen version records where it came from (`source` finding, or `user`), so the app can show
"Go 1.23.4 from go.mod:5" and detect drift later.

## 2. Profile

The profile lives on the `Project` record in each host's `projects.json`, next to the automation
definitions, never in the repository. It holds configuration only. Probe results, plans, run records and readiness live in
daemon state, not in `projects.json`.

```ts
interface ProjectEnvironment {
	revision: number; // optimistic concurrency for app and automation-agent edits
	tools: EnvironmentTool[];
	services: EnvironmentService[];
	steps: EnvironmentStep[];
	/** Non-secret variables for steps, checks and agents. Keys that look like secrets are rejected. */
	env?: Record<string, string>;
	/** Cited inputs the profile was confirmed against; drift is a mismatch against these. */
	confirmedSources: { path: string; sha256: string }[];
	/** Ignored local files copied from the main checkout into each workspace (see Local files). Paths only. */
	copyFiles?: string[]; // e.g. [".env", ".env.local"]
}

interface EnvironmentTool {
	id: string; // mise registry name: "go", "golangci-lint"
	version: string; // exact, as confirmed
	from: { path: string; line: number } | "user";
}

interface EnvironmentService {
	id: string; // "postgres"
	kind: "postgres";
	version: string; // major the project declares, e.g. "16"; checked against the host's server (section 5)
	provider: "pilot" | "compose"; // pilot: built-in database (section 5); compose: reviewed compose file
	database?: string; // logical name for provider "pilot", at most 32 characters, defaults to the project name
	/** Agent db tool access to the built-in database; false hides it from the tool. */
	dbTool?: { read: "allow" | "ask"; write: "allow" | "ask" } | false; // default allow, allow
	/** Variables exposed to steps, checks and agents, e.g. { DATABASE_URL: "url" }. */
	exports: Record<string, "url" | "socketUrl" | "host" | "port" | "database" | "user">;
	compose?: { file: string; service: string; review?: ReviewPin }; // provider "compose" only
}

interface EnvironmentStep {
	id: string;
	title: string; // "Download Go modules"
	run: { argv: string[] } | { script: string; args?: string[] }; // never a shell string
	/** Repository files whose content the approval covers. */
	review?: ReviewPin;
	/** Rerun when any of these files change, or when the check fails. */
	inputs: string[]; // e.g. ["go.sum"]
	check?: string[]; // optional argv; exit 0 means already done
	requires: string[]; // tool and service IDs that must be ready first
	timeoutMs?: number; // default 10 minutes, at most 60
}

interface ReviewPin {
	files: { path: string; sha256: string }[];
	reviewedAt: number;
}

/** One host's layer. Stored only in that host's projects.json, never synced. It wins over the shared profile. */
interface ProjectEnvironmentOverride {
	revision: number;
	tools?: EnvironmentTool[]; // replace or add, matched by id
	services?: EnvironmentService[]; // replace or add, matched by id
	steps?: EnvironmentStep[]; // replace or add, matched by id; review pins here are this host's own
	remove?: string[]; // shared tool, service or step IDs this host does not use
	env?: Record<string, string>; // merged by key
	copyFiles?: string[]; // added to the shared list
}
```

Tools are added in the app from the host's mise registry, so any tool mise knows can be pinned. Installers are not
part of the profile: they depend on the host, so the plan chooses them (section 3).

**Layered sync across hosts.** A Local project and a devbox project for the same repository are different projects
on different daemons. When they are explicitly linked (a `RepositoryBindings` placement, for example created by
**Set up on devbox**), they share one profile layer, and each host can add its own override layer on top. The
**effective profile** on a host is the shared layer with that host's override applied: override entries replace
shared entries with the same ID, `remove` drops shared entries, `env` merges by key and `copyFiles` adds paths.
Plans, readiness and setup always use the effective profile. This mirrors Berth's repository, kit and machine
layers, where the most specific layer wins.

- **Shared layer**: the app saves the intent for the linked project first, then writes it to each host's project
  with the host's current revision, as scoped models do. Each host shows **Synced** or **Pending** (offline;
  applied after a verified reconnect). Startup and verified reconnect reconcile pending work without polling.
- **Override layer**: edited in the Environment section with **This host only** on a row, written directly to that
  host and never synced. Overridden rows say so ("Go 1.23.2 on devbox-1, overrides 1.23.4"), and removing the
  override restores the shared value. Shared updates never touch an override.
- **No conflict prompts.** Each layer has one writer: the shared layer is written only from the saved intent, and
  writers that act on one host (the user's host-only edits, the planned automation agent running there) write that
  host's override. If a host's shared copy still differs from the intent at reconcile (an older client, a restored
  `projects.json`), the intent wins and the Environment section notes it once. A stale revision on either layer is
  the existing 409: re-read and retry, never an automatic overwrite.
- Synced: the shared layer's tools, services, steps, `env`, `copyFiles`, `confirmedSources` and review pins.
  Not synced: override layers, plans, probe results, installs, plan confirmations, readiness, logs, local file
  contents and the built-in database's passwords.
- A synced profile never runs anything by itself. A host installs tools and runs steps only after the user
  has confirmed a plan for that host at least once (section 3).

Unlinked projects keep independent profiles. Matching names, paths or repository URLs never link them.

**Local files.** `copyFiles` lists checkout-relative paths of ignored files a workspace needs but Git does not
carry, such as `.env` or `.env.local`. At `workspace.created` and `workspace.restored`, before any step runs,
setup copies each one from the project's main checkout on the same host (`project.path`) into the workspace, with
the rules `copyLocalConfigs` already applies to `mise.local.toml`:

- Only regular files that Git ignores in the main checkout: no symlinks, directories, tracked files, traversal or
  `.git`/`.jj` paths. At most 32 entries and 1 MiB per file.
- A file that already exists in the workspace is never replaced, so a restored workspace or an agent's edit keeps
  its version. The copy keeps the source's mode, and the path is added to the workspace's `info/exclude` so it
  stays ignored.
- A missing source is a one-line note in the chat (`.env not found in the main checkout`), not an error; setup
  continues. Files are not copied again later; a changed source reaches new and restored workspaces only.

Pilot copies the bytes without reading them into findings, logs or state, and never syncs or stores the contents:
the profile holds only the list, and each host copies from its own main checkout. Direct-mode projects run in the
main checkout and copy nothing.

**Who can change what.** The app edits the profile through the host's daemon. The planned automation agent
may edit tools, services and steps in its host's override layer, but any change to a step's `run` or a service's
`compose` source clears the related `review`. Writing a `review` or confirming a plan requires the native
host-action capability, so only the user in the app can do it.

Projects in **direct** mode have no per-chat workspace: tools and services still apply, and steps run only
when the user chooses **Run setup** in project settings. They use one project database instead of one per
workspace (section 5). Ask chats and coordinators never run steps.

## 3. Install plan preview

The plan is computed by the execution host's daemon from the effective profile and fixed, read-only probes. It
is a preview: computing it changes nothing.

### Probes

- Tools are detected from mise's own install records (`<mise data>/installs/<tool>/<version>`, honouring
  `MISE_DATA_DIR`). No tool runs, so a probe cannot fetch or execute project-selected content. Tools installed
  some other way do not count; the plan installs the pinned version with mise.
- Postgres server binaries are looked up at known locations (Homebrew `postgresql@<major>`, `/usr/lib/postgresql`,
  Postgres.app, the daemon's PATH) and their version command runs by absolute path with a neutral working
  directory (a private Pilot temp directory, never the repository). Login files are never sourced, as in
  `runtimeEnvironment`.
- Installer availability: `mise`, `brew` (macOS, or Linux when present), and on Linux the package manager detected the same way
  as devbox bootstrap (apt-get, dnf, yum). Docker when a compose provider is configured, or when the built-in
  database has no Postgres binaries and no Homebrew (section 5).
- Bounds: at most 16 probes, four at a time, five seconds each, 64 KiB output each.

### Plan items

```ts
interface EnvironmentPlanItem {
	subject: string; // "go", "postgres", "step:migrate"
	required: string;
	present?: { version: string; path: string }; // what the probe found
	action: "none" | "install" | "start" | "review" | "run" | "manual";
	installer?: "mise" | "go-tool" | "homebrew" | "docker" | "system" | "compose" | "pilot";
	/** Exact argv Pilot would run. For "manual", the commands the user would run. */
	commands: string[][];
	approval: "plan" | "user-runs"; // "plan": covered by confirming the plan
	impact: { network: string[]; downloadBytes?: number; diskBytes?: number }; // unknown sizes omitted
	note?: string;
}

interface EnvironmentPlan {
	host: HostRef;
	projectId: string;
	profileRevision: number; // shared layer
	overrideRevision: number; // this host's layer, 0 when absent
	planHash: string; // covers both revisions, probe results and items
	computedAt: number;
	items: EnvironmentPlanItem[];
}
```

### Installer choice

Tools come only from mise, in order:

1. **Already installed** by mise at the exact version: no action.
2. **Go tool directive** for tools declared in `go.mod`: nothing to install, `go tool <name>` uses the
   module version.
3. **mise**: `mise install <tool>@<version>`, user-level, no sudo. When mise is missing and Homebrew is
   present (user-level too, so the plan confirmation covers it), the plan adds `brew install mise` first.
4. Otherwise **manual**: install mise (mise.jdx.dev), then check again.

The built-in database has its own order (section 5). Anything needing root is shown, never run: Pilot **never
runs sudo**. Such items list the exact commands, which the user can copy or open in the workspace terminal, and
the plan rechecks afterwards.

Impact shows the network hosts involved and download or disk size when the installer can report it without
side effects; otherwise "size unknown". Pilot does not guess sizes.

### Confirmation in the app

Project settings get an **Environment** section next to General, Workspace and Tracking. For a selected
host it shows the profile, then the plan:

```text
Environment · devbox-1                               Last checked 14:02
  Go 1.23.4            missing      Install with mise (go.dev)
  golangci-lint 1.61.0 missing      Install with mise (github.com)
  Postgres 16          missing      Run in Docker (postgres:16)
  make setup           needs review Review Makefile, scripts/bootstrap.sh
                                                    [Review and apply…]
```

1. The user opens **Review and apply…**. A sheet lists every item that changes something, with its commands,
   installer and impact. Items the user must run (sudo) are listed separately with copyable commands.
2. Steps and compose services that need review open the review view (section 4) first.
3. **Apply** sends the plan hash with the native capability. The daemon
   recomputes the plan; if the hash differs (the host changed meanwhile, or the profile was edited), it
   refuses and the app shows the new plan. Nothing runs from a stale preview.
4. Progress shows in the section as one line per item. Results and errors follow section 8.

One apply runs at a time per host, because installers share caches and Homebrew cannot run concurrently.

## 4. Project scripts and repository configuration

Repository content that Pilot would execute is untrusted until the user reviews it: setup scripts, Makefile
or justfile recipes, and compose files (they choose images, mounts and ports).

- **Review** shows the files the step would execute: the entry file, plus files it directly references that
  Pilot can see (`include` lines, `./scripts/*.sh` paths in the recipe, `source` lines), each with its
  content. The user can add files to the reviewed set.
- **Approval pins content**: the SHA-256 of every reviewed file is stored in the step's `review`. Approval
  needs the native capability.
- **Before every run**, the daemon hashes the files in the workspace being set up. Any difference, including
  an agent's edit in its own workspace, marks the step **Needs review** and it does not run. Single-script
  steps run from a private copy of the verified bytes to avoid a change between check and run. Make and
  just recipes cannot be copied that way; the check runs immediately before execution and the remaining
  window is documented.
- **Limits stated plainly**: review covers repository files, not what a script downloads at run time
  (`curl | sh`, `go run pkg@latest`). The review view flags such patterns but cannot prove a script safe.
- **Discovery never runs scripts**. It only proposes steps from target names.

Steps run as the user, in the workspace, with a sanitized environment: the runtime PATH plus resolved tool
directories, the profile's `env`, service exports, and no provider keys, broker tokens or Pilot capability.

## 5. Built-in database

Pilot has built-in Postgres support that works on any host, Local or devbox, with or without a full profile.
It has its own **Database** section in the Environment settings; Postgres is not a mise tool. **Database ·
Postgres 16 · Enable** is enough to get one; discovery fills in the major version when the repository declares
it. The compose provider remains for projects that need an exact version or image.

**One long-running server per host.** Each host, Local or devbox, runs at most one Pilot-owned Postgres server,
either native (data in `<Pilot data>/database/postgres-<major>`) or the `pilot-postgres` Docker container (below),
with one port and one socket directory. It starts the first time a project needs it, stays running, and the daemon
starts it again after a reboot or restart when any project on that host has the database enabled. There is no
stop, cleanup or archive hook. Disabling the database for a project never drops its data.

**Host version.** The server's major version is a host setting, stored in that daemon's state and never synced.
It defaults to the newest major the host can run when the server is first created: the newest installed Postgres
binaries, otherwise the newest major Pilot supports. A project's `version` is a check against it, not a request
for another server:

- Same or older than the host version: the project runs on the host server.
- Newer: the Database section and the plan show a warning ("orders asks for Postgres 17; devbox-1 runs 16") that
  suggests the compose provider. The project still runs on the host server meanwhile.
- A project that needs an exact version uses the compose provider.

**No upgrades.** Pilot never changes the host version once the server exists: `pg_upgrade` and dump-and-restore
depend too much on the host's binaries, extensions and data to run reliably on their own. Projects that need a
newer major use the compose provider.

**One database per chat workspace.** Each project gets two roles inside that server: an owner role with
`CREATEDB` and a read-only role (with default privileges so new tables stay readable). Workspace setup creates one
database per chat workspace, owned by the project's owner role, so parallel chats run their own migrations. Pilot
revokes the default `PUBLIC` connect privilege on the databases it creates. The physical name
is `<name>_<project id prefix>_<workspace slug>` (the slug is the first 8 hex characters of the chat ID, like
Berth's worktree slug), so two projects asking for `orders` never collide and the name stays under Postgres's
63-byte limit; the exported variables carry the real name. A new database starts empty: migrations and seeds are
ordinary project steps. A restored workspace finds its database still there, since nothing drops it, and its
steps bring it up to date.

Direct-mode projects have no per-chat workspace and keep one project database, `<name>_<project id prefix>`,
created by **Apply** or **Run setup**.

**Extra databases on demand.** Because the owner role has `CREATEDB`, an agent can create more empty databases
(a test database, a scratch database) with ordinary commands such as `createdb` or `CREATE DATABASE` through
`DATABASE_URL`. There is no dedicated tool and no command filtering. Postgres only lets a role use a database it
owns as a template, so `CREATEDB` does not expose other projects' data. Such databases follow Postgres defaults:
the read-only role and the `db` tool's `pilot` environment do not cover them.

Pilot never drops databases (setup has no teardown), so archived and deleted chats leave theirs behind; agents can
drop the ones their owner role owns. The Database section lists every database owned by the project's roles, with
its size and, when the name carries a workspace slug, its chat, so the user can see what accumulates.

**Socket and TCP.** The server listens on a Unix socket in a private 0700 directory and on a loopback TCP port
that Pilot picks once per host and keeps. Socket connections need no password. TCP uses `scram-sha-256` with
passwords that Pilot generates per project role and keeps in the daemon's private state (0600). These are
Pilot's own credentials for its own server; they never leave the host, are not synced and are not written to
the repository. Exports offer both forms:

- `url`: `postgres://p_1a2b3c4d:…@127.0.0.1:54016/orders_1a2b3c4d_5e6f7a8b`
- `socketUrl`: `postgres:///orders_1a2b3c4d_5e6f7a8b?host=<socket dir>` (native servers only)

**Server source**, in order:

1. Postgres binaries already installed at the host version (Homebrew, system packages, Postgres.app): a native
   server.
2. Homebrew present: `brew install postgresql@<major>`, then a native server. mise is not used for Postgres
   because its plugin compiles from source.
3. Docker present: one long-lived `pilot-postgres` container from the official `postgres:<major>` image, with
   the `pilot-postgres-data-<major>` volume, the port published on `127.0.0.1` only, a restart policy and a
   `pilot.daemon` label. The plan shows the image; its digest is recorded at first pull and Pilot pulls again only
   for a newly confirmed plan. The container offers TCP only, so `socketUrl` exports fall back to `url`.
4. Otherwise **manual**: the plan explains what to install (Docker or Homebrew) and shows the system package
   commands for the user to run.

There are no Pilot-built or third-party portable binaries. Pilot never runs sudo.

**Agent `db` tool.** pilotd adds an environment named `pilot` to the `db` tool configuration in memory, next
to what `pilot-databases.json` defines. It targets the calling chat's own database (the project database in
direct mode); chats without their own workspace, such as Ask chats and coordinators, do not get it. Reads use the
read-only role and writes the owner role, both `allow` by default and switchable to `ask` in the Environment
section. The user file is never edited. If it already defines an environment named `pilot`, the file wins and
the Environment section says so. Because the tool runs in each host's daemon, it works the same on Local and
devboxes.

**Never touched**: other clusters, Homebrew or systemd Postgres services, other Docker containers and volumes,
existing databases and roles, `~/.pgpass`. If Pilot's data directory exists without Pilot's marker file, or a
`pilot-postgres` container or `pilot-postgres-data-<major>` volume exists without Pilot's label, setup stops with
an error instead of
reusing or replacing it.

**Compose provider.** Uses the project's reviewed compose file with a Pilot project name
(`docker compose -p pilot-<projectId> up -d <service>`), so containers and volumes are namespaced. The compose
file's own credentials stay in the file; Pilot does not copy them. Host ports come from the file, so a port
conflict is reported, not resolved by stopping anything. Compose services are not added to the `db` tool.
They stay per project: all of the project's workspaces share them. Per-workspace databases are a built-in
database feature.

Migrations and seed data are ordinary project steps; they target the workspace's database through the exported
variables. Pilot only controls the variables it passes: a project that reads its own `.env` (including a copied
local file) could still point elsewhere, and the review view mentions `.env` usage when it sees it.

## 6. Applying and rerunning safely

Every item follows **check → act → verify**:

- Tool: mise install record matches → skip; otherwise install, then check again.
- Service: readiness check passes → skip; otherwise create the server or container if absent, start it, wait for
  readiness (bounded), then create the project's roles if missing. Workspace setup then creates the workspace's
  database if missing (the project database in direct mode).
- Local files: copied when absent from the workspace (section 2), never replaced.
- Step: review pin matches, and `check` passes or the recorded input hashes are unchanged → skip; otherwise
  run, then record input hashes on success.

Triggers:

| When | What runs |
| --- | --- |
| `workspace.created` | Copy local files; readiness of tools and services; start the built-in database if needed and create the workspace's database; workspace steps |
| `workspace.restored`, including pruned legacy clones | Same. The workspace's database is reused if present. Steps whose outputs were removed (dependencies, builds) fail their check and run again |
| User clicks **Apply** or **Run setup** | The confirmed plan, then steps for the selected workspace |
| Drift: a confirmed source file changed (seen at `run.finished`, on restore, or on main refresh) | Nothing automatic. The chat shows a one-line event and the Environment section offers a new plan |

Triggered setup never installs tools. Installing needs a confirmed plan. When a trigger finds a missing tool,
the workspace becomes **Not ready** with the plan item as the suggested fix.

Version bumps: when an agent changes `go.mod` to `toolchain go1.24.1` in its workspace, that workspace
drifts from the profile. The user confirms the new version for the project (which updates the profile) and
applies the new plan. Old versions stay installed; Pilot does not uninstall anything.

Failures and interruptions: a failed or interrupted item leaves earlier items in place. A rerun repeats the
check for everything, so completed items are skipped. Interrupted runs (crash, Stop, sleep pause, runtime
update) are recorded as interrupted, never as success, and run again at the next trigger or explicit retry.
Automatic reruns are limited to one per trigger, like every automated loop.

Never done: dropping or resetting databases, deleting volumes or data directories, stopping services Pilot
did not start, editing credential files (`~/.pgpass`, cloud configs, `.env`), changing global shell or Git
configuration, replacing a workspace's existing local files, or running sudo.

## 7. Readiness

| Item | Check | Scope |
| --- | --- | --- |
| Tool | mise install record for the exact version, with its `bin` directory present | host, cached until an install or a failed use |
| Postgres (built-in, native) | `pg_isready -h <socket dir> -d <workspace database>` | server: host; database: workspace. Checked live (two-second timeout) |
| Postgres (built-in, Docker) | `docker exec pilot-postgres pg_isready -d <workspace database>` | same |
| Postgres (compose) | `pg_isready` against the mapped port, or the container health status | host, checked live |
| Step | review pin matches, plus `check` or recorded input hashes | workspace |

A workspace is:

- **Ready**: every required check passed at `checkedAt`.
- **Setting up**: setup is running.
- **Not ready**: shows the first failing check and its suggested fix.
- **Unknown**: never checked, or the host is unreachable. Unknown is never shown as Ready.
- **Outdated** (a marker on any of the above): the workspace's source files drift from the profile.

Checks run on triggers, on opening the Environment section, and before post-run checks. There is no polling.

**Agent environment.** The daemon passes resolved tool directories and service exports to the session's
worker at start and when they change, so the agent's shell, post-run checks and steps all use the same
versions without shell activation. When a project has a profile, the agent's prompt gets one short line,
for example: `Project environment: ready (Go 1.23.4, golangci-lint 1.61.0, Postgres 16 via DATABASE_URL).`
or `Project environment: not ready (Postgres not running). Pilot reports this to the user; do not install
system packages.`

**Post-run checks.** A check definition can list `requires` (profile tool and service IDs). Before
running it, the hook evaluates those items:

- A required built-in database server that is down is started once first; it is already in the confirmed
  profile, so this needs no new approval.
- Still not ready: the check is skipped with the reason, the environment error is raised (section 8), no
  follow-up goes to the agent and no attempt is consumed. An environment problem is not the agent's fault.
- Ready: the check runs with the environment's PATH and exports, so lint uses the pinned golangci-lint.
- If a check fails and a required service is no longer ready afterwards, the failure is reported as an
  environment error rather than fed back as a code failure.

## 8. Errors

```ts
interface EnvironmentError {
	step: string; // "Install golangci-lint 1.61.0", "Start Postgres 16", "make setup"
	host: { ref: HostRef; name: string }; // "Local" or the devbox name
	command: string; // display argv, redacted
	outcome: string; // "exit 2", "timed out after 10 min", "interrupted", "needs review"
	output: string; // last 40 lines, at most 4 KiB, redactDiagnosticText applied
	fix: string; // one or two sentences
	at: number;
}
```

- **Chat view**: a one-line automatic event, for example
  `Environment not ready: Postgres 16 on devbox-1`, with the full error behind Show.
- **Needs you**: a new reason kind `environment` with the detail line `Postgres not running on devbox-1`,
  only when the user must act (approve, review, run a sudo command, fix the host). It clears itself when the
  check passes.
- **Project settings**: the Environment section shows the same error on the failing item.
- Host-level failures (a tool or service) are raised once on the chat whose setup hit them and on the
  project's Environment section. Other chats show the event but not a second Needs you row.

Suggested fixes come from a fixed table keyed by item kind and failure class, not from a model:

| Failure | Suggested fix |
| --- | --- |
| Tool missing or wrong version | "golangci-lint 1.61.0 is not installed on devbox-1. Review the environment plan to install it with mise." |
| mise not found, no Homebrew | "Install mise or Homebrew on devbox-1 (see mise.jdx.dev), then check again." |
| Download failed | "Couldn't reach github.com from devbox-1. Check the network, then retry." |
| Database directory not Pilot's | "<path> exists but wasn't created by Pilot. Move it aside yourself; Pilot won't reuse or delete it." |
| Docker not running | "Docker isn't running on devbox-1. Start it, then retry." |
| Container or volume not Pilot's | "pilot-postgres exists on devbox-1 but wasn't created by Pilot. Rename or remove it yourself; Pilot won't reuse or delete it." |
| Project needs a newer Postgres (warning) | "orders asks for Postgres 17; devbox-1 runs Postgres 16. Use the compose provider if the project needs Postgres 17." |
| Built-in database port taken | "Port 54016 on devbox-1 is used by another process. Pilot won't stop it. Choose **Use another port** (this changes DATABASE_URL)." |
| Port already in use (compose) | "Port 5432 is in use on devbox-1. Pilot won't stop the other server. Use the built-in database or change the port in your compose file." |
| Script changed since review | "scripts/bootstrap.sh changed since you reviewed it. Review the new version to run setup." |
| Needs root | "Run this in a terminal on devbox-1: sudo apt-get install postgresql-16. Then check again." |
| Timeout, disk full, permission denied | Plain statement of the limit or path involved, plus "Retry" |

Full step logs (at most 1 MiB per run) stay in daemon state for the Environment section; they never enter
chat history or the offline index.

## 9. Local macOS and Linux devboxes

- Plans, probes, installs and readiness are computed by the **execution host's daemon** through
  `HostClients.perform(ref, …)`, using that host's platform, architecture and installers. Nothing is
  computed on the Mac for a devbox. Only the shared profile layer syncs (section 2); override layers, plans,
  installs and plan confirmations stay with each host.
- macOS: arm64 or x86-64, tools from mise, Postgres from existing binaries, Homebrew or Docker.
- Linux devbox: x86-64, tools from mise (installed through Homebrew when present), Postgres from existing
  binaries, Homebrew or Docker, apt/dnf/yum detected like devbox bootstrap with sudo items shown for the user to
  run.
- A new `DaemonCapabilities.environmentSetup: 1` flag gates the feature. Older runtimes show "Update the
  devbox to use environment setup", with no fallback to another host.
- **Offline or disconnected devbox**: the offline host index stores a small summary per project
  (readiness state, `checkedAt`, item IDs, versions and states; no commands, paths or output). The app shows
  "Last known · 2 h ago · devbox-1 disconnected". A last-known Ready shows as "Was ready at 14:02", never as
  Ready. Plans and actions are disabled until reconnection; profile edits wait as **Pending**. Reconnect
  applies pending profile edits and triggers no installs.
- Runtime updates wait for running environment operations, as they wait for imports today. Sleep and update
  pauses stop new steps from starting; interrupted ones rerun later (section 6). The built-in database keeps
  running through pauses.

## 10. Integration points assumed from other hooks

The general lifecycle hook design, [automations](automations.md), adopts these assumptions (its section 8).

**A1. Bounded shell runner.**

```ts
runAction({
	actionId, // stable, persisted as "started" before spawn
	projectId, sessionId?, cwd,
	run: { argv } | { scriptCopy, args },
	env, // sanitized base plus additions, never inherited secrets
	timeoutMs, outputCapBytes,
	signal, // Stop, shutdown, sleep or update pause
}): Promise<{
	outcome: "ok" | "failed" | "timed_out" | "cancelled" | "interrupted";
	exitCode?: number; outputTail: string; truncated: boolean; durationMs: number;
}>
```

It runs off the event loop on the subprocess pool with detached process groups, bounds concurrency per host,
refuses new starts while paused, and reports a crash during a run as `interrupted` (never replayed blindly).

**A2. Setup triggers.** `workspace.created` fires once per workspace after `meta.workspace` is saved
and can hold first-turn admission for a bounded time. `workspace.restored` fires after a successful restore
or legacy prune (where `workspaceReset` is set). Pending trigger work is durable and resumes after a daemon
restart. Neither fires for Ask chats or coordinators. There is no archive trigger.
Both copy local files before any step runs.

**A3. Run finished.** The modified-file list is available to the environment service, which compares it
with `confirmedSources` to detect drift without another full diff.

**A4. Shared error surface.** Hook errors and environment errors share the timeline event format and Needs you
plumbing. Environment errors use their own reason kind `environment`.

**A5. Configuration.** `Project.environment` sits beside the automation definitions in `projects.json`,
with the same validation-before-mutation pattern and revision checks; `Project.environmentOverride` holds the
host's own layer. If automation definitions also sync between linked hosts, they should share the profile's
layered sync. Approval fields require the native
capability; the automation agent cannot write them.

**A6. Post-run checks.** Checks accept `requires` and an environment provider that returns readiness and
the PATH and exports to use.

## 11. Worked example: a Go service

A repository `acme/orders` contains:

```text
go.mod             go 1.22.0
                   toolchain go1.23.4
.tool-versions     golang 1.23.4
                   golangci-lint 1.61.0
Makefile           GOLANGCI_LINT_VERSION ?= v1.60.3
                   setup: ; ./scripts/bootstrap.sh
                   migrate: ; go run ./cmd/migrate up
                   lint: ; golangci-lint run ./...
                   test: ; go test ./...
scripts/bootstrap.sh   go mod download, then make migrate
compose.yaml       services.db.image: postgres:16-alpine, ports 5432:5432, POSTGRES_DB
README.md          "Requires Go 1.22+ and PostgreSQL 15 or later."
.env               ignored; local API keys for the dev server
```

**Discovery** (no commands run):

| Subject | Findings | Result |
| --- | --- | --- |
| go | go.mod:3 minimum 1.22.0; go.mod:5 exact 1.23.4; .tool-versions:1 exact 1.23.4; README hint 1.22+ | Proposed 1.23.4 |
| golangci-lint | .tool-versions:2 exact 1.61.0; Makefile:1 exact 1.60.3 | **Conflict**: both shown, the user picks 1.61.0 |
| postgres | compose.yaml:3 major 16; README hint 15+ | Proposed 16 |
| steps | Makefile targets setup, migrate, lint, test | Proposed step `make setup`; `lint` and `test` offered as post-run checks |
| local files | `.env` is ignored at the root (name only) | Suggested for `copyFiles` |

**Profile**, confirmed once and synced to both linked hosts:

```json
{
	"revision": 1,
	"tools": [
		{ "id": "go", "version": "1.23.4", "from": { "path": "go.mod", "line": 5 } },
		{ "id": "golangci-lint", "version": "1.61.0", "from": "user" }
	],
	"services": [
		{
			"id": "postgres",
			"kind": "postgres",
			"version": "16",
			"provider": "pilot",
			"database": "orders",
			"dbTool": { "read": "allow", "write": "allow" },
			"exports": { "DATABASE_URL": "url" }
		}
	],
	"steps": [
		{
			"id": "setup",
			"title": "Download modules and migrate",
			"run": { "argv": ["make", "setup"] },
			"review": {
				"files": [
					{ "path": "Makefile", "sha256": "9f2c…" },
					{ "path": "scripts/bootstrap.sh", "sha256": "41ab…" }
				],
				"reviewedAt": 1792345678000
			},
			"inputs": ["go.sum", "migrations"],
			"requires": ["go", "postgres"]
		}
	],
	"confirmedSources": [
		{ "path": "go.mod", "sha256": "…" },
		{ "path": ".tool-versions", "sha256": "…" },
		{ "path": "Makefile", "sha256": "…" },
		{ "path": "compose.yaml", "sha256": "…" }
	],
	"copyFiles": [".env"]
}
```

devbox-1 is smaller, so it adds an override layer there: `{ "revision": 1, "env": { "GOFLAGS": "-p=2" } }`.

**Plan on Local (macOS arm64)**: Go 1.23.4 present via mise, no action. golangci-lint missing:
`mise install golangci-lint@1.61.0`. Postgres 16 binaries present from Homebrew
(`/opt/homebrew/opt/postgresql@16/bin`); action: create and start the built-in server for Postgres 16 and the
project's roles. Step `make setup` reviewed. The user confirms once. Each chat's `db` tool then lists a `pilot`
environment pointing at that chat's own database.

**Plan on devbox-1 (Linux x86-64, mise present, no Homebrew, apt)**: the synced profile arrives as **Synced**.
Go and golangci-lint: install with mise. No Postgres binaries and no Homebrew, but Docker is present: the host has
no server yet, so its version defaults to the newest major Pilot supports, 17, which satisfies the project's 16.
The plan runs the `pilot-postgres` container from `postgres:17`, with `sudo apt-get install postgresql-17` shown
as the alternative to run yourself. The effective profile includes the host's `GOFLAGS`. The synced review of
`make setup` applies because the files' hashes match, but nothing runs on devbox-1 until the user confirms
this host's plan once.

**First chat on devbox-1**: after the workspace is created, setup copies `.env` from the main checkout, checks
tools (cached), starts Postgres if needed, creates `orders_1a2b3c4d_5e6f7a8b` for this chat, sees `go.sum` and
`migrations` have no recorded hashes, and runs `make setup` (about 40 s), which migrates that database. A second
chat started meanwhile gets its own database and migrates it independently. The first turn is held meanwhile;
the chat shows "Setting up environment". The agent then gets
`Project environment: ready (Go 1.23.4, golangci-lint 1.61.0, Postgres 17 via DATABASE_URL).`

**Test database**: the agent runs `createdb orders_test` against `DATABASE_URL` to keep test data apart. It needs no
approval or tool; the Database section on devbox-1 now lists `orders_test` under the project, with its size.

**Post-run check**: the agent edited files, so `make lint` (requires golangci-lint) and `make test`
(requires go, postgres) run. devbox-1 rebooted earlier, and the daemon's start of the database failed with
`No space left on device`. Before the checks, Pilot tries once more and gets the same error. `make test` is skipped and the chat shows
`Environment not ready: Postgres 17 on devbox-1`, with the trimmed server log and the fix "Free disk space on
devbox-1 (Postgres data is in the Docker volume pilot-postgres-data-17), then retry." No follow-up goes to the agent.

**Script change**: the agent edits `scripts/bootstrap.sh` in its workspace. On the next restore of that
chat, the hash differs, `make setup` is not run, and Needs you says `Setup script changed: review
scripts/bootstrap.sh`.

**Version bump**: the agent bumps `toolchain go1.24.1`. At `run.finished`, go.mod is in the modified files
and differs from `confirmedSources`, so the chat shows `Environment outdated: go.mod asks for Go 1.24.1`.
The user reviews the new plan (`mise install go@1.24.1`) when the change is meant to land.

**Devbox offline**: the Mac shows "Was ready at 14:02 · devbox-1 disconnected" with actions disabled.

## 12. Proposed implementation split

In order. Each is one PR with its own tests, and each keeps the feature off until the last user-facing part
lands.

1. **Protocol and store**: `ProjectEnvironment`, plan, readiness and error types in `packages/protocol` and
   `PilotCore`, including `copyFiles` and the per-host override layer; validation in `ProjectStore`; daemon state
   file; capability flag. No behavior.
2. **Discovery**: bounded reader, parsers mapping to mise registry names, resolution with conflicts, local file
   suggestions; read-only discovery endpoint. Fixture tests including this worked example. Never executes
   repository content.
3. **Probes and plan**: mise install records, Postgres and installer probes (Docker for the built-in database),
   plan computation from the effective profile and plan endpoint.
4. **App: Environment section**: findings with citations, conflict resolution, tools from the host's mise
   registry, a Database section, local files, profile editing and per-host plan preview, with offline last-known
   display. SwiftUI mock first.
5. **Layered profile sync**: saved intent for the shared layer per linked project in the app, per-host write with
   revision checks, Synced and Pending states, reconcile on startup and verified reconnect; **This host only**
   editing of the override layer.
6. **Apply installs**: native-capability apply with plan-hash fencing, mise and Homebrew installers (including
   mise through Homebrew), sudo items as shown commands, per-host serialization, update gate and pause handling.
   Needs the shell runner.
7. **Script review**: review view, hash pins, re-review on change, private script copies.
8. **Built-in database**: one long-running native server or Docker container per host with its host version
   setting, project roles (owner with `CREATEDB`), the per-workspace database helper (one project database in
   direct mode), socket (native) and TCP, restart on daemon start, readiness probes, `db` tool environment
   targeting the chat's database, and the listing of every project-owned database. The compose provider follows
   behind review.
9. **Workspace setup**: on `workspace.created` and `workspace.restored`, copy local files, create the
   workspace's database, then run steps; first-turn hold, PATH and exports for agents, agent prompt line. Needs
   the setup triggers.
10. **Readiness and errors**: timeline events, `environment` Needs you reason, offline summary in the host
    index, and the `requires` gate for post-run checks.
11. **Drift**: compare confirmed sources at `run.finished`, restore and main refresh; outdated state and new plan.

Agent-led setup and project commands (section 15) are not scheduled.

**Adjustments to steps 1–4** for per-workspace databases, local files, layered sync and the single host server
(the mise and Docker changes are tracked separately):

- Protocol and store: add `ProjectEnvironment.copyFiles?: string[]` (safe relative paths, no `.git`/`.jj`
  segments, unique, at most 32), included in sync. Add `Project.environmentOverride?: ProjectEnvironmentOverride`
  with its own revision, validation and `PUT /api/projects/:id/environment/override` route (same 409 and native
  capability rules for review pins), never synced. Cap `EnvironmentService.database` at 32 characters (from 48)
  so `<name>_<8>_<8>` stays under 63 bytes. Mirror all of it in `PilotCore`.
- Plan: compute from the effective profile, add `EnvironmentPlan.overrideRevision` (0 when absent) and cover it
  in `planHash`. Built-in database notes say the database is created per chat workspace.
- Discovery: add `EnvironmentDiscovery.localFiles: string[]`, root `.env` and `.env.*` names that Git ignores.
- App: say "its own database for each chat" in the Database row, and add a local files list. Override editing can
  wait for step 5.
- Single host server: `EnvironmentService.version` becomes the project's declared major, checked against the
  host version rather than selecting a server. Report the host server (`version`, `source: "native" | "docker"`,
  or absent before creation) beside the plan. The plan's Postgres item compares the project major with it: same
  or older is `none` or `start`, newer adds a warning note suggesting the compose provider. There is no upgrade
  action. Probes look for the host version's binaries (or, before creation, the newest
  installed major) instead of each project's major. Docker uses the `pilot-postgres` container and
  `pilot-postgres-data-<major>` volume. The app's Database row shows the host version next to the project's
  declared major. `CREATEDB` and the database listing need no schema change in steps 1–4.

## 13. Decisions from review

- The first turn waits for setup (at most 10 minutes). On failure the agent starts with the "not ready" line
  and the error is raised.
- When mise is missing, the plan offers `brew install mise` where Homebrew is available.
- Homebrew counts as user-level, like mise: the plan confirmation covers it.
- Pilot never runs sudo. It shows the commands for the user to run.
- The built-in database offers both a Unix socket and a loopback TCP port.
- The built-in Postgres server is long-running. No teardown is designed.
- Profiles sync across linked projects on all hosts; plans, installs and readiness stay per host.
- The built-in database is offered to the agent's `db` tool.
- Toolchains come from mise with no built-in tool table: tool IDs are mise registry names, the app adds tools
  from the host's mise registry, and detection reads mise's install records. Postgres keeps a dedicated
  Database section.
- Postgres without existing binaries or Homebrew runs in one long-lived Docker container per host, published on
  loopback only. No Pilot-built or third-party portable binaries. Without Docker either, the plan explains what
  to install.
- One Pilot Postgres server per host, with a host version set when the server is created (default: the newest
  available major). Pilot never upgrades it. A project's declared major is a check: older runs on the host
  server, newer warns. Projects needing a newer or exact version use the compose provider.
- The project's owner role has `CREATEDB`, so agents create extra empty databases with ordinary commands, with no
  dedicated tool or command filtering. The Database section lists every database the project's roles own.
- Each chat workspace gets its own database, created by workspace setup. Direct-mode projects keep one project
  database. The `db` tool targets the chat's database.
- Workspace setup copies listed ignored local files from the main checkout into new and restored workspaces,
  before steps run. Pilot never stores or syncs their contents.
- Sync is layered: a shared profile synced to every linked host, plus a per-host override layer that always wins
  on its host. No conflict prompts.

## 14. Open questions

1. **CI workflow files.** Default: hints only, so they never create conflicts. Revisit with real projects if
   CI pins turn out to be the most reliable source.
2. **Version bumps.** Default: a new version always needs a confirmed plan, even for an already approved tool.
   Revisit if confirming routine toolchain bumps becomes tedious.
3. **Leftover databases.** Databases of archived or deleted chats, and extra databases agents created, stay,
   since Pilot never drops data. Default: list them with sizes in the Database section and leave dropping to the
   user. Revisit if they grow enough to need a confirmed cleanup action.

Resolved: portable Postgres builds (now Docker, section 5) and sync conflicts (now layered sync, section 2).

## 15. Later work

Planned after the plan UI, design only for now:

- **Agent-led setup.** An agent proposes the profile and the repository changes it needs (for example a missing
  setup target), and the user confirms them in the app, as Cursor and Devin recommend. The agent never approves
  plans or reviews.
- **Project commands.** Test, lint and build commands stored once in the profile, given to the agent as context
  (like Devin's commands, which it never runs on its own) and used as defaults for post-run checks.
