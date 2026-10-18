# Work on a devbox

Local and remote chats live in the same app. Each chat keeps its own execution host, paths,
repositories, files and artifacts. Selecting a devbox for a new chat does not move an existing chat
or switch the entire app to another server.

## Before setup

- Use a dedicated personal **Linux x86-64** machine. Compatibility is checked from capabilities,
  runtime ABIs, user-service readiness and sandbox support, not a distribution/release name.
- Configure a normal SSH alias outside Pilot and verify `ssh personal-box` works. Pilot uses the
  system OpenSSH client, its authentication and host-key checks. It has no cloud login, SSH key
  manager, SSM integration or reverse-forwarding requirement.
- Install an app release containing a trusted Linux runtime signing key and complete, compatible
  signed assets. Setup never falls back to an unsigned download or source install.
- Keep pilotd on remote loopback. The SSH forward is private transport, not permission to expose
  its unauthenticated API publicly. Shared/untrusted multi-user machines are outside this version.

## Add and use a devbox

1. Open **Settings → Devboxes → Add devbox…**, enter the working alias and authorize setup on your
   dedicated machine. Pilot downloads and verifies its compatible package, transfers it over SSH,
   checks prerequisites, and installs/enables its own persistent user service.
2. Review and confirm the installation/history identity before saving the connection. Reconnects
   must match that identity. A cloned or replaced data home needs investigation, not automatic repair.
3. Select the devbox in Settings and use its **Providers** helpers. Sign in independently on that
   machine, without needing a model chat first. Device/manual flows and unsupported integrations
   are reported explicitly. No Mac tokens, raw integration stores or trust settings are copied.
4. In the new-chat composer choose **Local** or the devbox, then a repository on that host. The
   remote folder chooser browses that host's allowed roots. Its paths are not Mac folders.
5. Use the usual chat, Changes, file viewer, workspace terminal and artifact inspector. Pasted local
   images are uploaded to the selected host. Artifact previews and downloads use that host's saved
   revision. Linux can create HTML, React and images; SwiftUI rendering still requires macOS.

An unsent draft keeps its destination when you return Home. Starting from a mission inherits the
mission's host. Shared task placement is a separate, explicit operation, not a way to move a running chat.

## Host-local model scope API

Native settings/sync clients can read `GET /api/model-scope?cwd=…` (or `?projectId=…`,
with the same host-local path/project rules as `/api/models`). The `ModelScope` response includes
global `enabledModels`, its `contentHash`, read-only `projectOverride`, `resolution` for global
patterns, `projectResolution` for project patterns, and `writable`. `null` global scope means the
key is absent and all authenticated models are available; `[]` also means all, matching Pi.
`projectOverride: null` means no override. An empty project array overrides the global scope with all.

Each `ModelScopePatternResolution` preserves its input `pattern`, with `matchedModelIds` as
`provider/modelId`, Pi diagnostic codes, and nullable `unresolvedReason`: `unknown` or
`provider-not-logged-in` (known model, unavailable on this host, not proof of invalid credentials).
No model objects, provider errors, credential fields or unrelated settings are returned.

`PUT /api/model-scope` accepts `ModelScopeUpdateRequest`:
`{ "enabledModels": ["provider/model:high", "other/*"], "expectedHash": "…" }`.
It requires the existing native host-action capability in `x-pilot-github-capability` (historical
name), read from `github-app-capability` over the verified SSH/local-filesystem channel already
used for setup/import. Never expose that capability to chats or infer consent from a message.
Loopback access alone is not write authorization. This endpoint is not an agent/pilot tool.

The hash is lowercase SHA-256 of compact `JSON.stringify(enabledModels)`, including array order,
not of the whole file. At most 256 non-empty patterns of 512 UTF-16 code units each are accepted
(no control characters; request body limit 160 KiB). Patterns remain verbatim, even when unresolved.
A successful PUT returns `ModelScope`. HTTP 409 returns `ModelScopeConflict`:
`{ "currentHash": "…", "current": ["externally-edited/pattern"] }` (or `current: null`).
Re-read/reconcile a conflict; do not blindly overwrite Pi's `/scoped-models` edits. Other errors use
`{ "error": "…" }`; an uncertain/lost response also requires re-reading before retrying.

