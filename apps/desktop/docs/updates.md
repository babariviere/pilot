# Updates and explicit restart

The macOS arm64 app owns its updater. **Settings → Updates** has a manual check,
an explicitly saved automatic-check preference (off by default), authenticated
download, and an explicit **Install and restart…** action. A check or download
never arms installation. Ordinary Quit never installs an update.

**Load local build…** stages an explicitly selected, source-pinned signed complete
package. **Reload UI** checkpoints drafts/preferences and restores supported view
selection without pausing or replacing the daemon. Externally managed connections
can also install ordinary verified app-only updates, then reconnect to the same
pinned Local identity without daemon-management authority. See the exact
[UI iteration workflow](ui-iteration.md), requirements and limits.

Development inputs are deliberately unconfigured. No feed, public trust key,
Developer ID policy, credentials or Swift updater configuration is inferred.
The unconfigured panel says so and disables network/install actions. A compiled,
approved distribution configuration must match between GUI and helper; see the
[updater contract](../updater/README.md). This feature does not configure a
production release, feed, signing key or default-app switch.

Linux uses the same controller and explicit restart gates with its own signed
full-payload and native platform implementation. See [Linux updates](linux-updates.md)
for its distinct layout, trust and qualification boundaries.

## Version and download progress

Once a check authenticates a newer release, the panel names it from the signed
manifest: `Pilot Next <short version>` with its build number as quieter detail.
The same version stays visible while downloading, cancelling, staged and installing;
a failed or cancelled operation names none. Nothing is shown from an unsigned guess.

The download bar is determinate, measuring bytes written against the signed archive
size, which the transfer already enforces. The worker records the latest count and
wakes the panel at most every 100 ms. Before the first byte, during staging
verification and for local builds the bar is indeterminate. A full bar is not
a verified download: it is followed by "Verifying the download…" until staging
succeeds or fails. Cancel remains available throughout.

## Access and scheduling

Configured builds check and download the public release anonymously; the signed
envelope and archive digests, not the HTTP request, authenticate the update.
Only after GitHub refuses a request (typically the anonymous rate limit) does the
panel offer a masked access token for the exact release repository. It is
bounded, session-only, never serialized, and never obtained from gh, Keychain,
environment or agent/provider credentials. **Clear session access** clears the
worker's copy too. Unused typed access must be used or cleared before managed
close or restart, rather than silently discarded. Preedit is a veto, not
permission to submit or discard it.

The app-lifetime controller coalesces completion wakes, permits one operation,
and owns one bounded foreground scheduling timer. Scheduling resumes from the
saved preference; it is not tied to the Settings window's lifetime. Automatic
checks never grant installation permission. Cancellation is cooperative and
obsolete operation results cannot overwrite newer state.

## Immutable runtime, not daemon replacement

Before its first bundled daemon activation the app publishes a complete sealed
capsule, not just Node/kernel. It retains module-relative imports, helpers,
resources and production dependencies under their original relative paths.
Capsule identity hashes the bounded path/mode/content/link closure. Publication
is exclusive, checks signatures and closure before activation, and runs off-UI
with cooperative cancellation and a deadline. No existing root is overwritten
or garbage-collected. At most four retained roots are admitted; eligible closures
are bounded to 2 GiB. New staging directories hold a lease inherited by the copier;
only proven inactive staging evidence may move intact into the private runtime
history. Published runtimes are never moved. Legacy unleased stages require an
exact verified published duplicate and native proof that no copier or runtime
user still refers to the staging path; uncertainty retains them and refuses.
History is never purged and retained disk usage may grow. Capacity and archival
refusals are distinguished from identity failures and uncertain installation.

An update's signed full bundle must explicitly list the exact retained capsule
digest in `Contents/Resources/update-runtime-policy.json`. The default empty
allowlist does not assert compatibility. The existing exact-source owner gate
remains intact: startup uses the proven retained source, never pretends a new
runtime is that source. An already-running app-root/legacy daemon is not moved,
stopped, restarted or retroactively declared independent. Unproven reuse refuses.

