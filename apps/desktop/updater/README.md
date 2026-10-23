# Native macOS updater foundation (not rollout-ready)

This **independent source checkpoint** contains a real Objective-C adapter to Sparkle
2.8.1, bounded authenticated GitHub release discovery, and a Rust scheduler/safety
protocol. It is not registered in the desktop application. No shared desktop manifest,
UI, startup, quit, Settings, CI or packaging files are changed here.

**Native archive download, extraction, installation and restart are deliberately
unavailable.** `MacOS::install_support` and `install` return
`Error::TransportUnavailable`, even if all caller-supplied safety flags are true.
This is not an auto-update-complete implementation. Do not ship or enable it as one.

## Why Sparkle and this bridge

Sparkle is the existing maintained macOS trust/installation mechanism. Pin **2.8.1**,
the version already pinned by the Swift app, for an isolated reproducible starting
point. Review a newer version separately before release. Use the framework's public
`SPUUpdater`, `SPUUpdaterDelegate`, `SPUUserDriver`, `SUAppcastItem` and
`SUStandardVersionComparator` APIs. Do not replace signature verification with hashes,
custom Ed25519 code, a shell-based app replacement or private Sparkle APIs.

The inspected Rust wrappers `hankbao/sparkle-updater` and `slint-ui/sparklers` do not
provide this combined credential, cancellation, item-policy and install-on-ordinary-quit
contract. The small app-owned Objective-C bridge implements those **probe** policies
directly instead of forking a framework or patching a general-purpose wrapper.