Only the global `enabledModels` member in the host's Pi agent-directory `settings.json` changes,
under Pi's own lock with an atomic replacement. `null` removes that member. Other members' bytes,
including formatting/BOM, remain intact; project settings are never written. `/api/models` reads
the new scope without changing running chats' models. Read-only hosts (`PILOT_MODEL_SCOPE_READ_ONLY=1`)
deny PUT with 403; missing native authorization support returns 503. Malformed settings are not
overwritten. This is only the per-host API; it does not implement a model-selection UI or sync fan-out.

## Machine information

Select a saved devbox in **Settings → Devboxes** to see its Machine section. It checks on connection
while visible, or when you choose **Refresh**. There is no continuous monitoring service. The check
only reads information through the verified daemon connection, never installs packages, runs setup,
copies credentials or makes privileged changes.

The section shows OS, kernel, architecture, CPU model, online logical CPU count (not physical cores
or container CPU quota), total machine memory and runtime data volume capacity/available space.
Project and nested workspace mounts may have different disk space. Unsupported, denied or missing
fields say **Unavailable**. Older runtimes without this endpoint report that the check was unavailable.

**Running at last check** means the daemon responded, not that all agents are working. Service-manager
state is **Unknown**, because it is not inspected; a responding daemon alone cannot establish it.
Last-known values are marked **Stale** after disconnection, a failed check, a connection replacement,
or five minutes without another check. They remain in memory while the app is open; relaunch starts
unchecked. Neither a failed check nor disconnection means the machine, service or agents stopped.

## Connect a devbox to GitHub

In **Settings → Devboxes**, select a connected devbox and use **GitHub → Check access**.
Existing host-local GitHub CLI credentials are verified, not replaced. If there is no GitHub.com
login, **Connect GitHub** shows GitHub's device page and a temporary code for your Mac browser.
Authorization exchanges and the resulting token remain on the devbox. The requested scopes are
GitHub CLI's standard `repo read:org gist` plus public-key read/write. A separate native confirmation
is required before registering the dedicated key, even after browser authorization.

Choose **Generate key**, review the displayed account, public key and SHA-256 fingerprint, then
approve registration. The key is generated under the devbox's private Pilot data directory, not
copied from the Mac. No agent forwarding, existing-key replacement, SSH config edits or global Git
configuration changes are used. Existing checkouts are not reconfigured. The verified dedicated key
is used by a GitHub-only SSH wrapper for new daemon/agent processes. Other Git servers pass through
unchanged, explicit `GIT_SSH`/`GIT_SSH_COMMAND` overrides are respected, and existing shells/agents
are not reconfigured. Commands launched outside Pilot do not automatically discover this key.
CLI/API and SSH readiness are separate, and neither
guarantees write access to every repository or approval by an organization's SSO policy.

Install missing `gh`, `git`, OpenSSH or `ssh-keygen` independently. Pilot never runs sudo or installs
privileged packages for this flow. Normal SSH host-key checks apply. If GitHub is not yet trusted on
the devbox, establish that trust independently after verifying its published fingerprint, then check
access again. A revoked/expired existing CLI login must be repaired independently, not silently
overwritten. GitHub Enterprise and remote browser callbacks are not supported by this helper.

Closing the screen or losing the Mac connection does not cancel remote authorization. Reconnect
the **same saved devbox**, refresh state and explicitly cancel if needed. Cancellation is acknowledged
only after host work settles. An interrupted exchange is never replayed. Key-upload completion can
be unknown; **Check access** reconciles the exact public key against a bounded GitHub inventory
before another explicit approval. A daemon restart loses temporary device challenges and requires
fresh authorization, not automatic resubmission. No GitHub token, private key, device code or raw
command diagnostic enters chat history, operation journals or the app's offline cache.