The private owner endpoint authenticates boot/root/build/profile-bound requests
with a fresh nonce and HMAC. Install preparation acquires a single nonrenewable
180-second reservation, after freezing all admissions. Sessions qualify when idle
or when every worker has paused at a tool boundary; a working, unpaused or changed
worker refuses. pilotd survives the app swap, so background jobs and open terminals
do not block. The freeze keeps paused agents paused until startup ACK releases it;
nothing is stopped or interrupted mid-tool. Attempts, inspection time and nonce storage
are bounded. Expiry always releases admission; an early timer cannot expire a
still-valid reservation. This is a narrow private-profile proof, not general
authentication for the ordinary loopback API.

## Explicit install protocol

0. For a conventional managed-runtime install, pause agents first: renew `POST /api/update/pause` off the
   UI thread until every agent has paused after its current tool call. Input stays
   usable while waiting; Cancel stops renewal and agents resume within 30 seconds.
   UI-only reloads and external app-only updates skip this entire daemon-management
   step. Their daemon remains active throughout the app swap.
1. Fence UI admissions and reject preedit, unsaved secondary forms, in-flight or
   daemon-pending deliveries, unresolved model changes/mission outcomes, active or unreaped visual helpers,
   and pending preference operations. Nothing is discarded to obtain readiness.
   A form holds the install only while it has unsent input, an unanswered request
   or (for preferences) an unconfirmed write; a form that was merely opened, closed
   or answered does not, and an Unknown secondary outcome is never resent by a
   restart. The refusal names the first blocker (`update_hold.rs`) and offers a
   Show action that navigates to it through the ordinary guarded routes.
2. Capture exact editor/draft/outbox/cache/question revisions. An ordered writer
   checkpoint returns an actual durable ACK; a timer is never a flush receipt.
   Missing default preferences may be persisted by this explicit checkpoint;
   ordinary clean Settings Save remains a no-op.
   GUI-only restart may retain a durable Unknown immutable message without
   resolving it. Startup never checks or resends it; its identity, payload,
   newer draft and recovery actions survive unchanged. An unsaved volatile
   delivery observation (including a known ACK) still vetoes restart, as do
   failed writes and missing/stale checkpoint acknowledgements. The daemon-upgrade
   checkpoint keeps its stricter unresolved-delivery gate.
3. Validate the whole authenticated candidate, retained capsule, exact process
   executable, configuration and owner generation. Persist a guard in the private
   same-volume transaction and start the matching helper. On macOS the helper
   re-authenticates/extracts/syncs its own private OS-temporary installation payload before
   readiness, then waits for COMMIT. The GUI is still open during this work;
   restart admission/editing fences remain held.
   Bundled UI-only reloads inspect the retained proof without reserving the daemon.
   External app-only updates record only their exact Local profile/port/hello pin.
4. Revalidate fresh exact checkpoint receipts and the applicable reservation,
   retained proof or external identity pin before app-helper COMMIT.
   Only acknowledged `ExitAuthorized` requests a clean GUI quit. Uncertain COMMIT
   stays recovery-required and fenced; it is not an undo or permission to edit.
5. The helper observes actual OS parent exit and re-authenticates the archive.
   On macOS it rehashes the exact helper-prepared closed payload; Linux retains
   post-exit extraction. It rechecks native signature, source closure and the same
   guard. macOS copies the candidate into a hidden private same-volume transaction
   entry without an `.app` suffix, verifies its exact closure and native signature,
   then atomically swaps the complete GUI bundle. A cross-volume temporary directory
   never participates in the final rename.
   Expiry/revocation before exit refuses the
   swap even after COMMIT. The existing daemon and its capsule remain untouched.
6. Relaunch carries a durable receipt. The new GUI restores the receipt-bound
   profile/port/denial-policy instead of trusting Launch Services environment,
   loads durable state, and explicitly acknowledges startup. `open` success alone
   is not startup success. UI-only/external receipts reconnect without invoking a
   daemon launcher; ordinary update checks keep the same release configuration.

