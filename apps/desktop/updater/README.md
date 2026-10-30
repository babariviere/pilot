# App-owned desktop updater

Standalone Rust core with app-owned macOS and Linux platform implementations.
Registered in the desktop app. Source wiring and synthetic native tests do not
establish full-payload production update qualification.
Development/unconfigured builds cannot construct a running-app worker or enable the
helper. No default points at the Swift application, its feed, credentials or keys.

## Ownership and implementation

- `src/manifest.rs`: ring verifies Ed25519 over the exact raw signed manifest bytes.
  Identity/channel/platform/architecture/build/short version/archive asset id/name/
  size/digest/bundle name are all signed. Duplicate/unknown JSON fields, wrong identity,
  malformed versions and invalid signatures fail closed. Numeric build comparison is
  explicit, not lexical. Digests alone never establish publisher authenticity.
- `src/transport.rs`: ephemeral in-memory access explicitly supplied by an approved
  provider. Own HTTPS client with automatic redirects/proxies disabled, verified TLS,
  10s connect/120s request timeout, at most three redirected hops, bounded bodies and
  incremental cancellation. Authorization is sent only to constructed exact-repository
  GitHub API URLs. Every redirected hop must be the HTTPS release-assets CDN, with no
  userinfo/fragment/nondefault port; no redirected hop can return to a credential origin.
  No token reaches the CDN. No implicit gh/Keychain/environment credential reads,
  token migration/storage, response-body logging or signed URL logging.
- `src/archive.rs`: signed size/SHA256 checked before ZIP parsing. Private staging,
  max1GiB archive/2GiB expanded/30,000 raw central records, bounded paths, exact single app root,
  create-new files, no device/setuid extraction. Symlinks appear only after file writes;
  canonical targets must remain inside the bundle. No writes through archive symlinks.
  Before eager ZIP indexing, admission checks ZIP32/ZIP64 single-disk footer agreement,
  at most 30,000 raw records and 64MiB of directory/footer metadata. Raw duplicate
  names (including file/directory aliases) are rejected; post-index count agreement
  also rejects Unicode-extra-field deduplication. Admission is
  matched to zip8.6.0's dispatch/effective count before indexing, including mixed
  ZIP32/ZIP64 sentinel fields (a per-disk-only sentinel is refused).
  The exact admitted metadata is
  snapshotted in cancellable chunks. Indexing cannot select an older unadmitted
  footer and has a 4× metadata read-work budget plus cancellation on reads/seeks.
  Canonical archives end at their declared EOCD comment, with contiguous directory
  and footer records and absolute offsets, not split/self-extracting/trailing-junk
  ZIPs. ZIP decoding, compression, ZIP64 entry extras and CRC remain library-owned.
- `src/installer.rs`, `native/platform.m`: whole-bundle identity/version and Security
  framework signature/compiled requirement checks, repeated after parent exit. Same-volume
  native `renameatx_np(RENAME_SWAP)`, durable journal and retained old app. No administrator
  authorization/escalation or unrelated file replacement. The exchanged old app is
  removed after verified GUI startup and daemon handoff, not kept as update history.
- `src/helper.rs`, `src/bin/update-helper.rs`: private socket handshake, inherited
  permanent per-target lock, explicit durable COMMIT, then kqueue NOTE_EXIT on the actual
  spawning parent. No COMMIT means ordinary quit/EOF cannot install. A timer can abort
  waiting, but never quits/kills the app or permits installation. The helper rechecks
  signed archive bytes and verifies the full bundle before swapping. On macOS it
  freshly extracts a second disposable private payload before READY, retains its exact
  tree digest only in helper memory, then rehashes the closed tree after OS exit.
  Changed/additional files, modes or links refuse installation, including resources
  outside the native seal. Linux retains post-exit extraction.
- `src/lib.rs`: typed cancellable scheduler/controller. One flight until quiescent
  cancellation acknowledgement, operation generations fence old callbacks, hourly
  checks, bounded exponential failure backoff60s→1h, explicit manual checks. Downloads
  do not install. Staging, helper readiness and exit authorization are distinct states.
- `src/worker.rs`: one bounded background worker/command/result, plus one blocking
  helper-status watcher only while a helper exists, no idle polling, no
  network/file/signature work in render/UI handlers. Completion callback only schedules
  a foreground wakeup; the host drains results and reschedules one monotonic deadline.
- `src/app_update.rs`, `src/iteration.rs`: separate external app-only pins from
  managed runtime reservations, and import explicitly selected source-pinned local
  signed full packages through the same staging/helper/native installer. UI-only
  retained reloads inspect the capsule without pausing agents. See
  [UI iteration](../docs/ui-iteration.md) for commands and retained-backup limits.

