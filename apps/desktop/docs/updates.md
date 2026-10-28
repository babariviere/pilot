# Updates and explicit restart

The macOS arm64 app owns its updater. **Settings → Updates** has a manual check,
an explicitly saved automatic-check preference (off by default), authenticated
download, and an explicit **Install and restart…** action. A check or download
never arms installation. Ordinary Quit never installs an update.

Development inputs are deliberately unconfigured. No feed, public trust key,
Developer ID policy, credentials or Swift updater configuration is inferred.
The unconfigured panel says so and disables network/install actions. A compiled,
approved distribution configuration must match between GUI and helper; see the
[updater contract](../updater/README.md). This feature does not configure a
production release, feed, signing key or default-app switch.

Linux uses the same controller and explicit restart gates with its own signed
full-payload and native platform implementation. See [Linux updates](linux-updates.md)
for its distinct layout, trust and qualification boundaries.

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
or garbage-collected. At most four retained roots are admitted; eligible closures are bounded to 2 GiB.
Unknown or oversized evidence refuses further publication.

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

0. Pause agents first, as the Swift app does: renew `POST /api/update/pause` off the
   UI thread until every agent has paused after its current tool call. Input stays
   usable while waiting; Cancel stops renewal and agents resume within 30 seconds.
1. Fence UI admissions and reject preedit, unsaved secondary forms, unresolved
   deliveries/model changes/mission outcomes, active or unreaped visual helpers,
   and pending preference operations. Nothing is discarded to obtain readiness.
2. Capture exact editor/draft/outbox/cache/question revisions. An ordered writer
   checkpoint returns an actual durable ACK; a timer is never a flush receipt.
   Missing default preferences may be persisted by this explicit checkpoint;
   ordinary clean Settings Save remains a no-op.
3. Validate the whole authenticated candidate, retained capsule, exact process
   executable, configuration and owner generation. Persist a guard in the private
   same-volume transaction and start the matching helper, which waits for COMMIT.
4. Revalidate fresh exact checkpoint receipts and the reservation before COMMIT.
   Only acknowledged `ExitAuthorized` requests a clean GUI quit. Uncertain COMMIT
   stays recovery-required and fenced; it is not an undo or permission to edit.
5. The helper observes actual OS parent exit, verifies the same reservation again,
   then swaps the complete GUI bundle. Expiry/revocation before exit refuses the
   swap even after COMMIT. The existing daemon and its capsule remain untouched.
6. Relaunch carries a durable receipt. The new GUI restores the receipt-bound
   profile/port/denial-policy instead of trusting Launch Services environment,
   loads durable state, and explicitly acknowledges startup. `open` success alone
   is not startup success.

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
no session or helper holds the target lock. Two
retained transactions per install parent are the admission limit. Automatic
rollback, cleanup and privilege elevation are not implemented.

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
