# Canonical chat workspace changes

The Local conversation header's **Changes** action (Cmd-Option-D) opens a passive
inspector. Wide windows place it beside the conversation; narrow windows use a
bottom dock. Opening and explicit **Refresh** read only the exact active chat's
`GET /api/sessions/:id/changes`. Streaming, idle time and repository events do not
refresh it. Links and mission context remain independently reachable and replace
the inspector instead of stacking docks. Escape restores mounted composer or
navigation focus. Pointer and keyboard actions retain existing composition guards.

The inventory retains each file's reported status, additions/deletions and previous
path. Expand one file at a time for a bounded, selectable literal patch, never a
full-file view. Base and branch come from the response, not the project checkout.
Snapshot details explain canonical chat provenance and the server's recorded-branch
semantics. Refresh errors retain the last snapshot with a stale/unknown notice.
Missing, binary, metadata-only, malformed or oversized patches are unavailable,
not unchanged. Truncated or inconsistent empty responses are never called clean.

## Authority audit

- Swift `ChangesPane.swift` reads the same endpoint and parses patches off-thread,
  but also polls and offers a file viewer. Those behaviors are not adopted here.
- `server.ts` calls `sessions.changeBase(id)`: canonical `meta.cwd`, recorded
  workspace base/baseBranch and recorded workspace branch override. Without a
  workspace the server compares against HEAD. `RepositoryChanges` may advance a
  workspace base to a newer merge base; the returned base is authoritative.
- `changeBase` invokes existing `assertWritable`: Ask/coordinator, preparing,
  recovery/maintenance, continued/model-changing chats can refuse this GET. The
  inspector keeps that refusal and makes no alternative request for a guessed
  workspace. No backend authority, host capability or mutation is added.
- Next reuses `LocalOptions` and pinned hello identity checks before and after the
  read. This is loopback identity pinning, **not authentication**. No filesystem,
  Git, project-path fallback, terminal, file opener, stage/revert/commit or agent
  action exists. File viewing and continuous refresh remain separate work.

## Bounds and lifecycle

- One worker/runtime per open inspector, capacity-one replacement commands and
  responses, one request at a time. Replacement/drop cancels in-flight GETs.
- No redirects, proxy, HTTP retries, polling or fanout. 2-second connect and
  35-second whole-request deadlines, matching the existing bounded server diff.
- 8 MiB wire body cap, checked by content length and every chunk before JSON
  decode. JSON depth stays under serde's recursion limit. Refuse inventories over
  4096 entries; retain/render at most128 files and parse at most512 KiB of patch.
- Complete per-file patches only, at most32 KiB/200 lines/1024 bytes per line.
  Checked hunk counters never allocate from untrusted line numbers/counts.
  Unique inventory and patch paths, exact old/new associations, and Git-quoted
  UTF-8/octal filenames are validated without opening them. Unknown patch forms
  are not guessed. Newlines/tabs remain code; other control/bidi text is escaped.
- One expanded diff bounds mounted code. Shared app resource rows, typography,
  semantic surfaces and notices own presentation. No independent animation clock.
- Source options pin Local identity; chat, loaded-reader generation and request
  serial fence completions. Scope invalidation cancels the reader and labels any
  retained snapshot stale. No discarded error is silently converted to empty.

## Scoped verification

`python3 apps/desktop/scripts/check-scoped.py --unit workspace_changes --test workspace_changes --lint`

Rationale: parser/model and faux transport plus actual mounted inspector cover this
GET-only subtree; native Links composition guards cover the small shared seam.
The existing shared slot and Cargo wrapper retain CPU2/4GiB admission and private
outputs. Synthetic hidden680/1100 light/dark windows check loading/error retention,
truncation, empty, expansion, keyboard, navigation, adjacent Links, composer draft
and preedit. No live Local state is read or mutated. Screenshots are actual GPUI
rendering, not SwiftUI mocks. These are not OS IME, performance, Wayland or release
acceptance claims; full CI remains separate.
