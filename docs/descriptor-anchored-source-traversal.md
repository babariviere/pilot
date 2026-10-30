# Descriptor-anchored source traversal (design only)

## Scope and decision

Propose a small host-owned read/list/walk boundary, not broader filesystem access.
This document does not implement, qualify or activate it. Existing native tools
still provide **path guardrails**, not atomic ancestor traversal. No runtime
update, new grants, privileged executor, agent start or live adversarial test is
part of this design.

Use existing OS descriptor primitives behind a fixed-operation, unprivileged native
binding in a daemon-owned filesystem worker. Reuse the existing worker/RPC pattern,
not a shell helper. Descriptors and absolute paths remain host-private; the agent
gets bounded data, never a descriptor, directory capability or reusable grant.
There is currently no openat/fdopendir binding in the kernel/daemon packages. A
small compiled binding and its packaged ABI/platform verification are prerequisites,
not an existing supported Pilot capability. Do not substitute path checks while
advertising descriptor support if that prerequisite is missing.

## Grounding and the actual gap

| Existing source | Reuse or limitation |
| --- | --- |
| [`source-reader.ts`](../packages/kernel/src/source-reader.ts), `checkedPath`, `readLocal`, `SourceReader.list/walk/kind` | Component lstat/realpath preflight, final O_NOFOLLOW, bounded regular-file reads and postchecks. `list` uses path-based Node `opendir`; its `Dir` exposes no descriptor identity here. `walk` reopens string paths. These checks miss restored-ancestor ABA. |
| [`coordinator-source-tools.ts`](../packages/kernel/src/coordinator-source-tools.ts), `createCoordinatorSourceTools` | Fresh scope per direct/nested request, configured read checks, source-only metadata denial and explicit docs/skill/image exceptions. Keep these policies above the new boundary. |
| [`sessions.ts`](../packages/daemon/src/sessions.ts), `coordinatorSources`, `source.scope` | Worker-bound identity; durable same-project current membership, canonical owned main/member/scratch roots, second membership observation, bounded admission. Returns strings today, not anchored handles. |
| [`mission-service.ts`](../packages/daemon/src/mission-service.ts), `coordinatorSourceMembers` | Current mission membership, not historical task ownership or a title, defines eligible members. |
| [`ask-tools.ts`](../packages/kernel/src/ask-tools.ts), [`exploration-tools.ts`](../packages/kernel/src/exploration-tools.ts) | Encoders, literal search, tree limits and source-inferred analysis remain consumers, not new authority. |
| [`linux-coordinator.ts`](../packages/daemon/src/linux-coordinator.ts), `validateOrigins` | Existing O_PATH/fdinfo/mountinfo coordinate checks guard writable scratch aliases. They do not provide atomic source traversal or read ownership. |

The motivating controlled directory ABA admitted an unrelated directory between
preflight and `opendir`, then restored the original ancestor before postvalidation.
Unrelated entry names returned. Static symlink/hardlink and persistent-swap tests
do not cover this schedule. Final-file O_NOFOLLOW cannot constrain its ancestors.
This is recorded evidence from the earlier native boundary investigation, not a
new experiment or a claim about all observed reads.

## Contract and admission

1. Keep `source_roots` discovery-only. Each actual tool execution, including a
   nested codemode call, obtains fresh host admission. The host derives actor,
   current worker, mission, project and member from trusted state, awaits existing
   mission durability, and rechecks scope after asynchronous root acquisition.
2. Resolve an explicit eligible root and a relative source path. Reject NUL,
   traversal, absolute/alternate spellings, unsupported names, and case-insensitive
   `.git`/`.jj` components before lookup. Preserve configured denyRead enforcement
   for both direct reads and recursive operations. Never widen a denied query.
   This is the internal descriptor boundary: the tool adapter may still translate
   an approved absolute path from `source_roots` to the selected root plus relative
   path, preserving today's agent-facing path selection without forwarding it raw.
3. An internal request binds that exact root observation and membership observation
   to one finite operation. The host selects paths, never accepts a caller's root,
   mount ID, fd, uid, Git directory or membership assertion. Discovery results do
   not authorize a subsequent call. Transport IDs are correlation, not bearer grants.
4. Open the selected root through held parent descriptors, with no symlink
   traversal, and compare the opened directory's fstat identity with the host's
   expected observation. Hold the root for the operation. Root acquisition starts
   from the daemon's held, host-selected storage anchor; acquire that anchor before
   accepting reads and record its filesystem identity. Trusted deployment aliases
   such as the host's canonical home spelling must be resolved explicitly, not
   silently accepted from a caller. If anchor identity cannot be established,
   return unavailable rather than opening an unchecked absolute root.
