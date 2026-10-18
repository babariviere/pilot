# Code and verification evidence capture (disabled)

`daemon/critical-review-code.ts` is an internal companion to committed session-history capture.
Only synthetic callers are qualified. No server, SessionManager, kernel tool hook, app action,
workspace manager, account adapter or provider installs it. Production review entry points remain
disabled. The existing vault and protocol are unchanged.

## Host contract

The future authenticated host must resolve the exact author/session/attempt/committed boundary,
source deletion identity, existing canonical workspace and Git directory, and starting commit SHA.
This seam never asks for the latest attempt, guesses a baseline, wakes an author, checks out files,
repairs a repository or creates a missing workspace. Null/missing workspace produces a sealed
conversation-only availability report, not an empty clean tree. The transcript is separately pinned
by `captureSessionHistory`; these observations are not atomic with that SQLite checkpoint.

`ReviewToolAdmission` is a standalone, bounded safe-boundary primitive, **not yet installed in the
author kernel**. The future tool adapter must bracket every foreground tool invocation with `enter`
and its idempotent release, including failure/cancellation. `hold` blocks new admissions immediately
and waits for admitted foreground tools to finish. It never aborts tools, jobs or children, and does
not wait for background jobs to finish. Holding or cancelling a capture does not install/remove any
other Stop/update/usage pause. A production bridge must compose those independent gates, not resume
them through this primitive. Queued starts are capped at 64; simultaneous holds fail rather than queue.

An owner admits one capture at a time, with two simultaneous captures per process. Acquisition has
a 60-second deadline. Waiting for the safe boundary and all inventory comparisons together hold new
tool admission for at most 5 seconds, then fail/cancel and release it. Capture makes two inventories
per attempt, with at most one retry, before releasing admission. Vault sealing and the second activity
observation happen after release. Late cancellation during the vault's final durable put follows its
existing seal linearization contract; erasure still prevents resurrection. No automatic restart/replay.
Non-cooperative activity readers keep their owner busy after cancellation until the actual read settles;
at most three actual activity reads can remain in flight per process, including cancelled readers.

## Immutable tree, not an atomic workspace claim

The starting commit, every traversed tree and retained regular blob are read as raw Git objects,
with type/size and SHA-1 content verification before use. The commit-to-tree linkage and tree paths
are parsed from these verified bytes, not a mutable diff or assumed-valid object filename.
The exact starting commit's regular source, current tracked working-tree bytes and nonignored
untracked regular files enter immutable vault selections. Per-path inventory records retain mode,
content SHA-256 and deletions. Staged paths/index state participate in comparison, but distinct staged
blob bytes are **not** captured when they differ from the working tree. This is a working-tree review,
not a reconstruction of all index versions. Ignored untracked files are not read, including paths
removed from the index since the baseline. Executable files are text evidence, never executed.
Missing skip-worktree/sparse paths and gitlinks are unsupported omissions, not inferred deletions.

Each pre/post comparison retains HEAD, index listing digest, current inventory digest and a watermark
that also includes file identity/stat metadata. Content is hashed off-thread, with identity/stat and
path checks around reads. Detected within-file mutation or changed pre/post inventory is a race.
Even a stabilized retry remains partial. The report always says atomic=false; undetected external
writers, transient/ABA changes and cross-store timing cannot be ruled out by two matching observations.
Filesystem namespace checks are not a hostile-writer-proof `openat` sandbox. Do not activate live
capture without qualifying the future host access/sandbox boundary.

Source paths are stored only in individual path-labeled selections, so the existing vault can omit
secret paths/content without leaking filenames through a global inventory. Binary, secret, symlink,
hardlink, gitlink, unsafe and quota omissions remain authoritative. A digest describes the acquired
raw inventory, **not** proof that all bytes survived vault filtering. A capture is always incomplete
as session evidence: child contents and staged blob versions are absent. No low-effort/clean-review
or test-coverage conclusion follows from a matched inventory or process exit.

`sha256-code-inventory-v1` is SHA-256 of UTF-8 JSON for the UTF-8-byte-path-sorted working inventory,
with fields in order `{path, mode, state, sha256}`. It includes baseline-path deletion records and
unsupported/unsafe states, but not byte payloads or stat watermarks. It is not a Git tree OID. A host
receipt may identify this same digest algorithm or a Git tree SHA-1; a Git OID is retained but never
silently compared with the different inventory algorithm. SHA-only receipts cannot prove dirty-tree
association. A null tested identity stays null, never capture-time HEAD/tree.

## Verification and resource boundaries

`CodeActivityReader` supplies bounded host process/check receipts and child states before and after
capture. It has only a read operation, no execution, start/stop/wait, wake or workspace capability.
Both revisions survive job completion/cancellation. This is current capture-revision evidence, not
historical job state at a transcript checkpoint. No logs or author prose are parsed as test authority.
A bounded command/check label and explicit complete/truncated/unavailable output coverage survive
alongside each receipt. A pass requires `done`, explicit `passed` conclusion and known zero exit together. Null/unknown exits,
unknown conclusions, failed/cancelled/interrupted states never pass. Tree association is separate from
outcome; zero-file suites, truncated output and test coverage are not inferred. Actual jobs/child
receipt adapters and tested-tree recording remain future host integration work.

The reader accepts at most 256 jobs and 256 children per observation with opaque bounded identifiers
and 1 KiB command/check labels;
extra fields/logs/paths are discarded. Source acquisition is capped at 4,000 union file paths (and
separately 4,000 baseline tree entries including directories), 64 path components, 8 MiB/object/file
and 120 MiB aggregate acquired object/current-file bytes per inventory, reserving vault capacity for metadata.
Over-limit or unsupported repositories fail rather than certify a truncated tree. Whole-evidence
vault limits still apply, including metadata. Raw source hashing/parsing runs in a cancellable worker
with a 256 MiB old-generation limit (Buffer allocations are separately bounded by byte ceilings).
Two full inventories and IPC/vault copies may coexist; limit-sized RSS/latency is not qualified.

Git uses the fixed `/usr/bin/git`, explicit Git/worktree directories, a minimal environment, disabled
optional locks/fsmonitor/hooks/replacements/lazy fetch/transports, and only rev-parse/cat-file/
ls-files. No shell, fetch/clone, checkout, diff driver, textconv, filter, LFS hydration, submodule
traversal, install, build or reviewed-code execution. Repository Git configuration/object storage is
still read; this is not an object-only sandbox like PR capture. Git child handles belong to the
host, are killed on capture cancellation/10-second command timeout and awaited before worker cleanup.
Only those capture-owned read commands are cancelled, never author tools/jobs. SHA-256 Git repositories
and unavailable/invalid baseline objects are unsupported, with no default-branch fallback.

## Focused qualification

Run `node --test --test-force-exit --test-timeout=120000 packages/daemon/src/critical-review-code.test.ts`.
Fixtures use temporary synthetic repositories/stores and fake receipts only. They cover dirty and
missing trees, deterministic external writers, safe-boundary cancellation, immutable reads, job
completion/null exits/cancellation, secret/binary/unsafe omissions and hostile filter/fsmonitor config.
No live/private acquisition, capability probe, provider/evaluation call, real reviewed-code/test
execution, Swift build, full-suite run or production activation is authorized by this module.
