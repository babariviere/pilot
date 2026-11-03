# Independent host credential setup

The daemon's setup API and host-qualified Swift helpers are available before any project, chat or
authenticated model exists. The onboarding UI consumes these helpers separately. Nothing copies
the Mac's stored credentials, environment secrets or executable configuration to another host.

## Calling contract

- `GET /api/setup` returns the host's built-in provider inventory, audited headless methods and
  canonical stored-auth metadata. `configured` is **not** a live provider acceptance check. Ambient
  credentials, commands and `models.json` authentication are not evaluated. `reauthentication_required`
  identifies fenced/uncertain canonical state, not an invented network diagnosis.
- `POST /api/setup/runs` accepts only `{provider, method}`. Supported methods are Pi 1.1.0's
  `openai-codex/device_code` and `anthropic/manual_code` (the SDK's `copy_code` selection).
  Other providers/methods explicitly report unsupported. These fixed SDK paths do not load personal
  extensions, repository settings, executable auth commands or arbitrary configuration. The bundled
  Anthropic transport extension delegates OAuth login/refresh to this same built-in implementation.
- `GET /api/setup/runs` and `GET /api/setup/runs/:id` return bounded non-secret run metadata. If a
  start reply is lost, inspect existing runs on the **same verified host**, never blindly repeat it.
- `/api/setup/runs/:id/terminal/ws` explicitly attaches to the existing host-owned PTY. The PTY runs
  only the trusted setup helper, never a login/admin shell. The socket carries `setup.state`, the
  current private `setup.challenge`, and fixed errors. Raw PTY output is parsed, bounded and discarded,
  never forwarded or replayed. Disconnecting an attachment does not cancel or restart the helper.
- A manual answer is one `setup.answer` containing the current `challengeId` and complete `code#state`.
  Input is hidden (raw PTY mode before challenges), single-use and state-validated. Authorization URLs
  are restricted to audited origin/path and complete fixed parameters, including duplicate-key rejection.
  Device user codes and manual authorization URLs are transient challenges, not stored-auth exports.
  Do not log, cache or persist challenges or answers. Open the explicit challenge in the user's browser;
  there is no generic localhost callback relay.
- `DELETE /api/setup/runs/:id` revokes the per-run, provider-scoped broker capability and durably fences
  its claimed login generation before acknowledging cancellation. An older cancellation cannot fence
  a newer external explicit login/logout generation. If commit persistence won the journal lock first,
  cancellation subsequently quarantines that generation. Failed or lost exchanges are never retried
  automatically. The result reports whether current auth is fenced/pending; recheck readiness before
  attempting another explicit sign-in. Cancellation does not imply provider-side grant revocation.
- `DELETE /api/setup/providers/:provider/credential` removes canonical stored auth with the broker's
  generation-fenced logout. It does not unset environment variables, edit `models.json`, or revoke an
  account's grant at the provider.

Fixed Linear/Slack integration helpers report the existing same-host global MCP status, using exactly
the dedicated source names `linear` and `slack`. Configure each host's global pi MCP configuration
independently. Setup integration sign-in explicitly reports unsupported: the existing MCP sign-in
worker requires a browser callback, which is not generally reachable from another machine's browser.
Existing local Connections sign-in remains unchanged. There is no arbitrary config/file/path endpoint.

## Client, resource and update boundaries

`HostClients.setupReadiness/startSetup/setupRuns/cancelSetup/logoutSetupProvider/attachSetup` require
an explicit verified `HostRef` or `HostedSetupRun`. They never fall back to Local, use the global Local
client, persist credential inputs in the operation outbox, or automatically retry a login/answer.
Endpoint/socket generations fence late replies. Private attachments close on host removal,
replacement/disconnect or owner cleanup; callers reattach explicitly after reconnection.

At most two helpers run concurrently, each for at most five minutes. Each helper has one challenge,
at most 16 KiB **cumulative lifetime** native input enqueue and 64 KiB cumulative output. Caps never
reset on reconnect/drain. This is important because node-pty 1.1.0 does not expose native input drain
accounting: a frame/rate limit alone would not bound its internal queue. A whole accepted manual
answer is additionally limited to 4 KiB. There are at most 32 retained runs and four attachments per
run; attached runs are not evicted to bypass those bounds. Errors contain fixed text, never SDK/server
bodies, tokens or submitted inputs. Canonical auth stays in the same-host broker.

`SetupService.blockers()`, `freezeAdmissions()` and `onChange()` are the setup contribution to the
runtime updater's admission barrier. Aggregate them with workspace-terminal/job/transfer blockers.
Cancelled/retiring helpers remain blockers until actual process exit and cancellation-fence settlement.
No process/PTY resurrection is promised after daemon restart. Helpers are terminated on orderly daemon
shutdown; uncertainty survives independently in the credential broker journal.

Focused tests exercise the real PTY, pinned SDK with mocked network responses, canonical auth writes,
host separation, HTTP/WebSocket routing, hidden/redacted input/output, process death and cancellation
versus delayed commit/new login/logout. Swift protocol/client tests run in CI. Real provider account
approval and packaged Linux/macOS validation remain separate deployment checks, not fixture claims.
