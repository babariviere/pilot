# Simple agent flows

Design for the daemon/protocol MVP. A flow has one isolated Build worker followed
by read-only Ask reviewers. Nodes run sequentially. There is no parallelism,
expression language, arbitrary graph, automatic trigger or desktop implementation.

## Definitions

Store optional `flows` next to `items` in the existing project `automations` object
in `projects.json`. They share its revision and native-authorized CAS write route.
Old hook-only writes preserve flows; a write supplying flows replaces them. Invalid
saved definitions remain on disk but cannot execute. No repository config files.

```json
{
  "revision": 7,
  "items": [],
  "flows": [{
    "id": "fix-review",
    "name": "Fix and review",
    "enabled": true,
    "nodes": [
      {
        "id": "worker",
        "mode": "build",
        "prompt": "Implement the requested fix and verify it.",
        "edges": { "done": "reviewer" }
      },
      {
        "id": "reviewer",
        "mode": "ask",
        "prompt": "Review the worker's changes. Approve or request concrete changes.",
        "edges": { "approved": "end", "changes_requested": "worker" }
      }
    ],
    "loop": { "from": "reviewer", "to": "worker", "maxRounds": 3 }
  }]
}
```

- At most 16 flows/project, 2–8 nodes/flow. IDs use hook ID syntax. Names are
  single-line, at most 80 characters; prompts at most 8,000 characters.
- The first node is Build; every later node is Ask. Each can pin `model` and
  `thinking`, otherwise use existing project/model defaults. All Build work stays
  in the first chat's isolated workspace, even if the project defaults to direct.
- Edges map `done | approved | changes_requested` to the next node's ID or `end`.
  Only the immediately following node is a forward destination. Missing edges
  stop with attention, never implicit success. `failed` always stops.
- Optional `loop` declares the only backward edge: an Ask node back to the first
  worker, on `changes_requested` only. No other cycle or self-edge is accepted.
  `maxRounds` is 1–5, counting the first worker pass. At its limit, another
  changes request stops with a visible limit reason instead of starting work.
- Definitions are snapshotted at start. Edits apply to future runs; disabling or
  deleting the definition prevents the next node/input admission in existing runs.

## Outcomes and handoff

The daemon appends a brief output contract to each node's prompt: finish with one
JSON object, no fence or surrounding prose, for example
`{"outcome":"changes_requested","summary":"Add the timeout regression test."}`.
Outcomes are `done | approved | changes_requested | failed`; `summary` is nonempty
and at most 4,000 characters. Read only the current completed run's final assistant
text, bounded to 8 KiB. Missing, truncated, malformed or stale results stop with
attention. Never infer approval from an idle chat, prose, tool output or a PR.
The object is routing data, not evidence of correctness or permission to mutate.

Pass the original manual input, current round, and the previous node's bounded
summary to the next node as labeled data (not an instruction source). Reviewers
read the worker's exact working directory through Ask's existing read-only tools.
Each reviewer visit gets a fresh chat. Returning to the worker queues an idle-only
`<automation>` input in that original chat. No transcript-wide copying or hidden
read grants, and no new kernel tool. Questions use existing `ask_user` and answer
machinery; they do not consume a round or count as a completed node.

## Native API and progress

`POST /api/projects/:id/flows/start` accepts
`{requestId, expectedRevision, flowId, message}`. `requestId` is a UUID chosen once
by the native caller; exact retries resolve the same worker, never create another
run. A mismatched request under the same ID conflicts. The route requires the
existing native `x-pilot-github-capability` and Automations enabled, and returns
`202` with the worker summary. No agent, Slack, schedule or hook can start flows.

Each participating session summary includes `flow` with root worker ID, flow ID,
name, current node/chat, round/limit, state and reason. Root metadata owns the
immutable definition/input and bounded visit history. Existing `automation` working
state and `automation` Needs you reasons carry progress and actionable failures.
GET/list/WS are passive. A dedicated flow UI and definition-editing agent are later.

## Durable execution

Persist the root flow state with the initial worker's pending input, before starting
its kernel. Persist each next visit's session ID and input identity before admitting
it. Fresh reviewer creation reuses durable chat start and its exact reserved IDs.
Returning-worker input and its admitted visit marker commit together in session
metadata, before outbox delivery. Recovery never replays a model-side tool or invents
a new input ID after a lost acknowledgement. A persistence error fences execution;
an ambiguous admission stops visibly rather than blindly retrying effects.

The daemon serializes advancement per flow and bounds host-wide active flows to
eight. Completion observes session events, not polling. Worker completion waits for
run-finished capture, checks, todo follow-ups, jobs/subagents and pending inputs to
settle. Existing hook follow-ups retain their separate three-attempt limit. An
unresolved check/configuration error stops the flow before review. Ask completion
uses the same all-work-settled condition, without firing workspace hooks.

| Condition | Behavior |
| --- | --- |
| Question pending | Show waiting; resume only after the current chat continues and completes. |
| Sleep, offline, usage or update pause | Keep the cursor and IDs; admit nothing new, re-evaluate on existing resume events. |
| Daemon restart | Load root state and resume existing chats/outbox; never count an old completion twice. |
| Automations off | Already admitted work may finish; freeze next admissions until enabled. |
| Definition disabled/deleted | Stop before the next admission with an actionable reason. |
| Stop on any participating chat | Durably cancel the flow before further admissions; Stop still reaches that chat's kernel. |
| Archive, replacement/continuation, failed startup or malformed result | Stop with attention; never silently switch ownership or resurrect a chat. |
| User input while flow-owned work waits | Cancel automatic advancement rather than treating that reply as the node result; answers to the current question are allowed. |
| Round limit or node failure | Retain chats/history and report the reason; never automatically restart. |
| Terminal run | Release automatic ownership; retain bounded state with the worker history, no silent eviction or deletion. |

## Dependencies and later options

Reuse project definitions/CAS, the Automations Settings gate, durable chat creation,
Ask sandboxing, session metadata/outbox, all-work-settled run boundaries, shell
checks/TODO continuation and sleep/update admission fences. Do not build another
shell runner, scheduler or model loop. Focused tests use faux workers and temporary
storage, including crash windows, lost ACKs, Stop, questions and pause recovery.

Later options require separate approval: multiple writing nodes and workspace/change
sharing, arbitrary graphs, parallel nodes, automatic Slack starts, mission-task
mapping, richer result schemas, a flow editor and the automation-editing agent.
