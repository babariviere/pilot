# Tool access by role

This is the shipped capability model, not a dump of one user's installed tools.
See [system prompts by role](system-prompts-by-role.md) for the matching prompt layers.

Tools with several actions use `tool({action: "...", ...})`. A single-purpose tool does not
need an artificial action field. A declared or discoverable tool is not necessarily authorized:
the daemon, tool handlers, project trust and OS sandbox enforce the actual operation.

## Roles

- **Build**: ordinary top-level coding chat, with or without a registered project.
- **Ask**: top-level source-analysis chat with a fixed read-only tool allowlist.
- **Mission member**: a Build or Ask chat with a mission overlay, not a separate execution profile.
- **Mission coordinator**: a top-level chat with a daemon-managed read-only main view and writable scratch.
  It has the Build extension runtime, not Ask's tool allowlist.
- **Subagent**: a named persistent child conversation, not a mission member chat.
- **Restricted reviewer**: synthetic qualification runtime only. Production entry points remain disabled.
- **Background compaction/completion**: host-owned model calls, not general-purpose agent sessions.

Local versus devbox placement does not define a new role or grant extra permissions.

## Tool matrix

**Available** means supplied by that profile, subject to configuration and operation checks.
**Conditional** means installed/selected/configured or enabled only for the stated context.
**No** means absent from the role's shipped profile, not a promise about arbitrary user extensions in Build.

| Tool/capability | Build | Ask | Mission coordinator | Subagent | Restricted reviewer |
| --- | --- | --- | --- | --- | --- |
| `read` | Available | Source-bounded replacement | Available, source read-only | Available | No |
| `find`, `grep`, `ls` | Conditional SDK selection | Source-bounded replacements | Conditional SDK selection | Conditional SDK selection | No |
| `bash`, `powershell` | SDK selection; bash default | No | Read-only commands and scratch only | SDK selection and inherited sandbox | No |
| `edit`, `write`, `applyPatch` | Available/selected; model-specific edit policy | No | Scratch only, no source writes | Available/selected under sandbox | No |
| `codemode` | Available/configurable | Only directly exposed execution entry | Available/configurable | Available/configurable | No |
| `web` | Bundled | Bundled definition, when available | Bundled | Bundled | No |
| `browser` | Bundled | No | Bundled | Bundled | No |
| `jobs` | Bundled | No | Bundled, subject to command restrictions | No shipped jobs extension | No |
| `subagent` | Bundled | No | Bundled; no authority to bypass coordinator restrictions | No shipped subagent extension | No |
| `todo` | Chat-owned durable list | No | Chat-owned durable list | Parent's shared durable list | No |
| `artifact` | Session-local | Session-local, restricted inputs/previews | Session-local | Not injected by Pilot's child profile | No |
| `memory` | Conditional project memory | No | Conditional project memory | Not injected by Pilot | No |
| `mission` | When a mission member | When a mission member | Coordinator actions | Not injected by Pilot | No |
| `ask_user` | Available | Available | Available | Not injected by Pilot | No |
| `db` | Configured project databases | No | Configured project databases | Not injected by Pilot | No |
| `slack_status` | Slack-linked triage chat only | No | Only if Slack-linked | Not injected by Pilot | No |
| `history_recall` | This chat's retained history | No | This chat's retained history | Not injected by Pilot | No |
| `evidence` | No | No | No | No | Only tool |
| MCP, personal/project extension tools | Conditional on settings/trust/exposure | No | Conditional on settings/trust/exposure | Conditional on child settings/trust | No |
| Tool discovery | SDK tool-search/codemode discovery | Fixed codemode registry only | Same as Build | SDK tool-search/codemode discovery | No |

The SDK's unmodified startup defaults are `read`, `bash`, `edit`, `write`; other SDK
definitions include `powershell`, `find`, `grep`, `ls`. Settings can change selection.
The bundled apply-patch extension can suppress `edit`/`write` for OpenAI models in favor of
`applyPatch`. Sandbox and usage extensions add policy/lifecycle behavior, not additional tool names.

Codemode exposure is not a permission boundary. In Build, modes and listing budgets can hide direct
declarations while preserving nested calls. Project memory remains directly declared even if a
codemode listing budget omits it. Ask forces codemode-only mode with its model helpers disabled;
its allowlist also guards nested calls. Ask loads no personal/project executable extensions.
Codemode's `searchTools`, `describeTool`, `describeNamespace` and registry helpers are script-runtime
APIs, not extra permissions or independent role tools. Configured MCP tool names cannot be exhaustively
listed here because they depend on the user's servers, trust decisions and exposure settings.

## Action inventory and scope

