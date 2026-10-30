# Reported mission links

Overview → **Links → Browse links** lists the existing mission and task resources
from one passive mission detail. A virtualized native list opens full selectable
title/URL details, reported kind/reference/relationship/Linear role and creator
chat ID when supplied. No URL deduplication or title-based grouping hides distinct
task relationships. Artifacts keep their separate exact-pin reader.

## Source contract

- `MissionDetail.resources` in `packages/protocol/src/index.ts` carries resource
  `id`, exact `url`, optional title/external ID/task ID/creator, kind, relationship
  and optional cached PR/Linear metadata.
- `GET /api/missions/:id` in `packages/daemon/src/server.ts` calls
  `MissionStore.detail`. `resourceFrom` in `packages/daemon/src/missions.ts`
  returns stored fields, not an external query, provider call or subscription.
- The protocol's optional `owner` is a tool-result projection. The passive detail
  serializer does **not** supply it. Added-by chat and task assignment are not PR
  chat binding. PR details therefore explicitly say binding is unavailable.
- Swift's `MissionLinksSection.swift` combines/deduplicates task and mission
  links, looks up missing cached PR reports and exposes mutations. This bounded
  slice intentionally does none of those. It shows reported links, not current
  PR status, readiness, approval or proof of ownership.

## Actions and identity

**Open link** accepts only the existing `external_links::web` HTTP/HTTPS policy
and calls the existing user-activated opener (including its existing desktop-app
routing). The URL parser's normal percent/punycode serialization is unchanged;
**Copy link** retains the exact reported string, even for an unsupported URL.
Unsafe/unsupported URLs have visible explanation and disabled Open. Resource
URLs are external links: `pilot:`, file, script and other schemes do not become
guessed internal routes. No external status query or embedded browser is added.

**Show task** uses only an exact `taskId` found in this same detail's complete
task array, before the Overview preview truncates it. It opens that mission's
existing Tasks pane and selects the ID. Unknown IDs stay visible as unavailable;
numeric display references and matching titles never resolve a target. Reported
`relationship` and `addedBySessionId` retain their distinct meanings.

Callbacks capture the complete row and mission generation and recheck the
current Local home/mission and row membership. Refresh, navigation and host
replacement close the disclosure. Connection changes invalidate freshness;
reconnect alone cannot restore it. A read spanning a disconnect cannot make
actions fresh. Offline/error snapshots remain inspectable and exactly copyable,
with a retained notice and Open/Show task disabled until a successful explicit
mission refresh. Existing reader generation/cancellation/hello identity pinning
remains in charge. Detail reads also recheck the pinned Local hello after the
detail/member responses, refusing a daemon replacement during a held read.
This is not authentication or an atomic external snapshot.

Arrow/Home/End/Return opens list details; Tab/Return reaches named native
actions; Back/Escape returns through details/list/Overview and restores list
focus. Row/details identity scopes prevent another selection inheriting held
control state. Existing Overview scroll, draft/editor/IME, shared motion and
artifact readers are unchanged. No resource create/edit/remove, PR binding,
managed-ticket controls or task mutation is implemented.

## Verification

The source-backed faux schema uses the real passive detail shape. Pure tests
cover duplicate/missing/malformed/empty resources, exact URL/creator/relationship,
duplicate URLs with different IDs, unresolved numeric refs and task targets
beyond the Overview preview. Hidden actual GPUI `mission_resources` runs at
680/1100 in light/dark with an injected opener, keyboard/Back/Escape/Open/Copy,
exact mission/task selection, long Unicode rows/URLs, retained offline and
reconnect state, held A→B→A reads, stale callbacks, empty and failed reads.
Only faux hello/mission/member GET routes are admitted. Existing mission and
artifact checks remain separate regressions.

These are synthetic source/native checks, not live-data, OS browser/AX/IME,
Wayland, performance, release or user acceptance. General resource mutations,
managed-ticket delivery control and authoritative PR binding remain separate
parity work. See [finish checklist](finish-checklist.md).