- Sparkle: BSD-3-Clause, plus bundled third-party notices, see
  [2.8.1 license](https://github.com/sparkle-project/Sparkle/blob/2.8.1/LICENSE).
  Keep the complete distributed framework's notices when packaging. No upstream
  implementation is copied into this crate.
- Cargo: no third-party Rust dependencies. `build.rs` invokes the installed system
  clang/ar only when `native-macos` is explicitly enabled. It does not download,
  install, sign, modify global configuration, invoke Swift or search other apps.
- The existing explicit framework fetcher pins the upstream archive to
  `5cddb7695674ef7704268f38eccaee80e3accbf19e61c1689efff5b6116d85be`:
  `apps/macos/scripts/fetch-sparkle.sh`. That checksum authenticates a build input,
  **not an application update**. It never substitutes for the app's signing root.

## Real native path and trust boundary

1. Construct `MacOS` on AppKit's main thread, with the **compiled Rust app identity**.
   It is `!Send`/`!Sync` and must be retained until normal main-thread teardown.
2. The bundle must be an arm64 `.app`, match that identity, not use the Swift bundle ID,
   and contain all explicit configuration below. An unbundled executable, missing
   configuration or wrong identity fails closed before network or credential work.
3. Integration supplies an in-memory token from an **existing explicitly approved
   provider** on every check. No automatic `gh` execution, environment token lookup,
   Swift Keychain access/migration, token storage or access UI is implemented. The
   API name is a caller contract, not independent proof of permission. Approval and
   repository provenance must be established by integration, not inferred from a string.
4. An ephemeral NSURLSession requests only a constructed exact-repository GitHub API
   URL. Every redirect is refused while authenticated. A release must be non-draft,
   non-prerelease with a `desktop-v` tag and exactly one of each Rust-specific asset.
   A separate request resolves the feed asset's API redirect. Only HTTPS
   `release-assets.githubusercontent.com`, with no explicit port/user/password/fragment,
   is accepted. The token is dropped before Sparkle is started, and never passed to
   Sparkle or the CDN. HTTP401/403/404 are sanitized authentication errors, other
   responses/redirects are typed failures. Metadata is capped at1MiB, deadlines30/60s,
   one connection/check, JSON decoding off-main. Errors contain no server body,
   credential, signed URL or native NSError description.
5. Sparkle performs an actual appcast check with the custom user driver. Scheduler,
   automatic downloads, permission prompt, system profiling and release notes are
   disabled. Exact selected archive API URL, strict numeric newer build version,
   `desktop-stable` channel, macOS application type, no delta and signature **shape**
   are required. The driver immediately dismisses an undownloaded offer. It never
   chooses Install. Unexpected cached downloaded/installing state is skipped, not
   dismissed, since dismissal can leave an install-on-quit helper armed.
6. `Available(Candidate)` means only **an unverified offer**. Its signature has not
   been cryptographically verified. Wrong archive/host/channel/platform/version and
   missing/malformed signatures are rejected, but a correctly shaped invalid signature
   cannot be discovered without downloading the archive. Never display “verified” from
   this event. Sparkle must verify the trusted archive signature before extraction and
   enforce bundle identity/version at installation in the future integrated path.

### Remaining material blockers

**Transport.** Sparkle2.8.1 exposes `willDownloadUpdate:withRequest:`, but not a public
per-hop redirect-admission callback. Its downloader owns NSURLSession, potentially in
an XPC service. Global NSURLProtocol registration in the app cannot safely enforce
that service's transport. The API→CDN resolution above protects the private token,
but Sparkle's subsequent **appcast fetch** still uses Sparkle-owned network policy.
There is no claim of end-to-end redirect allowlisting or a bounded Sparkle feed body.
No archive is downloaded through that path. Before enabling downloads, choose an
upstream-supported restrictive transport or explicitly approve/review a different
transport boundary. Do not fake the missing policy with a preflight HEAD, broadly
attach Authorization headers or rewrite/sign an appcast locally. A bespoke loopback
proxy, Sparkle fork or different installer is not adopted by this checkpoint.

**Ordinary quit.** Public Sparkle `willExtractUpdate:` is a notification, not an async
veto. Once its helper is prepared it may install on **any process termination**.
`shouldPostponeRelaunchForUpdate:untilInvokingBlock:` and
`willInstallUpdateOnQuit:immediateInstallationBlock:` can delay a relaunch request,
but retaining/dropping their blocks is not a general termination veto. A prepared
helper may survive an abort. Native checks here never prepare one.

Exact GPUI0.3.9 implementation inspected in the installed crates:

- `gpui-pre-0.3.9/src/app.rs`: `on_app_quit` explicitly cannot cancel quit;
  `shutdown` clears windows and waits at most `SHUTDOWN_TIMEOUT` (**200ms**) for futures.
- `gpui-pre-0.3.9/src/window.rs`: `on_window_should_close` returns a window-only veto.
- `gpui-pre-macos-0.3.9/src/platform.rs`: `quit` asynchronously sends
  `NSApplication terminate:`. GPUI's platform callback owns shutdown; its return value
  is not a public application-level safety hook that this crate can replace.

Integration must prove a real AppKit-level ordinary-quit gate, retaining the existing
GPUI delegate behavior. This crate does not replace/swizzle the app delegate, patch
GPUI or treat a timer/future as permission to quit. Force Quit/crash cannot be vetoed;
the design must not depend on an unacknowledged in-memory-only safety marker.

**Durability/runtime.** Before *any* future extraction/helper preparation, fence new
edits/admissions, keep preedit intact, and wait for exact durable receipts from drafts,
delivery and Settings. Acknowledgement must match the captured revision, not an old
“flushed” boolean. Failed writes defer with actionable errors; no cancellation of jobs
or silent discard. If updated resources include a daemon/runtime, integration must
reuse the existing safe preparation/shutdown protocol, verify the identified process
and lifecycle generation, and hold/revalidate safety throughout the installer lifetime.
The Swift `UpdatePreparation {ready, processId}` and `Daemon.pauseAndStopForUpdate`
behavior are references, **not** authority to add new backend endpoints, stop the
daemon, or infer readiness from a stale WebSocket list. A raw independent GUI-only
bundle may use `Runtime::Independent` only after packaging proves no shared resources
are replaced. No automatic real prepare/stop/send/create/approval/update action is tested.

## Registration and UI contract

All methods are short/nonblocking. Native network I/O is NSURLSession-owned; Rust
does not create a worker or periodic polling loop. `Updater<B>` takes monotonic
`Duration`s. Integration owns one cancellable deadline wakeup for `next_deadline()`
and reschedules after setting automatic checks or applying a completion. Healthy
checks run hourly; failures back off60s doubling to1h; explicit manual checks bypass
the deadline but never single-flight. Disabling scheduling does not cancel a manual
check. Cancel retains `Cancelling` until the native operation acknowledges quiescence.
Generation mismatches are ignored. Teardown cancels transport, invalidates the session,
revokes the wakeup and removes secret references. No timer calls quit/install.

```rust,ignore
// Later, after the shared-manifest owner hands off the registration seam:
// pilot-desktop-updater = { path = "updater", features = ["native-macos"] }
let backend = MacOS::new(COMPILED_NEXT_BUNDLE_ID, move || {
    // Schedule a deferred GPUI main-thread wakeup. Do not synchronously borrow or
    // destroy the updater from this callback; it runs inside native completion.
    wake_updater_controller();
})?;
let mut updater = Updater::new(backend, saved_automatic_preference, monotonic_now());
// Access must be approved/read asynchronously by the existing integration provider.
updater.backend_mut().supply_access(approved_access);
updater.check(Trigger::Manual, monotonic_now())?;
// In the deferred native wakeup:
if let Some(completion) = updater.backend_mut().take_completion() {
    updater.complete(completion, monotonic_now());
}
```

The native adapter must receive fresh access **before** each automatic or manual check.
An empty provider result is `Authentication`, not implicit consent to read another
credential source. UI states: checking, cancelling, current, **update offered, not
verified**, typed error, unavailable/unconfigured. Keep Install disabled with the
explicit transport/lifecycle reason. Do not expose synthetic-backend success as
native support. Map errors to static user-facing descriptions; never format tokens,
signed URLs, callback internals or server bodies. Ordinary app quit must not call
`request_install`; `stop` never installs. A synthetic backend exercises the future
safety protocol but does not confer native installation authority.

## Separate packaging prerequisites

These are proposed metadata names, not an approved production identity/feed:

| Key or asset | Required contract |
| --- | --- |
| `CFBundleIdentifier` | Separate Rust identity, compiled into integration, never `com.babariviere.pilot` |
| `CFBundleVersion` | Monotonic numeric1–4 components, max9 digits each |
| `SUPublicEDKey` | Separately provisioned Rust trust root, canonical base64 of32 bytes |
| `PilotNextUpdaterIdentity` | `rust-macos-v1` |
| `PilotNextUpdateRepository` | Approved owner/repo; no fallback to Swift metadata |
| `PilotNextUpdateChannel` | `desktop-stable`; appcast items must match explicitly |
| `SUEnableAutomaticChecks` | false, app owns schedule |
| `SUAllowsAutomaticUpdates`, `SUAutomaticallyUpdate` | false, hard probe-only policy |
| Release tag | `desktop-v…`, not Swift `v…` |
| Feed | `appcast-desktop-macos-arm64.xml`, not `appcast.xml` |
| Archive | `Pilot-Next-macos-arm64.zip`, not `Pilot-arm64.zip` |

The latest-release API intentionally does not crawl releases. An existing latest
Swift release or incomplete Rust release returns an identity/configuration failure,
not fallback to a different artifact. Packaging must settle repository/channel
discovery and sign/publish all assets atomically in its separately authorized work.
No production feed/release is created or modified here. No signing secret is read,
generated, replaced or shared. Identity/key separation and monotonically signed
versions need independent packaging verification before this configuration is usable.

Future packaging must embed the complete pinned framework at
`Contents/Frameworks/Sparkle.framework`, preserve helpers/XPC/third-party notices,
add the Frameworks rpath, sign nested code then seal/verify the app, and verify the
**archive signature against the actual embedded key** before publication. Define
Developer ID/ad-hoc trust and notarization explicitly, never silently copy the Swift
signing channel. The raw unsigned Rust CI binaries are not an installable update.
This does not alter Swift, Linux support, the user's installed app/daemon or defaults.

## Focused verification

Use the original desktop owner's resource admission and repository verification-slot
wrapper. Standalone Cargo commands must run through the existing bounded mbx setup
(CPU2/4GiB, isolated target directory, Rust1.98.1). Do not run local Swift builds/tests.

```sh
cd apps/desktop/updater
# Under the admitted mbx/verification wrapper:
cargo test --locked
cargo clippy --locked --all-targets -- -D warnings
# Native compile/link + Rust boundary tests (explicit project-local/read-only pinned framework):
PILOT_NEXT_SPARKLE_FRAMEWORK_DIR=/absolute/framework-parent cargo test --locked --features native-macos
PILOT_NEXT_SPARKLE_FRAMEWORK_DIR=/absolute/framework-parent bash tests/native.sh
```

`tests/lifecycle.rs` tests scheduling, single-flight/cancellation/generation fencing,
typed offline/auth/security failures, persistence revision receipts, work/preedit/runtime
deferral, synthetic install/retry/teardown. `tests/native.m` links the actual Sparkle
framework, interprets appcast items with Sparkle's public parser, exercises the actual
NSURLSession delegate with faux protocol responses, and validates temporary bundles.
It does not use real credentials or contact a real feed. “Valid” native fixtures mean
valid *metadata policy*, not a trusted signature. Cryptographically invalid archive,
verified archive download/extraction, real install/restart/recovery and GPUI integrated
ordinary-quit/durability tests remain **missing**, not mocked passes. No Linux or Swift
gate is implied. See `evidence.md` for exact results and outstanding acceptance work.
