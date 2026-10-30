# Pinned mission artifacts

The mission Overview's **Artifacts → Browse artifacts** opens a read-only list
of mission-level references from its received detail snapshot. It does not
enumerate project/global artifacts, hydrate chat history, subscribe to an owner
or edit links. A virtualized native list opens the existing `ArtifactPane` for
one exact pin. Images and supported native visuals preview normally; legacy
HTML, React, SwiftUI and shader content stays inert with View source/Copy source.
There is no browser or SwiftUI fallback.

## Current contract, checked before implementation

- `GET /api/missions/:id` returns `MissionDetail.artifacts`, whose
  `MissionArtifactLink` carries `artifactId`, owning `sessionId`, `title`,
  `kind` and optional `revision`. `taskId` distinguishes independent task pins.
  The route reads `MissionStore.detail`, not an agent/session subscription.
- `MissionService.linkArtifact` resolves the supplied revision through
  `SessionManager.artifact` when the link is written and stores its kind/title.
  The client does not attach, update or resolve links itself.
- `GET /api/sessions/:owner/artifacts/:id?revision=N` returns that committed
  revision or an error. `ArtifactStore.get` reads the requested revision file,
  not the latest body. It still needs the committed latest pointer to exist;
  a retained link is not a guarantee that the body remains available.
- The native transport checks Local hello identity before and after the read,
  validates the returned owner/artifact/revision/kind and preserves current
  image admission/decoding limits. Hello identity pinning is not authentication.

Sources: [protocol](../../../packages/protocol/src/index.ts),
[mission route](../../../packages/daemon/src/server.ts),
[link writer](../../../packages/daemon/src/mission-service.ts),
[stored links](../../../packages/daemon/src/missions.ts),
[artifact store](../../../packages/artifacts/src/store.ts),
[native exact read](../src/local_client.rs).

## Identity and availability

Only links without `taskId` enter this list. An older task pin and a newer
mission pin for the same artifact remain separate stored records. No metadata
is borrowed from the task pin, a latest summary or another revision. A pin
without a valid explicit positive revision is visibly unavailable, never latest.
Malformed/duplicate mission-level identities make the section explicitly
unavailable instead of selecting an arbitrary row. Missing/deleted bodies,
changed kind/ownership/revision and refused reads stay errors without fallback.

Opening captures the exact link and mission generation and rechecks membership
in that snapshot. The reader retains its existing cancellation, owner, host,
generation and clipboard fences. Mission readers hide Previous revision and
return to the mission list, never a current-chat gallery. Back/Escape closes the
reader and restores list focus; Escape again returns to Overview. Mission
navigation, refresh, host replacement or connection transitions cancel/close the
reader. Offline links remain readable as a retained snapshot with an explicit
notice and cannot start a body read. Reconnecting alone does not certify link
freshness; these are links from the received detail, not a live subscription.

Source inspection shows the exact accepted revision's owner, ID, revision,
kind and stored timestamps. Long textual source previews explicitly disclose
their existing 8192-character display limit; Copy source retains the whole
stored string, including whitespace. Images keep their existing source summary,
hash and full data-URL copy rather than laying out large base64 text. Reader
selection/copy and image/visual zoom/pan are unchanged. No composer, draft,
delivery, shared motion clock or reduced-motion policy changes are introduced.

## Isolated verification

- `packages/daemon/src/artifacts.test.ts` uses real loopback routes/disposable
  storage to verify mission detail metadata, independent older task/newer
  mission pins with changed kinds, exact source reads, missing-body errors
  without latest substitution, unchanged links/tasks and parked owners with no
  kernel/provider calls.
- `mission_artifacts::tests` covers projection, omitted/invalid/unpinned and
  ambiguous refs without latest inference.
- `mission_artifacts` runs hidden actual GPUI at 680/1100, light/dark: real
  Tab/Enter opening, Back/Escape/focus, native image/visual, unsupported source
  inspection and exact Copy, changed-kind/missing refusals, held target switch,
  mission A→B→A, close and offline retained links. The faux server admits only
  hello, mission/member reads and the selected exact linked artifact routes.

These are synthetic source-level/native checks, not live-data, OS IME/AX,
Wayland, release or user acceptance. Resource/link editing, revision catalogue,
latest-follow/durable reader state and project/global enumeration remain open.
See [revision constraints](artifact-revisions.md) and
[finish checklist](finish-checklist.md).
