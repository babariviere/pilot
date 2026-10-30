# Local MCP observations

**Settings → MCP connections** reads the existing Local daemon's global Pi roster.
Rows show the last reported check, not a continuously connected MCP client or a
promise that a chat can use the server. **Refresh** only rereads the report.
**Details** exposes the exact server name, transport, check timestamp and tool
count when reported. Account identity is not in this contract, so it is explicitly
not reported. Literal Unicode text remains selectable and copyable. Tab and Enter
reach the existing Kit controls; no custom navigation or new design system.

## Contract audit

- `packages/daemon/src/server.ts` handles `GET /api/mcp` with `mcp.status()`.
  `McpStatusService.status()` in `mcp-status.ts` copies and sorts its in-memory
  observations and reads existing sign-in progress. Neither method starts a probe,
  connection, login, provider request, config read or credential read/write.
  The initial control WebSocket `mcp` event uses this same passive method.
- Independently, the daemon calls `start()` at startup, watches `mcp.json` and
  `mcp-auth.json`, and exposes explicit check/sign-in actions. Those paths can
  start worker connections, refresh credentials and launch stdio servers.
  `mcp-status-worker.ts` closes probe connections before reporting. Hence
  **Reported connected**, not a claim that the probe connection is still open.
  This page never calls those action routes or starts/subscribes to the worker.
- `packages/protocol/src/mcp.ts` supplies the safe metadata contract. Problems
  are fixed sanitized sentences, not server output. The worker reports at most
  64 global entries, with up to four probe connections independently running.
  It can truncate a larger external configuration without a truncation flag;
  the page says "reported", never promises a complete configuration inventory.
- Historical Swift `HostMcpConnections.swift`, `HostMcpRoster.swift`,
  `HostMcpActions.swift` and `PilotCore/Mcp.swift` combine per-host observations
  with check/sign-in actions. Only Local passive observations are adopted here.
  No remote host, browser, CLI fallback, setup/config editor, cancellation,
  reconnect/check/test/sign-in action or GUI credential access is added.

## Scope, freshness and failure

One retained page owns captured Local options, including daemon/lineage and port.
Every status read checks the existing hello identity before and after the GET.
This is loopback identity pinning, not authentication or account verification.
No arbitrary path, URL or namespace is interpolated into a request. The endpoint
is fixed; redirects/retries/proxies and authentication fallback are disabled.

Opening this category or pressing Refresh reads once. There is no polling.
Last-read time is distinct from each server's last-check time. A check-in-progress
flag describes the daemon report only. Missing completed-check timing cannot
produce a connected label; unfamiliar states remain Unknown. An empty roster
means no servers were reported, not that no servers are configured. The service
can preserve old observations after a failed probe and exposes no overall probe
error or completed-scan revision, so the UI cannot infer latest-probe success.

Opening/replacing a read advances the page generation; obsolete I/O is cancelled.
Leaving the category or closing Settings drops its reader and invalidates replies.
Errors keep only this same immutable daemon scope's prior successful report,
explicitly stale, with the original read time. First-read unavailable, refusal,
offline, malformed, loading and empty are distinct. No config/history-derived
connection state or guessed account identity fills a gap.

The native parser validates the whole roster, unique exact names and existing
64-entry probe limit, rejects malformed numeric fields and retains no partial
adoption. The streamed response uses the existing desktop small-snapshot 2 MiB
wire safety budget, including chunked responses. It refuses overflow rather than
silently trimming text or hiding additional rows. This does not add a daemon cap.

## Verification scope

`mcp_status_tests` exercises parsing, Unknown/no-check behavior, exact Unicode,
generation/timestamp retention, owned faux HTTP GET-only paths, refusals,
redirects, malformed/oversized responses, identity changes and cancellation.
`server-mcp.test.ts` asserts that status GET and initial WebSocket observation do
not call the injected probe/login, both before and after a reported roster.
`mcp_status` mounts real Settings and Kit controls in hidden 680/1100 light/dark
windows, using only a faux Local daemon. It covers navigation, loading, keyboard
disclosure, literal selection/copy, retained stale failures and category teardown.
These are synthetic native checks, not live MCP/account checks, OS IME/AX
qualification, performance acceptance or proof of a production connection.

Check/test/reconnect, browser sign-in/auth, setup/config changes and any richer
freshness/account contract remain separate reviewed scope. No backend addition
is required for this passive report reader.
