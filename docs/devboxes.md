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
