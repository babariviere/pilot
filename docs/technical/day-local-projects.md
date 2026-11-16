# Native local projects

Day's Settings uses four exact native methods: `day.projects.setup`,
`day.projects.preview`, `day.projects.action` and `day.projects.check`.
Rust selects the profile and owns operation IDs and the append-only command
ledger. The window cannot select a service, transport credential or operation ID.
Preview only reads; action is one durable send, and Check is receipt lookup only.
The daemon authenticates these routes with the existing native app capability.
Cold recovery never re-enters a project action. Registration/import-start
acknowledgements can be reconciled from their exact durable domain admission,
not a matching path or current status. Other lost acknowledgements stay Unknown.

## Reused behavior and changes

The workspace custody audit (Knowledge `2fe490ea-b1ba-49ca-9511-e2892d727f7a`,
revision 2, WS01–WS10) describes the existing shared jj store, read-only main
views, setup and idle refresh. Those stores and guards remain the owners.
The new host-owned `Project.sourceCopy` only applies to newly registered local
projects/imports. Existing projects are not migrated. `folder` uses the user's
directory. `jj` uses the shared store even when the user's repository is Git-only.
The persisted preparation recipe pins jj selection across interrupted startup.
Shared history/bookmarks are not independent clones.

Local preview binds canonical directory identity and the configured remote by
hash, without exposing a credential-bearing URL. Registration rechecks that
preview. Git sources must name the repository root, not a subdirectory.
The user's dirty files and Git/SSH configuration stay untouched. Source-policy
and cwd overrides cannot silently turn an isolated native project into an
in-place writer. Generic project JSON is now fsynced before its save returns.

`GitHubImportService` keeps its existing destination ownership, restart journal,
partial-clone confirmation, cancellation/drain and duplicate prevention. Its
registration now uses the local source policy. `GitHubSetupService` still owns
sign-in and exact dedicated-key approval. Explicit existing-SSH verification
adds normal config/agent reuse with host checks and account matching. Only
Pilot's own child-transport override can be released when switching identity;
user transport overrides remain untouched. No real account calls belong in tests.

Configured approved setup and restore remain existing daemon behavior, not TSX
side effects. Native standalone jj copies now join the existing main-refresh
scheduler and idle input boundary too. Inactive mission members remain excluded;
the same process, PR, revision and unpublished-work guards still decide refresh.
Settings shows configured hook names and does
not edit commands or widen approvals. The chat projection shows actual cwd,
not a guessed project path or an embedded terminal.

## Verification boundaries

Focused service tests cover passive preview, app authentication, exact action
receipts, no replay, plain-folder policy, Git-only jj isolation, dirty-source
preservation and read-only Ask main views. Existing GitHub/setup/refresh suites
cover their reused boundaries. Native tests cover exact method arguments,
capability denial, pending ledger recovery and saved drafts. The scripted TSX
journeys cover preview-before-effect, labels, uncertain-action holds and Check.

The focused scheduler probe used 10,000 session rows and 200 projects, with
100 timed passes after warm-up. Legacy median was 1.08 ms before and 0.68 ms
after; native standalone median was 1.42 ms. Under concurrent host load, p95
was 34.71, 33.60 and 45.26 ms respectively. This synthetic function probe is
not a streaming/event-loop or native UI latency qualification. Fetch concurrency
and cadence stay with the existing scheduler.

The full connected suite passed 25 tests when run serially. Two planning tests
timed out under concurrent native compilation and passed in isolation/serially;
do not treat that as a native input qualification. The full public-bridge suite
still has two older tests expecting repeated identical failure notifications
(`native_invalidations_are_coalesced_until_the_mirror_reads_again` and
`changed_then_inventory_snapshot_does_not_perpetuate_notices`). That expectation
conflicts with the earlier offline-loop fix; the owner was asked to reconcile
the fixtures. The new project bridge and saved-view checks passed separately.

The linked NSH artifact is a mockup, not the real view. Headless tests and source
checks do not qualify native appearance, focus, IME, screen readers, actual
GitHub sign-in, SSO, host trust or packaged daily use. No installed app/service
is changed by this slice. Required independent review remains separate from
code delivery; do not infer readiness or user acceptance from a pushed commit.
