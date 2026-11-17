# Databases

Choose a project in Today, then open **Settings → Databases**. Add an environment and its read or write
connection. Saving settings does not connect. **Test read connection** and **Test write connection** only
authenticate and disconnect. They run no SQL and do not test permission to change data.

Day edits the destination without displaying credentials. Existing credentials and advanced certificate options
stay in the host's owner-only `database.json` when the destination is unchanged. Configure passwords and
advanced options in that file. Changing a destination replaces its URL, including any credentials in that URL.
Review advanced certificate settings in `database.json` before testing a different host. Settings are host-local,
not replicated.

Eligible work agents ask for access in **Today → Needs you**. The request names the agent, environment,
read/write mode, destination and model provider. Query results enter that agent's context and may be sent to
that provider. Approve each mode separately. Planning agents, Ask chats and internal helpers cannot use it.

Approvals survive restarts until revoked or archived. A different agent, destination or provider needs fresh
approval. **Revoke access** in Settings blocks new queries. Sent queries may finish, including writes; approval
is not a database rollback. Old unscoped grants and the legacy `access: "allow"` setting do not bypass approval.

Verified TLS is the default. A local or legacy endpoint needs an explicitly named **No TLS** or **Unverified TLS**
exception. The exception and warning stay visible in settings and approval requests. Prefer a trusted CA instead
of weakening TLS. Credentials and certificates are never returned in settings responses.

Queries keep their existing limits: 100 rows by default, at most 1,000, 256 KiB of results, 30-second statements,
a five-second lock timeout and a 50-second call deadline. Truncated results are marked. Use database roles that
also enforce the intended read/write access. Read queries use read-only transactions.

A failed or interrupted write may have committed. The agent must investigate with approved reads, and retry
only with safe evidence and still-current write approval. Pilot does not automatically replay it. An uncertain
settings or approval action offers **Check status**, which only reads the original receipt.

These are cooperating-agent controls, not an OS sandbox: trusted local shells can still access files and the
loopback API. Keep the database settings protected by your filesystem and sandbox policy.