GPUI Kit's [auto-update guide](https://gpui-kit.com/docs/auto-update/) is guidance,
not an installer. The inspected gpui-updater Sparkle adapter still installs on ordinary
quit. The earlier Sparkle-only probe has been replaced by this explicitly app-owned
design, not a Sparkle fork or borrowed GPL implementation. No custom cryptography.

### Direct dependency pins/licenses

`ring0.17.14` (Apache-2.0 AND ISC) supplies Ed25519. `reqwest0.12.28`,
`serde1.0.229`, `serde_json1.0.154`, `base640.22.1`, `sha20.10.9`,
`url2.5.8`, `libc0.2.191` use their upstream permissive MIT/Apache-family licenses;
`zip8.6.0` supplies ZIP decoding (MIT); app-owned admission supplies the bounds. See each pinned package's license and
the Cargo.lock transitive dependency inventory when packaging notices. System
Foundation/Security and clang/ar are used only with `native-macos`; no Swift build,
downloaded framework, global install, gpui-updater dependency or signing secret.

## Signed release contract (separate Rust identity)

Latest release must be non-draft/non-prerelease, tagged `v<short_version>`,
with exactly one uploaded `desktop-macos-arm64-update.json` and
`Pilot-Next-macos-arm64.zip`. No fallback to Swift `appcast.xml`, `Pilot-arm64.zip`
or arbitrary browser URLs. The stable release can also contain the independent Swift and Linux assets. A release
missing the exact Rust GUI pair fails identity policy, never falling back or searching
for Swift assets. See [release wiring and prerequisites](../docs/releases.md).

Envelope, max128KiB, both fields standard base64:

```json
{"signed":"<exact UTF-8 JSON bytes, base64>","signature":"<Ed25519 signature of those bytes, base64>"}
```

Signed object (`schema:1`, every field required, unknown fields refused):

```json
{"schema":1,"application_id":"<approved Rust bundle id>","channel":"desktop-stable","platform":"macos","architecture":"aarch64","build":"101.1","short_version":"0.1.1","bundle_name":"Pilot Next.app","archive_name":"Pilot-Next-macos-arm64.zip","archive_asset_id":123,"archive_size":456,"archive_sha256":"<64 lowercase hex digits>"}
```

The public key is trusted compiled configuration, not something returned by the feed.
The signed archive digest authenticates the entire ZIP before extraction; native
Security additionally verifies the staged complete bundle and expected code requirement.
Human and build versions must exactly match the staged plist. Build versions are1–4
numeric components (max9 digits each, no leading zeroes), ordered with zero-filled tails.
Older builds are rejected; an equal build is no update. No key rotation is implemented.

## Lifecycle/registration contract

The desktop app now uses this crate as a macOS path dependency, with an app-lifetime
controller, native Updates Settings, explicit durability checkpoints, helper packaging,
retained-runtime reservation and startup/recovery handling. Shared CI also checks the
standalone crate. See [GUI integration and limits](../docs/updates.md). Production
trust/feed/signing configuration is deliberately absent from development assembly.

1. Build GUI and helper with the **same** approved public configuration:
   `PILOT_NEXT_UPDATER_PUBLIC_KEY` (base64 raw32-byte Ed25519 key),
   `PILOT_NEXT_UPDATER_REPOSITORY`, `PILOT_NEXT_UPDATER_APPLICATION_ID`,
   `PILOT_NEXT_UPDATER_BUILD`, `PILOT_NEXT_UPDATER_CODE_REQUIREMENT`.
   Missing configuration fails `Unconfigured`. The Swift bundle id is refused.
   The requirement must express the approved bundle identity/Developer ID team, or
   an explicitly chosen ad-hoc private-distribution policy backed by signed metadata.
   No policy/key is inferred from the installed Swift app. Never put signing secrets
   or access tokens in these build variables.
2. Embed the matching helper at
   `Pilot Next.app/Contents/Helpers/pilot-desktop-update-helper`, with the GUI binary
   at `Contents/MacOS/pilot-desktop`. The helper verifies its actual parent's executable
   is that binary in the same bundle, not a shell, other app or orphan. Sign nested code,
   seal/verify the full bundle, and settle Developer ID/notarization vs private ad-hoc
   signing. Current installer supports user-owned writable installations only. It does
   not elevate, touch package-manager installs or silently change install ownership.
3. On explicit supported-app startup, construct `worker::Worker::for_running_app(wake)`
   and `Updater::new(worker, saved_automatic_preference, monotonic_now)`. `wake` must
   schedule foreground work, never run GPUI on the worker. Supply fresh approved
   `transport::Access` before each check/download. Keep one cancellable timer for
   `next_deadline()`. Apply `take_completion()` through `complete(...)` in foreground.