## Recovery and evidence boundaries

### macOS install preflight

`/Applications/Pilot Next.app` is supported when the app is user-owned and sealed.
The standard root:admin, 0775 `/Applications` parent is allowed specifically;
other group-writable parents, world write, symlinks and unsafe ACLs remain refused.
Do not chmod system directories or relocate the app to work around a startup error.

Before advising an installation is usable, check both the full payload inventory
and native installation policy. Payload/seal success alone does not check parents:

```sh
python3 apps/desktop/scripts/bundle_runtime.py verify '/Applications/Pilot Next.app'
bash apps/desktop/scripts/cargo.sh run --locked --manifest-path updater/Cargo.toml \
  --features native-macos --example install-preflight -- '/Applications/Pilot Next.app' \
  '/path/to/authenticated-release/updater-inputs.json'
```

The preflight shares startup's filesystem predicate and native signature/identity
checks, but does not authenticate its supplied release configuration, publish capsules,
launch a window, or touch daemon/profile state. Use configuration from the separately
verified release. A later retained-runtime compatibility refusal is a separate issue.
Never overwrite an open app; obtain user close/approval before installing a correction.

Recovery metadata is read-only, with details and copyable retained paths. Failed
swap leaves the old app; failed relaunch/startup keeps both bundles and reports
uncertainty. Transactions and backups are not blindly retried or deleted; the one
exception is a download never committed (phase `Ready`), which startup removes once
no session or helper holds the target lock. Two active transactions per install
parent remain the admission limit. When staging needs room, older acknowledged
transactions are moved intact into private `.pilot-next-updater-history/` under
the permanent target and journal locks. The signed archive and exact rollback
inode must still match; current receipts, pending writes and uncertain installs
stay in place. Original receipt paths resolve into acknowledged history for
inspection. History is never purged. Capacity and archive refusals report that
nothing was installed, rather than claiming an uncertain install result.
Automatic rollback and privilege elevation are not implemented.

### Temporary payloads, durable recovery

On macOS, downloads, extracted preview apps and helper-prepared apps use an exclusive
mode0700 OS temporary directory, not `/Applications`. The helper inherits the target
lock and reopens the exact private path/device/inode recorded in the durable
transaction; GUI lifetime or differing helper environment cannot delete or redirect
it. Purged/replaced temporary data refuses installation while durable recovery
evidence remains. Successful swap cleans only that workspace. Unknown/committed
failures are retained, not automatically retried or cleaned.

The installed target remains `/Applications/Pilot Next.app` (or the original supported
relocated target). Journals, signed metadata, an authenticated archive copy, receipts
and the exchanged rollback inode remain durable beside it and in acknowledged history.
New rollback/commit entries are private `install-payload/bundle` directories without
`.app` suffixes. Existing `.app` backups remain unchanged and could still be indexed;
no live cleanup or indexer manipulation is performed. See the
[updater storage contract](../updater/README.md#recovery-and-explicit-limits).

`scripts/verify_update_lifecycle.py` runs only native arm64 macOS synthetic
fixtures: signed temporary minimal test apps, the actual helper, owned Node
owner/reservation code, OS-observed parent exit, whole-bundle swap, real relaunch
and startup ACK. It covers success, cancel and post-exit expired-lease refusal
(the last uses explicit fixture-clock fault injection). It records source/binary
hashes and refuses source changes during qualification. This is not a full GUI
bundle, Gatekeeper/notarization, production feed or macOS-version acceptance test.
Mounted Settings probes separately render real GPUI light/dark 680/1100 windows
and check native controls/focus. Portable unit tests are not Linux GUI evidence.
Linux GUI packaging/qualification is separate; Linux install/update stays disabled
until independently implemented and verified. Swift remains installed and unchanged.

The [restart timing audit](update-timings.md) separates pre-quit preparation,
post-exit replacement/relaunch and startup ACK. Its isolated native fixtures do
not establish the cause or resolution of a reported full-GUI one-minute blackout.
