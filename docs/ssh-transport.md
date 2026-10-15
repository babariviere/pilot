# Managed SSH transport

`apps/macos/Sources/PilotCore/SSHTunnel.swift` is transport infrastructure, not remote setup or host
routing. It does not change the local daemon connection or expose a remote feature in the UI.

## Ownership and integration

- Keep one `ManagedSSHTunnel` per configured connection. Independent objects can connect concurrently;
  no global endpoint or Local/Remote switch is introduced. Repeated `connect()` calls on one object
  coalesce. A cancelled caller stops waiting, not another caller's connection.
- Persist `SSHConnectionConfiguration` (SSH alias and remote loopback daemon port, default 4319) with
  the host's own identity. Accepted aliases are 1–255 ASCII letters/digits/dots/underscores/hyphens,
  beginning with a letter or digit. This is an alias, not an SSH URL, username, command or option list.
  Configuration decoding validates the same constraints; it contains no credentials.
- Supply the required synchronous `validateHello` closure. Decode the daemon's `DaemonHello`, check
  protocol compatibility, required capabilities and the pinned persistent `daemonId`. First identity
  binding and persistence belong to host setup/routing, not this transport. A validator error is
  terminal and deliberately sanitized. Do not pass a no-op validator in production.
- `connect()` returns a loopback HTTP base URL only after a successful, validated **GET /api/hello**.
  The endpoint and schema were coordinated with the headless runtime implementation. The probe uses
  an ephemeral session without proxies, redirects, cookies, credential storage or caching. Response
  data is capped at 64 KiB, with per-request and overall resource deadlines.
- Consume `states()` for latest-only availability updates. A loss of connectivity is not an agent
  failure/stop. On a drop, discard clients/sockets for the previous endpoint; reconnect can allocate a
  different local port. Never blindly replay mutations. Identity/routing, durable delivery receipts,
  shared-context/delegation reconciliation and offline caches are separate layers.
- Await `disconnect()` on host removal/app quit. It closes only this object's local SSH process and
  waits for reaping, with TERM then KILL escalation. Repeated disconnects are safe; a subsequent
  explicit connect starts fresh. Releasing the object also schedules cleanup, but is not a substitute
  for awaited shutdown. Abrupt app termination cannot guarantee asynchronous cleanup; app lifecycle
  integration should await disconnect on ordinary quit. No SSH control-exit, remote shutdown, pause,
  service management or agent command is ever issued.

## SSH safety and failure policy

The executable is the system `/usr/bin/ssh`. Arguments are passed directly to `Process`, never through
an app-constructed shell. Existing SSH configuration, authentication agent, ProxyJump/ProxyCommand and
known-hosts files remain OpenSSH's responsibility. Trusted SSH configuration can itself run commands
(for example `Match exec`/`ProxyCommand`); this is not a new credential or access mechanism.

The owned foreground master uses `-N -T`, followed by an acknowledged
`-O forward -L 127.0.0.1:<allocated>:127.0.0.1:<remote-port>` request. It requires existing host trust
(`StrictHostKeyChecking=yes`) and non-interactive working authentication (`BatchMode=yes`, askpass
disabled). Unknown/changed keys or authentication requiring interaction must be resolved outside the
app. No automatic trust acceptance or key/password copying/storage is provided.

User multiplex reuse, persistence, background forking, local/remote commands, agent/X11/device
forwarding and wildcard local binding are disabled. The master overrides `ControlMaster`/`ControlPath`
with its own socket in an atomically created private 0700 directory. `ClearAllForwardings=yes` disables
all configured forwards. A separate, transient control client adds only the required `-L` after
authentication. **Only that control client** uses `-F /dev/null`, so it cannot import additional alias
forwards; the authenticated master retains normal host/authentication/ProxyJump configuration. `-O`
fails closed when the owned socket is missing and does not fall back to a new network connection.
Neither command uses a user-owned control socket or sends a control-exit request.

Port allocation binds IPv4 loopback with port zero, reads the chosen port and releases the temporary
socket. OpenSSH cannot inherit it. The control client's successful forwarding acknowledgment proves
that this master bound the requested listener **before** the first hello probe. A conflicting existing
HTTP service cannot win the startup race and be mistaken for the new endpoint, even on first identity
binding. Forward failure triggers fresh-port retry. Both commands' stdout/stderr are discarded, never
captured, logged or persisted. Public errors are small typed categories, not sensitive SSH diagnostics.

There are at most **three attempts total**, including reconnects after a successful handshake, with
1 s/2 s retry delays. Each authenticated forwarding and hello-readiness stage has a 15 s budget.
SSH itself uses one connect attempt, a 10 s connect timeout and 15 s server-alive probes with two missed responses. Established
connections use process termination notifications, not HTTP polling. Exhaustion requires explicit
reconnect. Invalid configuration, launch failure and rejected hello do not retry automatically.
Closing during startup/backoff cancels retry and fences stale completions.

On cleanup, cancel/reap any transient control client, then terminate/reap the owned master and remove
only its private control directory. No listener/socket is retained for a later connection attempt.

All disconnect signals target the exact owned local child, not a PID from remote data, a process name,
a shared multiplex master or a process group. Existing SSH connections and independent remote work are
not stopped. Runtime setup/updates must use their own explicitly authorized operations; they are not
side effects of connecting or disconnecting.

## Verification

`apps/macos/Tests/PilotCoreTests/SSHTunnelTests.swift` runs real fake-SSH processes and loopback HTTP
fixtures. It covers argument/configuration safety, concurrent connections/callers, unrelated work
survival, TERM-resistant child reaping, dropped connections and finite retry budgets, port collision,
allocation/launch failure, cancellation, disconnect during startup/backoff, owner release, bounded
hello responses, redirects, startup/control/HTTP hangs, discarded noisy diagnostics, private socket
cleanup and rejected hello validation. It needs Python 3, already used by the macOS verification scripts.
No SSH host, credentials, remote service or provider is used by these tests.
The process-fixture suite is serialized to avoid multiplying child startup load in the full native
suite. Individual cases still connect multiple tunnels/callers concurrently. Normal startup uses the
production-sized deadline; deliberate timeout cases assert that the intended failure stage was reached.

Local verification can use `xcrun swiftc -parse`, PilotCore-only typechecking, and an interpreted focused
test runner. Do not run local Swift build/test/bundle scripts or the full Node suite for this change.
The normal macOS CI unit-test job must run these Swift Testing tests on the supported SDK. Host routing
and lifecycle integration still need end-to-end validation when those layers are implemented.
