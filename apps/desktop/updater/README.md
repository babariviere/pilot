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
  authorization/escalation, unrelated file replacement or deletion of old bundles.
- `src/helper.rs`, `src/bin/update-helper.rs`: private socket handshake, inherited
  permanent per-target lock, explicit durable COMMIT, then kqueue NOTE_EXIT on the actual
  spawning parent. No COMMIT means ordinary quit/EOF cannot install. A timer can abort
  waiting, but never quits/kills the app or permits installation. The helper rechecks
  signed archive bytes, re-extracts privately and verifies the full bundle before swapping.
- `src/lib.rs`: typed cancellable scheduler/controller. One flight until quiescent
  cancellation acknowledgement, operation generations fence old callbacks, hourly
  checks, bounded exponential failure backoff60s→1h, explicit manual checks. Downloads
  do not install. Staging, helper readiness and exit authorization are distinct states.
- `src/worker.rs`: one bounded background worker/command/result, plus one blocking
  helper-status watcher only while a helper exists, no idle polling, no
  network/file/signature work in render/UI handlers. Completion callback only schedules
  a foreground wakeup; the host drains results and reschedules one monotonic deadline.

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
   Before fencing, the GUI pauses agents at their next tool boundary through
   `coordination::pause_agents` (the daemon's renewable update pause, as in the Swift
   app); it never cancels a tool call. The concrete GUI
   uses `prepare_retained`, not a client assertion of `Runtime::Independent` or
   `SharedStopped`. Its native worker proves the exact sealed capsule/process/profile
   and obtains a nonrenewable reservation that accepts idle or paused sessions. Legacy/app-root
   and unproven runtimes refuse. The same reservation must remain valid after actual parent
   exit; no existing daemon is stopped, migrated, replaced or restarted.
6. Call `request_install(safety, now)` only after those acknowledgements. It starts a
   helper that waits for COMMIT; the live app remains unchanged. When `ExitPrepared`
   arrives, capture/revalidate **fresh** exact-revision receipts and fences, then
   `commit_exit(safety, now)`. Only after `ExitAuthorized` may integration request a
   clean quit. Keep all fences held; do not resume editing/admissions after COMMIT.
   A `CommitUncertain` error is recovery-required, never permission to continue normally.
7. Helper installs only after OS-observed parent exit, retains the old bundle in the
   transaction's `install-payload/Pilot Next.app`, and launches via `open -n` with a
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

Stages are private same-volume directories, permanent target lock files are never unlinked.
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
held open through extraction and the target inode rechecked immediately before the
swap; the retained/installed inode identities are checked afterwards too. Journal
transitions use a separate private nonblocking lock. Relaunch intent is durable before
launch, so fast startup acknowledgement cannot be overwritten by a later helper write.
The old app is retained after swap. Journals/archives/backups are not automatically cleaned
after publication. At most two retained transactions per install parent are admitted;
further preparation requires explicit recovery/cleanup. Fresh failed preparations with
no ready/pending journal are discarded by their owning worker, never committed evidence.
Directories are scanned with a4096-entry cap. Retained transactions are never blindly
retried; `recovery_phase` is read-only. A failed swap leaves the original in place.
Failed relaunch retains both bundles and reports RecoveryRequired. No automatic rollback
is claimed. If a crash happens between swap and journal update, target inode mismatch
refuses a blind second swap. A pending journal write refuses further mutation.
Cleanup/explicit rollback with running-process checks remains later recovery integration.

Cancellation is cooperative between bounded reads; it can take up to the HTTP timeout
during a blocked read. ZIP/file operations are bounded and off-UI. Helper readiness timeout
is30s, COMMIT wait60s, parent-exit wait120s; expiry aborts, never installs without exit.
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

Under original-owner resource admission and the repository verification-slot/mbx CPU2/4GiB
wrapper, using Rust1.98.1 and an isolated target directory:

```sh
cd apps/desktop/updater
cargo test --locked --features native-macos -- --test-threads=1
cargo clippy --locked --all-targets --features native-macos -- -D warnings
cargo build --locked --features native-macos --bin pilot-desktop-update-helper
```

The `native-macos` build compiles Objective-C against installed Foundation/Security,
not Swift. Tests are unit-registered from `tests/owned.rs` (`autotests=false` prevents
duplicate integration compilation). Tests use synthetic keys, faux network responses,
private temporary bundles and owned child processes. No real token, release/feed or
production app/daemon install/restart is exercised. See `evidence.md` for exact results;
synthetic component checks do not establish integrated GUI or production update acceptance.