5. The linearization point for access is final host admission with acquired handles.
   Removed/moved members, continued coordinators, changing projects/roles and
   replaced worker instances block new admissions. Already admitted finite reads
   may drain, with fixed limits and deadline, without scope refresh or renewal.
   Internal walk steps are part of that single operation, not new grants.
6. A second request or continuation always re-admits. No reusable cursor retains
   live directory handles across calls. A failure returns no pending raw bytes or
   entry names from an unvalidated descriptor.

An anchor acquired from current trusted host configuration proves which directory
was opened, not its historical creator or the origin of files placed inside it.
Existing path metadata alone cannot establish a previously enrolled inode. On
restart, do not claim that an unrecorded old root identity has been recovered.
Storage lifecycle integration must pin/validate the selected instance; a changed
instance requires fresh admission, never silent rebinding of an active request.

### Integration seams to validate before code

Keep `source.scope` as path discovery. Add fixed host read/list/kind requests on
the same current-worker IPC identity, not an endpoint accepting arbitrary commands.
The host owns each finite query's private request context and root descriptors;
kernel-side adapters receive only validated entries/bytes and coverage states.
Inject a reader backend at `SourceReader` consumers for coordinator calls, while
ordinary Ask/pinned readers retain their current backend. `kind` must use a
constrained open/fstat too, not retain its current unchecked path lstat route.

[`exploration-runner.ts`](../packages/kernel/src/exploration-runner.ts) currently
serializes `AskContext` into an exploration worker, where
[`exploration-scan.ts`](../packages/kernel/src/exploration-scan.ts) constructs a
new `SourceReader` and realpaths its root. Replacing only the top-level read tool
would leave code search/symbol/call-path reads on the old boundary. Future wiring
must give that worker a private bounded source-RPC proxy for the **same admitted
finite query**, remove coordinator path opens/realpath from its scan route, and
retain inherited Node permission flags. The proxy binds to its owning tool call,
not a transferable root token. Abort/worker exit closes the proxy and joins host
reads before releasing its admission slot; worker termination alone is not host
I/O cleanup. Revalidate every new query/page, not every internal read as a way to
renew revoked membership. Validate this seam with direct/nested code tools before
claiming that any complete native traversal uses descriptors.

## Platform capability states

Capabilities are separate dimensions, not one `secure: true` flag. Proposed
diagnostics report adapter version, operation support, anchor identity availability,
mount policy, bounded-I/O support and an explicit unavailable reason. Probe under
the actual packaged runtime, service policy and filesystem before enabling anything.

| State | macOS | Linux |
| --- | --- | --- |
| Shipped today | Node path guardrails only | Node path guardrails only; bubblewrap read-only host mounts do not improve read ownership |
| Descriptor operations, candidate | `openat` one component at a time with O_RDONLY/O_DIRECTORY/O_NOFOLLOW/O_CLOEXEC; `fstat`, `fdopendir`, `readdir`, `dirfd`, `closedir`; regular file `pread` | `openat2` from held root for each complete relative lookup; RESOLVE_BENEATH + RESOLVE_NO_SYMLINKS + RESOLVE_NO_MAGICLINKS + RESOLVE_NO_XDEV; readable directory fd → `fdopendir`; `fstat`/`pread` |
| Why plausible, not qualified | Installed SDK declares these POSIX APIs; openat is available since macOS 10.10. O_NOFOLLOW_ANY is present but is not an equivalent of Linux BENEATH/NO_XDEV | openat2 is documented since Linux 5.6; use the syscall with zero-initialized `open_how`, not an assumed libc wrapper. All flags must actually be accepted |
| Rename boundary | Held parent identity is stable. A directory renamed outside the root remains that admitted directory; component stepping does not prove every later object remains a current descendant | BENEATH constrains each lookup against the held root. It does not freeze directory contents or later rename/unlink of already opened objects |
| Mount boundary | fstat dev + fstatfs filesystem identity can reject observed cross-filesystem transitions, not prove absence of same-filesystem aliases/firmlinks or all transient mounts. No general NO_XDEV equivalent is established here | NO_XDEV rejects descendant mount crossings, including same-device bind mounts. The root itself may already be an alias: validate its trusted storage origin separately |
| Strict unsupported state | If the caller requires atomic current-root containment under reparenting, or universal mount-alias exclusion, return unavailable. Do not present descriptor-chain semantics as that stronger guarantee | ENOSYS, policy denial, unsupported flags, unverifiable root origin, unsupported filesystem or unavailable binding means strict mode unavailable. No silent openat/path fallback |