4. Manual check → `check(Manual, now)`. Available is authenticated signed metadata,
   not a staged/active update. Explicit Download → `download(now)`, which yields
   `ReadyToRestart` only after signed bytes and full bundle validation. Do not relabel
   the running version. No helper is armed by checks, download, scheduling or ordinary quit.
5. Explicit Restart intent fences edits/admissions and captures fresh durable receipts
   for drafts, deliveries and Settings. Preserve uncommitted IME/preedit and unsaved text.
   The GUI never pauses agents or freezes daemon admissions for an app swap. The
   macOS GUI flow verifies the replacement app independently of the running daemon.
   The next startup handles any needed managed-daemon upgrade separately. Linux and
   legacy runtime receipts keep their existing verification behavior.
6. Call `request_install(safety, now)` only after those acknowledgements. It starts a
   helper that waits for COMMIT; the live app remains unchanged. When `ExitPrepared`
   arrives, capture/revalidate **fresh** exact-revision receipts and fences, then
   `commit_exit(safety, now)`. Only after `ExitAuthorized` may integration request a
   clean quit. Keep all fences held; do not resume editing/admissions after COMMIT.
   A `CommitUncertain` error is recovery-required, never permission to continue normally.
7. Helper installs only after OS-observed parent exit, retains the old bundle in the
   transaction's durable rollback entry, and launches via `open -n` with a
   receipt argument. New app must durably load its state and explicitly call
   `acknowledge_startup`. `open` success alone is not startup success or update acceptance.

GPUI0.3.9 `on_app_quit` cannot veto and waits at most200ms after clearing windows.
This updater does not use that callback as a flush gate, replace/swizzle the app delegate,
install on unrequested termination, force quit, or put a prepared Sparkle helper behind
ordinary quit. Integration still needs normal unsaved-input protection and deliberate
quit handling; a timer is not a durability acknowledgement. Abrupt death before COMMIT
leaves the installed bundle unchanged. Abrupt death after explicit COMMIT follows the
already acknowledged/fenced install intent; safety must be established before sending it.

## Recovery and explicit limits

macOS downloads and extracted preview/helper-prepared `.app` payloads live in an
exclusive mode0700 `mkdtemp` directory in the OS temporary directory (normally
`/private/var/folders/…/T`, or canonical `/tmp`). They are **not** staged under
`/Applications`. An unsafe temporary root or one inside the installation parent
is refused. The durable transaction records the exact temporary path/device/inode;
the helper uses that record, not its environment or a GUI-owned auto-deleting guard.
Every use checks canonical path, private ownership/mode/ACLs and inode identity.
Dropping the GUI worker cannot delete a helper's payload. Temporary storage may be
purged: a missing/changed payload refuses installation, never authorizes a retry.
Preview and helper-preparation trees are disposable, so their files and directories
are not fsynced. Closed writes, ZIP/CRC/path admission and native/closure verification
still apply. The authenticated retained archive is synced independently. Legacy
same-volume payloads and Linux extraction retain their durability barriers.

After COMMIT and OS-observed parent exit, the helper copies the prepared tree with
`ditto` into the private same-volume transaction's `install-payload/bundle`, **without
an `.app` suffix**. It never renames from temporary storage, so a different volume
is supported. The copier inherits the permanent target lock. The complete copied
closure must match the helper's in-memory digest; native signature, signed source
and guard checks still precede the existing inode-checked atomic exchange. Files
and both rename parents are synced before the durable journal advances. This
adds a post-exit copy/verification cost; earlier restart timing measurements do not
measure this layout. No shorter blackout is claimed here.

The final app stays `/Applications/Pilot Next.app` for that installation; relocated
supported targets stay where they were. Journals, verified manifest, authenticated
archive copy, UI/runtime receipts and the exact exchanged old inode stay in the
durable private transaction beside the target. Rollback must survive temporary
purges and reboot. New rollback entries use `install-payload/bundle` too, not an
indexable `.app` sibling. Legacy terminal transactions/history keep their original
`install-payload/Pilot Next.app` layout until proven cleanup. No guarantee is made about
third-party scanners that ignore private/hidden paths or index bundle contents.