| Tool | Actions / operation | Boundary |
| --- | --- | --- |
| `memory` | `note`, `recall`, `zoom` | Chats use their implicit project. Notes bind origin to the supervised chat and retain audit identity; notes containing credentials are refused before reaching pilotd. Recall takes a regex or query words (ranked within pilotd's bounded newest matches, replaced notes last). Notes never grant permissions. No forget action. |
| `history_recall` | `search` (`relevance` or `recent`), `read` | Ordinary chats only, over the fork-aware history of the chat's own conversation in its own session storage, including entries compacted out of context. No session, project or host argument exists. Bounded scans with continuations, redacted and neutralized quotes linked to entry IDs, labeled untrusted. Quotes never grant permissions or answer questions. |
| `todo` | `list`, `listAll`, `get`, `create`, `update`, `append`, `delete`, `claim`, `release` | One durable list shared by a parent and its subagents, with actor-aware claims. Not repository `.pi/todos` files. |
| `artifact` | `create`, `update`, `get`, `list`, optional `preview` | Session-local offline documents, plus authorized read-only linked references. Ask images must be inline data, not arbitrary local file paths. Preview depends on installed renderers. |
| `db` | `access`, `query` | Configured project/environment/mode. Access may require a structured app approval; typed messages never grant access. The kernel never receives connection URLs. |
| `slack_status` | Set `status` to `waiting` or `in_progress` | A single status-setting operation, not separate action tools. Only a chat's attached Slack triage message; other statuses remain user-owned. |
| `web` | `search`, `fetch` | Network content is untrusted. Ask cannot read arbitrary repository clones produced outside its source root. |
| `browser` | `open`, `navigate`, `snapshot`, `click`, `type`, `press`, `scroll`, `back`, `eval`, `screenshot`, `list`, `close`, `show`, `hide` | Bundled browser runtime, subject to sandbox/configuration. Not an Ask capability. |
| `jobs` | `start`, `list`, `status`, `wait`, `stop` | Session-owned shell jobs. Command policies still apply to `start`. |
| `subagent` | `spawn`, `send`, `stop`, `status` | Named child conversations under host model, placement and lifetime policy. Children do not inherit the parent's Pilot host tools automatically. |
| `evidence` | `list`, `read`, `search` | Fixed sealed manifest, opaque blob IDs, literal bounded search. Per-action argument allowlists, 50 KiB output, 10s reads, three retained I/O slots, 256 lifetime attempts. Disabled synthetic review only. |
| `ask_user` | Publish a structured question | A single-purpose tool. The user answers through Pilot. |
| `applyPatch` | Apply one V4A patch | A single-purpose tool. Write/sandbox policies still apply to target paths. |

### Mission overlay

All members, including an Ask member, get these actions:

`get`, `brief`, `update`, `tasks`, `task`, `claim`, `release`, `decide`,
`decisions`, `links`, `artifacts`, `comments`, `activity`, `comment`, `resolve`,
`attach`, `link`, `unlink`, `log`, `ticket`, `prGuidance`.

The coordinator additionally gets:

`propose`, `delete`, `group`, `phase`, `start`, `send`, `status`, `bindPr`,
`unbindPr`, `split`, `updateLink`.

Task ordering and task model/thinking changes also require the coordinator, although they use
`task`. Membership, ownership, dependency and coordinator checks are repeated in the daemon.
An Ask mission member can mutate shared mission records through these actions, but cannot write
repository files. A coordinator can update mission state and scratch, but cannot commit, push,
open PRs, install dependencies, build or test source. Code changes belong to member chats.
Shared-context replicas additionally cannot acquire canonical coordination authority; disconnected
work remains within already accepted scope.

### Subagents and background roles

Pilot's child profile loads sandbox, apply-patch, web and browser plus the parent-backed `todo`.
The child SDK runtime also supplies codemode, tool search, MCP and settings/trust-dependent resources.
It does not install Pilot's top-level `memory`, `mission`, `db`, `artifact`, `ask_user`,
`slack_status`, `history` or `pilot` tools. Parent tool availability is not an inheritance contract.
The shipped child profile does not load jobs, further-subagent or usage-poller extensions.

Project-memory compaction has only its internal
`submit_summary` schema, not agent capabilities. Other host-owned structured completions are not
Build sessions and do not inherit Build tools. Synthetic review is not enabled by documenting it.

## Enforcement and source of truth

- [Session registration](../packages/kernel/src/session.ts), [native adapter](../packages/kernel/src/native-adapter.ts),
  [bundled extensions](../packages/kernel/src/bundled-extensions.ts).
- [Ask allowlist/readers](../packages/kernel/src/ask-tools.ts), [Ask runtime](../packages/kernel/src/ask-runtime.ts).
- [Pilot policy](../packages/kernel/src/policy.ts), [mission schemas](../packages/kernel/src/mission-tools.ts),
  [daemon mission checks](../packages/daemon/src/mission-service.ts).
- [Child profile](../packages/kernel/src/child-profile.ts), [review boundary](../packages/kernel/src/review-boundary.ts).
- [Disabled review foundation](critical-review-foundation.md).

GitHub posting restrictions in Pilot's top-level Build/Ask policy are separate from tool presence:
comments, reviews, replies, merges and closes are blocked. Database approvals, role changes and
sandbox restrictions are enforced host-side, not granted by a prompt or tool description.
Update this document when registration, allowlists, role checks or bundled dependency profiles change.