The macOS candidate is useful for exact descriptor enumeration and stable parent
identity, but is **not** a claim to Linux-equivalent hostile-rename containment.
Its weaker semantics must be separately approved/qualified before deployment;
design acceptance does not waive the missing strict capability. An old Linux
component-walk fallback would have the same limitation and is not selected.

Acquire storage anchors using trusted known mount boundaries. NO_XDEV from `/`
would reject legitimate mounted home/storage volumes; do not weaken descendant
checks to work around that. Validate the chosen root's mount identity against
host-owned storage registration. Linux fdinfo/mountinfo may support this check,
but sampling them is not atomic proof against a mount-namespace administrator.
Unverifiable origin is unavailable for a request requiring alias exclusion.

## Operations and concurrent mutation

- **Read.** Open through the admitted root, never a second absolute path. Use
  O_RDONLY/O_NOFOLLOW/O_NONBLOCK/O_CLOEXEC, then fstat; reject non-regular files
  before reading. Compare expected versus opened identity where a directory entry
  or preflight supplied one. Reject nlink != 1 before and after content reads.
  Bound bytes even after growth. Compare descriptor dev/ino, type, size, nlink,
  high-resolution mtime/ctime before/after; reject observed changes. Metadata
  equality does not prove a coherent snapshot or exclude in-place ABA.
- **List.** Open a readable directory descriptor, validate identity, then hand that
  same descriptor to fdopendir. Retain a separate validated duplicate for fstat
  checks if needed; set CLOEXEC on every duplicate. On success closedir owns its
  fd; on fdopendir failure the caller closes it. Never reopen `/dev/fd`, `/proc`
  or the textual directory path. Buffer bounded entries privately before release.
  `d_type`/`d_ino` are hints, not authority; validate child kinds with constrained
  metadata/type-only handles before traversal. Do not open devices just to classify
  them. O_NONBLOCK plus post-open fstat does not prevent a device open under a
  hostile final-type swap; a strict no-device-open claim needs an atomic regular-file
  type gate and is unavailable where that mechanism has not been qualified.
- **Walk/search.** One root and deadline, bounded depth/entries/bytes/fds, no path
  retry that forgets the root. On Linux resolve each queued child from the root
  with full relative path and all flags; compare it to the observed directory
  identity when resuming that directory. Do not extend authority from a reparented
  child fd. On macOS use the explicitly weaker held-parent-chain semantics, or
  refuse strict requests. Close exhausted directories promptly; do not retain one
  fd per queued path. Reject inode/type changes, cycles and alias-policy violations.
- **End checks.** Verify held root/parents and current path-to-handle identities
  where available; a persistent rename/replacement yields changed/unavailable.
  These checks improve freshness reporting, not the isolation guarantee. A
  restored path cannot substitute a different handle already rejected by fstat.
  Never rely on path revalidation to repair an unconstrained open.

Ordinary edits, creates, deletes and renames are expected in a live workspace.
Return an explicit changed/retry or bounded partial-search result for observed
mutation, never an empty success. Do not retry forever or quietly switch to newer
roots. Read results describe an observation, not one atomic workspace revision.
Atomic file replacement with identical bytes is still a different observed object.

Hardlink rejection prevents reading an observed multiply-linked file; it cannot
prove a file was never hardlinked, copied, reflinked, unlinked elsewhere, or
temporarily aliased between checks. List names and source bytes placed within an
eligible tree are not authenticated project provenance. Mount administrators,
same-UID hostile processes, inherited arbitrary descriptors and compromised native
extensions are not isolated by this service.

## Cancellation, limits and diagnostics

Proposed initial limits preserve current tool ceilings: 16 MiB regular file,
10,000 directory/search entries, 32 MiB search input, 50 KiB rendered output.
Add explicit 64-level depth, 32 open descriptors, 30-second request deadline,
one active filesystem operation per worker and at most eight admitted/queued
requests globally; count the queue against the deadline. These are design choices
to validate with large synthetic sessions, not measured performance promises.

Cancellation marks the request terminal, stops queueing opens/reads, discards
unreleased output and joins in-flight work before closing owned descriptors.
Never close an fd from another thread while a syscall uses it, or allow a recycled
fd number to cancel another request. Use explicit ownership/RAII and exactly one
close path. No directory continuation survives abort, deadline, disconnect or
worker shutdown. Do not renew admission after revocation to finish an old walk.