After successful relaunch, the helper removes only the exact temporary workspace,
outside the pre-relaunch critical path. If interrupted, ordinary recovery inspection
under the target and journal locks can remove that workspace only for a post-swap
phase with authenticated retained archive and the exact exchanged rollback inode.
Changed workspace identity, pending writes or unproven exchange retain the evidence.
This temporary-workspace cleanup does not remove the durable receipt, archive,
rollback or startup ACK. Terminal transaction disposal requires the separate
verified-daemon gate below. No broad temporary-directory or runtime-store scan is added.
Pre-COMMIT helper cancel removes only its prepared extraction so the verified preview
can be retried.
Failed/incomplete downloads and proven inactive Ready cleanup also remove their
exact workspace. No committed/Unknown transaction is removed or replayed; only the
positively proven post-swap temporary workspace qualifies above.
Unreferenced temporary directories after an interrupted initial creation are left
to OS temporary-storage cleanup, never discovered by a broad deletion scan.
Linux keeps its previous staging layout. Permanent target lock files are never unlinked.
Writable installation parents/unsafe ancestors are rejected, with one macOS exception:
the exact `/Applications` directory may be root:admin (UID 0/GID 80), mode 0775.
Administrators are trusted to replace apps in that system directory. This does not
admit arbitrary group-writable paths, symlinks, write-capable ACLs, world-writable
directories or administrator-owned app bundles. `/Applications/Pilot Next.app` must
still be user-owned with a safe bounded tree and valid native seal/identity. There is
no privilege escalation and no chmod of existing paths. Linux policy is unchanged.
The parent directory is
checked for macOS extended ACL write/delete/security grants, not just POSIX mode bits;
the installed bundle's bounded file tree is checked too, including the helper's ancestors
and contents, so permissive nested ACLs cannot race verified executable launch.
only newly created private staging has inherited ACLs stripped. Existing user paths
are never chmod/ACL-repaired by the installer. Reopened private stages refuse allow ACLs.
The parent directory is
held open through final preparation and the target inode rechecked immediately before the
swap; the retained/installed inode identities are checked afterwards too. Journal
transitions use a separate private nonblocking lock. Relaunch intent is durable before
launch, so fast startup acknowledgement cannot be overwritten by a later helper write.
On macOS the old app is retained after swap, including after GUI startup ACK:
the old daemon may still be using that bundle's files. At most one unfinished GUI
transaction is admitted. Before another download, staging retries terminal cleanup
under the target lock. If the global no-use census is busy or denied by macOS,
authenticated acknowledged/aborted transactions remain untouched at their original
paths. Up to four transactions including the new stage are admitted; a full
retention budget still blocks staging. The normal 1 GiB archive and 2 GiB expanded
payload limits continue to apply per update. This is bounded retention, not proof
that retained bundles are unused or permission to delete or relocate them.
After verifying daemon handoff to the current installed target (or verifying an
already-current daemon), integration calls `installer::cleanup_completed(target,
trust)` off-main. GUI ACK alone must never call this API. The permanent target
lock and each transaction's journal lock exclude active writers. Cleanup requires
a terminal acknowledged/aborted journal with no pending write and an authenticated
signed manifest. A bounded native census must prove any remaining rollback app is
unused, including by other profiles and foreground processes. An acknowledged
swap's rollback entry, if still present, must match
the exchanged inode; an already-removed rollback is allowed. Obsolete archives need
not exist or pass rehashing, and rollback contents are not reverified for deletion.
Every present terminal rollback also requires a bounded native global no-use probe,
including foreground daemons under other profiles. A busy or uncertain census
preserves the transaction; a missing rollback needs no probe. Each probe is capped
at two seconds and the remaining cleanup deadline.
New staging retries the same terminal cleanup under its already-held target lock,
without polling. Cleanup is best effort: unrelated unsafe legacy history is preserved,
while surviving unfinished transactions still block admission of another stage.
Acknowledged builds newer than the current app are retained. Failed proof retains
active evidence and blocks new staging, never authorizes replay. Terminal retention
admission requires the same signed completion and acknowledged rollback-inode proof, idle journal
writers, and no pending write, but does not require proving absence of resource users.
Unsafe or unreadable legacy history is preserved without blocking unrelated staging.

The same gate purges proven legacy terminal entries in the private sibling
`.pilot-next-updater-history/`, including their archives and backups. Unrecognized,
uncertain, redirected or mismatched history is preserved. An empty validated history
directory is removed. No runtime capsule is deleted. The permanent target lock is
never unlinked. Each directory scan is bounded to4096 entries. Each cleanup call
starts no further item after ten seconds; an in-progress filesystem operation
may exceed that budget. Larger legacy
backlogs drain over later verified startup calls, not an unbounded worker task.
Linux retains its
previous two-active-transaction/intact-history archival behavior.

