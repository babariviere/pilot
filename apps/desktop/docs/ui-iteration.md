# Explicit UI iteration updates

This is a complete app replacement, not in-process Rust hot swapping. Build in
the background, then choose **Settings → Updates → Load local build…**. Once the
signed complete package is verified, **New build ready** offers **Reload UI**.
Nothing installs on an agent commit, a build completion, a check, or ordinary Quit.

The existing ordered writer must acknowledge an exact durable draft/outbox and
preferences checkpoint before exit. Preedit, in-flight or daemon-pending delivery,
unsaved forms and active native helpers defer reload without discarding content.
An immutable message with a durably retained Unknown outcome can survive a
GUI-only restart unchanged. The exact fresh writer checkpoint is still required;
unsaved text, failed writes and delivery observations/ACKs held only in memory
still defer it. Cold startup neither checks nor resends the message. Its unresolved
status and explicit Resolve actions remain available after restart. This does not
relax daemon-upgrade admission or mark a message accepted/rejected. The helper
still requires explicit COMMIT and actual OS-observed parent exit before its
native whole-bundle swap/relaunch. The previous bundle remains in the transaction's
`install-payload` directory. Recovery details expose retained paths; no automatic
rollback, cleanup, or privilege elevation is claimed.
The existing two-retained-transaction limit still applies. After two completed
updates, inspect the retained backups and arrange explicit cleanup before another
iteration; this feature never silently deletes an older rollback bundle.

UI-only reload leaves agents and the daemon running. It never pauses tools or
acquires a daemon update reservation. A Next-owned connection still proves its
exact immutable retained capsule and candidate compatibility policy. An externally
managed connection instead pins the profile, port, daemonId and lineageId using
GET-only hello checks. It receives no retained-runtime, pause, reservation, service,
upgrade or process-management authority. A known daemon using the app's mutable
runtime is refused. This is identity pinning, not loopback request authentication.

Relaunch reconnects to that same connection without starting a daemon. A missing,
changed or incompatible daemon refuses startup rather than falling back, switching
profiles or starting another. Durable drafts and delivery evidence remain intact.
Only supported passive view selection is restored; sends and queued actions are
never replayed. Unavailable selections remain unavailable, not silently retargeted.
Transient dialogs, text selection and navigation history are not restored.

## Build and stage locally

Use an approved macOS arm64 build host. Packaging builds native Swift helpers,
so do not run the packaging command in a no-local-Swift lane. This feature does
not install or restart anything by running these commands. See the
[bundled runtime contract](bundled-runtime.md) and [update contract](updates.md).

Use the **existing approved** public configuration and matching publisher key.
No key is generated, rotated, read from GitHub or inferred from Swift. A build
with unconfigured trust cannot load local builds. Keep private keys outside the
checkout and out of shell history/logs; the signing process accepts the existing
`PILOT_NEXT_UPDATER_PRIVATE_KEY` environment variable, just like release tooling.

```sh
SOURCE=<full-40-character-immutable-commit>
OUTPUT=<fresh-absolute-build-directory>
# Existing approved configuration, not new trust:
# PILOT_NEXT_SIGNING_POLICY=private-adhoc
# PILOT_NEXT_UPDATER_PUBLIC_KEY, PILOT_NEXT_UPDATER_REPOSITORY
# PILOT_NEXT_UPDATER_BUILD (numeric, strictly newer than installed app)
# PILOT_NEXT_ACCEPTED_CAPSULES='["<exact-active-Next-capsule-digest>"]'
# The capsule allowlist is needed only for Next-owned retained connections.

# Background build. Run on the supported build host, not the user's live app.
python3 apps/desktop/scripts/gui_release.py macos \
  --source "$SOURCE" --output "$OUTPUT" >"$OUTPUT.log" 2>&1 &
BUILD_PID=$!
wait "$BUILD_PID" || exit 1

# Existing approved private key must match the installed app's compiled public key.
node apps/desktop/scripts/iteration-manifest.mjs "$OUTPUT" "$SOURCE"
```

The currently qualified local iteration entry is macOS-only; no new Wayland
iteration qualification is claimed. Existing normal Linux updates are unchanged.

This uses immutable source packaging and mbx's eligible Rust build cache. It is
not a measured packaging-speed claim: complete runtime/native assembly still has
a cost, especially cold builds. No payload is relabeled from another source.
The local signer publishes `iteration.json` last, beside the platform's normal
signed envelope and ZIP. The source pin is also signed inside that envelope.
The app copies the ZIP into private same-volume staging and uses the normal
archive, signature, identity/version/platform and native filesystem checks.
macOS source receipts for Rust, updater, native helpers and runtime must all match.
There is no arbitrary executable picker or development signature bypass.

Select `OUTPUT` with **Load local build…**, wait for verification, then explicitly
choose **Reload UI** when ready. Failed verification never authorizes exit or
changes the app. Keep the output immutable while loading it. Build numbers must
remain below the next intended ordinary release; numeric downgrade protection is
not bypassed for iteration.

## Ordinary updates remain independent

Local staging never changes the compiled key, repository, channel, signing policy
or automatic-check preference. After reload and startup acknowledgement, ordinary
**Check for updates** uses the normal verified release path. Externally managed
sessions may install an app-only normal update and reconnect to the same pinned
Local identity. They do not gain daemon authority. A release must preserve the
existing publisher/configuration contract; the local source pin is not a new feed.

No live installation, actual app/daemon restart, release publication, production
key/feed change or real-profile mutation is part of implementation verification.