Blocking filesystem syscalls can outlive cooperative cancellation, particularly
on network/FUSE/unhealthy mounts. A thread deadline cannot guarantee their return.
Until a filesystem has bounded-I/O qualification, report finite drain unsupported
and do not advertise this strict capability there. Terminating a JS worker thread
is not proof a native syscall was cancelled. This design introduces no helper
process or privileged executor to conceal that unresolved limit.

Use existing opt-in diagnostic plumbing for request ID, operation, capability
state/version, admission outcome, count/byte/time ceilings, mutation/cancel stage,
close/join outcome and errno category. No raw source, names, user text, host paths
or secrets in routine logs. Emit a specific `descriptor-unavailable`,
`identity-changed`, `mount-unverified`, `limit`, or `cancel-draining` reason, rather
than only a generic rejection. Descriptor identities remain private diagnostic
metadata, not permission tokens. Logs help investigate behavior, not attest safety.

## Preservation and verification gates

Keep Ask's existing live and pinned reader contracts intact. Pinned
`SourceReader.object/tree/read` continue exact commit/tree/blob selection without
live fallback; this proposal neither grants coordinator access to Ask Git stores
nor changes snapshot identity. Docs/advertised-skill/UUID-image exceptions remain
separate exact resource policies, never extra search roots. Scratch writes and
general bash/jobs are unchanged. New strict operation refusal must not retry
through a weaker reader, bash, jobs, shell, or raw Git/jj.

Future implementation tests use owned temporary fixtures and deterministic hooks
at syscall boundaries, never mutation of user/live workspace ancestors:

| Test schedule or boundary | Required assertion |
| --- | --- |
| Other mission/project/session; forged root/worker; direct tool and nested codemode | Denied before opening; no names/bytes; same configured denyRead and override guard |
| Root or parent persistently replaced before/after acquisition | Expected fstat identity mismatch rejects; no auto-rebind |
| Root/parent restored-ancestor ABA around directory open | Enumerate only the validated descriptor or reject. A fixture-only unrelated sentinel name never returns; include empty and multi-entry directories |
| Swap between each lookup, stat, fdopendir, readdir, final validation | No path-based reopen; assert descriptor identity and cleanup at every failure stage |
| Directory reparented outside admitted root during walk | Linux full-root constrained lookup rejects escape/mismatch; macOS strict request is unavailable, not mislabeled pass |
| Final/ancestor symlink, magic link, mixed-case metadata, hardlink creation/removal during read | Reject observed policy violations; document unobservable historical alias/content ABA limits |
| Cross-device and same-device bind aliases; root already mounted alias; macOS same-filesystem alias | Linux NO_XDEV and trusted-root-origin checks independently exercised. Unknown macOS alias exclusion refuses strict mode; no stat-dev-only pass |
| Concurrent edit/growth/truncation/rename/unlink; readdir type unknown; inode replacement | Bounded changed/partial outcome, no coherent-snapshot assertion or unsafe type open |
| Revocation during read, after discovery, between two calls; worker continuation/project move | One admitted operation may drain; next admission fails. No cursor/handle renewal |
| Abort queued/open/read/enumeration; timeout; shutdown; fd reuse/EMFILE; fdopendir failure | Join/close exactly once; no late publication, leaked handle, reused-fd close or queue growth |
| Missing binding, kernel flag rejection, seccomp denial, unsupported filesystem | Explicit capability unavailable, no weaker fallback or source execution |
| Ask pinned/live, skills/images, read denials, scratch, bash/jobs regression | Existing semantics preserved; strict refusal does not broaden another route |

Before any implementation activation: agree weaker macOS versus strict semantics,
qualify anchor acquisition and supported filesystems, validate packaged Node/native
ABI loading and existing sandbox policies without adding grants, run these native
tests on macOS/Linux, and measure bounded large streaming-session load. This docs
change performs none of those runtime/security checks.

## Platform references

- [Linux openat2](https://man7.org/linux/man-pages/man2/openat2.2.html): BENEATH,
  NO_SYMLINKS/NO_MAGICLINKS, NO_XDEV (including bind mounts), race EAGAIN and
  unsupported syscall/flags. Bound retries; never remove flags to get success.
- [POSIX fdopendir behavior on Linux](https://man7.org/linux/man-pages/man3/fdopendir.3.html):
  descriptor ownership and CLOEXEC handling, not path reopening.
- macOS installed SDK `usr/include/sys/fcntl.h`, `dirent.h`, `sys/mount.h`:
  openat, O_NOFOLLOW/O_DIRECTORY/O_CLOEXEC/O_NOFOLLOW_ANY, fdopendir/dirfd and
  fstatfs declarations. Header availability establishes an API candidate, not
  tested deployment semantics or complete mount/content isolation.