**Revoke key** confirms and removes only the displayed dedicated key from the displayed account.
It leaves private material on the devbox and does not remove other SSH keys or revoke the CLI token.
Manage/revoke that token separately in GitHub's application settings. Recheck access after revocation.
Setup/import endpoints require a separate, host-identity-bound native-action capability read over
verified system SSH (or the local user's filesystem for Local). It is not a GitHub credential and
is never exposed to agent tools, queued inputs or permission grants inferred from chat messages.
As with existing SSH setup, this assumes a dedicated personal host, not hostile same-user processes.

## Import a GitHub project onto a host

Use **File → Import GitHub Project**, the sidebar's project menu, or **Import from GitHub** in a
devbox's repository chooser. Select **Local** or a saved devbox. The destination, clone, independent
GitHub login and resulting project all belong to that host. The existing **Add Project** local-folder
workflow is unchanged. A local project's **Set up on devbox** action resolves its GitHub remote URL
and preselects a saved devbox. It does not copy local files, uncommitted changes or unpushed commits.

**Load repositories** lists up to 300 recently updated accessible GitHub.com repositories. Search
filters that bounded inventory; paste a credential-free HTTPS or `git@github.com:owner/repo.git` URL
for others. If access is missing, **Connect GitHub** opens the same independent host setup helper.
Both CLI/API and dedicated SSH identity are checked before cloning, with a live repository-access
probe. Repository-specific push, PR and organization SSO permissions still apply.

The reusable destination pattern defaults to **`~/src/{host}/{owner}/{repo}`**, for example
`~/src/github.com/babariviere/pilot`. `{host}` is the **Git server hostname**, not the execution
devbox name. `~` is resolved only on the selected execution host. Edit the destination or choose a
parent folder on that host, then **Check destination** to review its fully resolved path before
**Clone and add project** is enabled. Changing the URL or destination invalidates that preview.
Substituted components are validated, with no shell/environment expansion, traversal or symlink
parents. Missing parent folders are created privately at execution time, not during preview.
This naming policy does not add non-GitHub authorization or GitHub Enterprise support.

Clone reserves a new directory exclusively and never replaces even an empty unrelated destination.
A matching existing standalone checkout is only registered after **Review existing checkout** and
explicit **Use this checkout** confirmation. Its directory identity, HEAD and credential-free origin
are checked again. Worktrees with redirected `.git` files, symlinked destinations and unrelated
origins fail closed. Reuse does not reset files, change authentication/configuration, fetch or run setup.

Fresh clones disable hooks and inherited Git checkout filters, use empty templates, and do not
initialize submodules or execute repository setup/configuration. Adding/opening the project does
not grant project trust or link/share memory, tasks or other context. Those retain their own
existing confirmation flows.

Host-owned import records survive app disconnection/relaunch and daemon restart. Refresh on the
same saved host before acting on an uncertain start. **Retry original start** uses only its original
operation ID, URL and resolved destination, never a newer draft or Local. Registration is reconciled
against the existing host project, so a lost response does not create a second project. A restart
requires an explicit resume, not automatic clone replay. An interrupted nonempty checkout is kept
for inspection and explicit reuse, not force-checked-out again. Cancellation is only confirmed after
the child process exits; partial directories remain for inspection, never silently deleted.
At most two imports run concurrently, commands/output are bounded, and active imports block a
runtime update until clone, registration and journal writes settle.

## Connection loss, sleep and quit

**Disconnected** describes availability, not the agent's outcome. Known remote chats, drafts and
last-known summaries remain visible after an offline app relaunch. They may still be running.
Uncached conversation history explicitly requires reconnection; complete persistent offline
transcripts are not guaranteed.

Reconnect from the chat notice or Settings → Devboxes. The app verifies the saved identity and
refreshes that host's state without changing Local or another devbox. Mac sleep controls apply
only to Local. Normal app quit closes owned SSH forwards, not remote services or agents.

New remote sends require a connection. A reply lost after submission can mean **Delivery unknown**.
Keep the draft, reconnect and check the original receipt. Only an explicit retry sends the same
saved request to its original host; changing a draft does not change that request. Do not manually
create a replacement chat to work around an uncertain start. A terminal disconnect detaches its
display; explicitly close its shell when you want the shell to stop.

## Share context and delegate a task

Open the project's Settings → Sharing. Confirm the execution project, the project that owns the
notes, the devbox that owns missions, and the selected sharing scope. Equal names or paths never
link projects automatically. If only some peers confirm, finish the same saved link after reconnect.
Project files, credentials, executable configuration and permission approvals are not shared.

- **Saved here** is committed context from its canonical home or a durable local replica.
- **Pending sharing** is a durable provisional contribution. It is useful on its originating
  devbox but is not globally binding until accepted at the home.
- **Conflicting edits** remain separate for review at the canonical home. Revision checks and
  deletion tombstones prevent old edits or late results from resurrecting deleted work.

Review the bounded task, target model, required pinned artifacts and online-only references before
confirming placement. An accepted task can continue on its last committed context and labelled
pending contributions while disconnected, until it needs new input, scope or permission. There is
one durable execution grant, no timeout-based failover, and one coordinator pinned to the mission
home. A replica cannot canonically claim siblings or elect another coordinator.

**Stop requested** is not **Stopped**. Reassignment waits for the previous target's durable release
and the home's import of that acknowledgment, not an idle snapshot, disconnect or elapsed time.
Revocation blocks future sync and grants. It cannot instantly stop an unreachable machine or erase
its offline copies. Late factual evidence is retained even when work was cancelled or deleted.

## Update safely

Select a reachable devbox in Settings and use its Runtime updates section. The request is saved
before dispatch and continues under an independent remote update owner, even after disconnect or
app quit. Check the saved request rather than starting another when its result is unknown.

The update waits for live jobs, workspace shells, transfers and uncertain cleanup. Open the listed
chat, let work finish, or explicitly stop/close it. A Stop reply or closed socket alone is not proof
that a process exited. Cancellation also needs remote confirmation. Saved agent/subagent records
can resume, but live OS processes and terminal shells are not resurrected by those records.

## Troubleshooting

| What you see | What to check |
| --- | --- |
| SSH cannot connect | Verify the alias, authentication, host trust and network outside Pilot. Do not disable host-key checking. |
| No trusted signing key or complete assets | Install a correctly configured compatible app release. Do not bypass signature, size, hash, version or protocol checks. |
| Prerequisite plan | Review the detected package-manager plan outside the app. `dnf` is supported when present. Package installs and `loginctl enable-linger` require separate administrator approval; setup never runs sudo automatically. |
| Service reachable, isolation unavailable | Review bubblewrap and namespaces under the actual service user's security policy. Do not disable global host security. |
| Provider missing or reauthentication required | Use that devbox's provider helper. An unavailable/busy credential broker is an error, not permission to edit auth files or copy credentials. Same-host consumers share serialized canonical refresh; ambiguous exchanges are not blindly replayed. |
| Identity/protocol mismatch | Check the saved SSH alias and installation/history pin. Do not replace it with the first responding daemon. |
| Update waiting or uncertain | Check its saved status and blockers. Keep the original package/request identity; do not restart the service manually to bypass its drain. |
| Shared task remains occupied | Reconnect the owning target and check release. Connection loss does not permit replacement execution. |

For service diagnosis, inspect `systemctl --user status pilotd.service` and
`journalctl --user -u pilotd.service` **on the devbox as its service user**. Do not paste credentials,
raw environments, auth journals or unredacted SSH diagnostics into reports.

See [SSH setup](ssh-bootstrap.md), [Linux runtime/service requirements](../scripts/linux/README.md),
[safe updates](safe-remote-updates.md), [workspace terminals](workspace-terminals.md),
[shared-context contract](shared-context.md) and [verification matrix](devbox-verification.md).
