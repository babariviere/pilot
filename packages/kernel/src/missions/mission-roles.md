# Mission roles and explorer admission

This additive backend contract applies only to missions created with `planningVersion: 1`.
Existing missions are not adopted. No live migration, UI, review engine, approval/merge automation,
completion activation or workspace retirement is part of this slice.

- `coordinator` is derived from the mission's trusted coordinator session identity, never a requested worker role.
- `start.role` accepts `explorer`, `builder` or `reviewer`; omission preserves builder behavior.
  Only the current coordinator's worker IPC, or the existing trusted user/API path, admits members.
  Admission rechecks the coordinator after asynchronous preparation, before the first worker turn.
- Roles persist on membership, survive store reopen and session continuation, and appear in kernel context
  and the session's additive `missionRole` summary. Roles cannot change in place.
  Historical opted-in rows without a role read as builders. Legacy missions remain unlabelled.
- Explorer starts select the existing immutable Ask runtime. Explicit Build mode is refused.
  An existing chat can join as explorer only if it is already Ask. A mismatched task holder is refused,
  never silently resumed with broader tools. Explorer startup without Ask context fails closed.
  Explorers cannot be promoted into coordinators; start a separate coordinator chat instead.
- Explorer tools reuse Ask's rooted `read`, `find`, `grep`, `ls`, supported bundled `web`, codemode,
  session-local artifacts and sandboxed previews. No bash, write/edit, arbitrary extensions, MCP,
  jobs or subagents. Existing source containment, trust, cancellation and artifact boundaries apply.
  Repository fetches cloned outside the source are not readable; use specific raw file URLs.
- Findings, sources and limitations use `mission log`; actionable proposals/escalation use `comment`
  directed to the coordinator; session-local artifact proposals use `attach`. Existing coordinator/user
  planning ownership remains enforced in the daemon. Research can start at brief revision zero when
  explicitly coordinator-authorized. There is no research budget or inferred approval mechanism.
- Keep `ask_user` and ordinary Ask/Stop semantics unchanged. Reliable escalation/human takeover is later work.
  Reviewer is responsibility metadata only, with existing permissions, not an independent-review engine
  or an enforced read-only profile. Builder behavior is unchanged.

These are supported-path tool boundaries, not hostile-agent isolation. Full-access Build shells and
unauthenticated loopback REST remain outside this boundary. Do not fall back to unrestricted bash,
invent command-string allowlists or claim a new sandbox/auth system. Report unavailable capabilities.
