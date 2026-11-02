# Local MCP connections

**Settings → MCP connections** shows the existing Local daemon's global Pi
roster and lets the user act on it through the daemon's own routes. Rows show the
last reported check, not a continuously connected MCP client or a promise that a
chat can use the server. Each row is the exact server name, its reported state,
the latest reported browser sign-in and at most one action beside it:

| Reported | Row action |
| --- | --- |
| Sign-in waiting | **Cancel sign-in**, bound to the observed `startedAt` |
| Needs sign-in, browser sign-in available | **Sign in** |
| Needs sign-in, no browser sign-in | none; the state says to use `pi mcp login` |
| Connection failed | **Check again** (this server) |

**Details** keeps the exact transport, check timestamp, tool count, browser
sign-in availability and latest sign-in (including an old failure). Account
identity is not in this contract, so it is explicitly not reported. **Sign in
again** (replace a working sign-in) is an explicit choice inside Details of a
connected row that supports browser sign-in. The header has **Check now** (ask
the daemon to connect to every server) and **Refresh** (only re-read its report).
Literal Unicode text remains selectable and copyable; every action is a Kit
button reachable with Tab and Enter.

## Contract audit

- `GET /api/mcp` returns `McpStatusService.status()`, a copy of in-memory
  observations plus sign-in progress. It starts no probe, login, provider
  request, config or credential read/write. The control WebSocket sends the same
  object as `{type:"mcp"}` on connect and on every change.
- `POST /api/mcp/check {server?}` starts (or merges into) one worker check and
  returns the status at once with `checking`. Checks can launch stdio servers and
  refresh credentials inside the daemon's worker. Results arrive as `mcp` updates.
- `POST /api/mcp/servers/:name/sign-in {again}` runs pi's browser OAuth flow in
  the daemon (`SourceSignIns`): it opens the browser and stores credentials there.
  A waiting sign-in is returned rather than duplicated. 409 means the server has
  no browser sign-in, 404 that it is not reported. `again` replaces a working
  sign-in. A finished sign-in triggers the daemon's own recheck of that server.
- `DELETE` on the same route with `{expectedStartedAt}` cancels only that exact
  waiting sign-in (409 when it changed) and returns its state or `null`.
- Historical Swift `HostMcpActions`/`ConnectionSettings` use the same three
  Local routes. Remote-host routing, the devbox CLI sheet and setup/config
  editing are not adopted. No backend change was needed.

## Scope, fences and truthfulness

One retained page owns captured Local options, including daemon/lineage and port.
Every read and action checks the existing hello identity before and after the
request: a different daemon before sending means nothing is sent; after sending,
the action is unconfirmed. This is loopback identity pinning, not authentication.
The server name is one percent-encoded path segment, so the daemon decodes the
exact name. Redirects/retries/proxies and authentication fallback are disabled.

Opening the category or pressing Refresh reads once. While the category is open,
the existing control-stream `mcp` updates (already delivered to the app, parsed
off the UI thread) replace the shown report; there is no polling. A report that
arrived before opening is never adopted later. A newer report invalidates a read
in flight. Last-read time is distinct from each server's last-check time.

Actions run only from a click or keypress, one at a time, never on open or
navigation. Results are applied as reported: a sign-in ACK updates only that
exact row and never overwrites a newer reported sign-in. **Signed in** comes only
from the daemon's `done` sign-in, never from a connected roster. Failure shows the
daemon's sanitized reason; a later working connection moves it into Details.
Refusals say what is known. A lost or malformed answer is shown as unconfirmed,
followed by one passive re-read; the request is never repeated. A refused cancel
re-reads too. Leaving the category or closing Settings drops reads and ignores
late action replies; it does not cancel a daemon sign-in, and reopening only reads.

Errors keep this same daemon scope's prior successful report, explicitly stale,
with the original read time. First-read unavailable, refusal, offline, malformed,
loading and empty are distinct. An empty roster means no servers were reported,
not that none are configured. The service can keep old observations after a
failed probe and has no completed-scan revision, so the UI cannot infer
latest-probe success. The native parser validates the whole roster (unique exact
names, the existing 64-entry probe limit, safe integer fields including sign-in
times) and keeps no partial adoption, within the 2 MiB small-snapshot budget.

## Verification scope

`mcp_status_tests` exercises parsing, row actions and sign-in wording, ACK
merging, push/read ordering, exact routes/bodies/decoded names, refusals,
lost ACKs without replay, identity changes before/after a request, offline,
redirects, budgets and cancellation, against owned faux daemons only.
`server-mcp.test.ts` covers the daemon routes with an injected probe/login.
`mcp_status` mounts real Settings and Kit controls in hidden 680/1100 light/dark
windows against a faux Local: keyboard Sign in, waiting, leaving without cancel,
exact and refused cancellation, reported completion/failure, Sign in again,
lost ACK, changed daemon, Check now, stale/empty states, literal selection/copy
and teardown. These are synthetic checks, not live MCP/browser/account checks,
OS IME/AX qualification or proof of a production connection.

Setup/config editing, remote hosts and chat-level MCP attention actions remain
separate scope.
