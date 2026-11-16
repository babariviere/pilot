# Planning unstick log

Pilot appends one JSON line to `<data>/diagnostics/unstick.jsonl` each time mission planning needed a push. The
log exists so the causes can be fixed later: every entry is a case where planning did not go on by itself. Pilot
writes it and never reads it back. `packages/daemon/src/planning-unstick-log.ts` writes it.

## Entries

Each entry has `at`, `missionId`, `mission` (its title), `action`, `phase`, `unstick` (what Unstick showed at
that moment: `state`, `line`, `fix` and `checks`) and `stall` (the last time a submitted round was not sent:
its reason and, for a changed round, which parts changed). Question and answer text is never written.

| `action` | When |
| --- | --- |
| `stalled` | A submitted round was not sent by itself. Once per round and reason |
| `continue` | The user pressed Continue planning (or Unstick's Continue fix) |
| `continue-submitted-round` | Continue sent a submitted round that had stalled |
| `continue-with-feedback`, `continue-with-repair-note` | Continue with the user's feedback, or with the repair agent's note |
| `drop-earlier-answers` | An answer save made while Unstick offered to drop answers to an earlier wording |
| `repair-agent`, `repair-agent-answer` | The user asked the repair agent to look, and its proposal (or failure) |
| `manual-repair` | Backfilled: a repair made by hand on the saved state, with `note` |

Entries with `"backfilled": true` were added from `pilotd.log` and session notes for the days before the log
existed. They have fewer fields.

## Why a submitted round changed

A held round keeps a fingerprint of what the user answered against (`roundContext` in `planning-workers.ts`).
Pilot now also keeps each part of it, hashed on its own (`holdParts`: `binding`, `project`, `session`,
`mission`, `owner`, `context`, `controls`, `plan` and, for a revisit, `briefRevision`). When a round stalls,
the reason and the `stalled` entry name the parts that changed, and Unstick's checks say
"Changed since this round was asked: …" before the user submits. Holds saved before this have no parts, so
Unstick says the change is not known.

## Size

One file holds up to 1 MiB (`UNSTICK_LOG_BYTES`), then it becomes `unstick.jsonl.1` and a new file starts. It
protects the disk from a loop that stalls again and again. A line is about 1 KiB, so the two files keep about the
last 2,000 entries.

## Reading it

```sh
jq -c '{at, action, line: .unstick.line, why: .stall.reason}' ~/.local/share/pilot/diagnostics/unstick.jsonl
```