`installer::transaction_path` still resolves surviving legacy history for read-only
inspection. Completed macOS receipts are intentionally unavailable after verified
cleanup; callers must consume startup/navigation receipts before daemon handoff
cleanup. A failed swap/relaunch or pending journal remains inspectable, with no
automatic rollback or retry. Reconciliation may mark an unapplied stopped commit
aborted only after proving the unchanged original target inode and signed manifest.

Cancellation is cooperative between bounded reads; it can take up to the HTTP timeout
during a blocked read. ZIP/file operations are bounded and off-UI. Helper readiness timeout
is120s on macOS (includes full pre-quit extraction/verification), 30s on Linux;
COMMIT wait60s, parent-exit wait120s; expiry aborts, never installs without exit.
The longer readiness bound does not grant more COMMIT, reservation or exit time.
Pre-COMMIT cancellation removes only that helper's fresh preparation while the
journal is still Ready, allowing another explicit attempt. Committed/uncertain
evidence is retained; a new helper never adopts a prior prepared-payload digest.
See [critical-path timings](../docs/update-timings.md) for the deadline audit and
synthetic measurements, not a claim about production GUI blackout.
Helper EOF/abort is delivered through a blocking status watcher with generation fencing,
not an idle polling timer; prepared/authorized UI cannot remain falsely ready after
helper death. A lost COMMIT receipt is uncertain, not an undo of durable intent.
There is no elevated install, automatic provider-credential discovery, daemon
replacement, rollback UI or production GUI update acceptance claim. GUI Settings,
explicit quit coordination, anonymous public checks with optional session-only access, retained-runtime proof and
startup/recovery handling are integrated; synthetic component/helper checks do not
establish full production-bundle, Gatekeeper, notarization or macOS-version acceptance.

## Linux platform

The Linux implementation reuses the signed manifest/archive/controller/journal core,
with signed full inventories, native pidfd parent-exit monitoring and atomic
renameat2 directory exchange. See [Linux updates](../docs/linux-updates.md) for
the exact package/trust contract, preserved daemon and qualification boundaries.
Linux tests use `--features native-linux`; macOS tests retain `native-macos`.
Production configuration/qualification is separate from synthetic test success.

## Focused checks

On macOS, ordinary packaged startup passes the verified installed app to the
read-only connection check. It verifies the live profile/boot challenge and daemon
identity, not an old runtime path, capsule allowlist or deleted files. UI receipts
pin daemon ID and storage lineage across the swap (not a boot or PID, so normal
daemon recovery remains possible); an executable moved into rollback remains
connectable without becoming daemon-management authority. GUI swap guards
persist the canonical installed target and reject a live runtime rooted inside
it, both at preparation and every later check. Such a service must explicitly
migrate to an independent immutable copy before a GUI swap. The replacement GUI
still requires its exact signed build/source configuration. It does not publish
another runtime capsule during connection. macOS services keep one active runtime
copy outside the replaceable GUI, plus one candidate only during handoff. The new
private service store has no historical archive or old-release allowlist; legacy
store capacity is not a prerequisite for staging a new service runtime.

After durable GUI startup acknowledgement, the configured macOS app checks its
verified managed launch agent once. An older runtime uses the separate native
handoff, with tool-boundary pause and an exact reservation before shutdown.
Newer runtimes, external connections and custom services are not replaced. Equal
versions also migrate when their authenticated runtime build tuple differs.
GUI swaps use no reservation; existing legacy receipts keep their original
reservation verification/release behavior.

Under original-owner resource admission and the repository verification-slot/mbx CPU2/4GiB
wrapper, using Rust1.98.1 and an isolated target directory:

```sh
cd apps/desktop/updater
cargo test --locked --features native-macos -- --test-threads=1
cargo clippy --locked --all-targets --features native-macos -- -D warnings
cargo build --locked --features native-macos --bin pilot-desktop-update-helper
```

The opt-in `native_read_only_connect_and_ui_guard_ignore_old_runtime_files`
test uses signed temporary apps and a private Node child, not launchd. Set
`PILOT_DAEMON_UPGRADE_FIXTURE_NODE` to an absolute Node 24 executable and run that
test with `--ignored --test-threads=1 --nocapture` to verify missing-file reconnects,
GUI guard persistence and stable identity across daemon boots without old runtime policy.

The `native-macos` build compiles Objective-C against installed Foundation/Security,
not Swift. Tests are unit-registered from `tests/owned.rs` (`autotests=false` prevents
duplicate integration compilation). Tests use synthetic keys, faux network responses,
private temporary bundles and owned child processes. No real token, release/feed or
production app/daemon install/restart is exercised. See `evidence.md` for exact results;
synthetic component checks do not establish integrated GUI or production update acceptance.
