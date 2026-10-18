# Critical review foundation (disabled)

The critical-review namespace is separate from `reviews.json` and `/api/reviews`, which still
only track whether chat results were read. Version 1 transport models are mirrored in
`PilotCore/CriticalReviews.swift`. Records are host-owned, immutable and idempotent by ID;
new runs and dispositions retain history rather than rewriting evidence or finding meaning.

`CriticalReviewStore` runs private SQLite writes and fsync in a bounded worker queue. It refuses
future schema versions. The store is not constructed by the server and has no HTTP, agent or UI
entry point. Production review, acquisition, permissions and provider execution remain disabled.

Focused checks use temporary stores and synthetic records only. Swift compilation and end-to-end
review behavior require subsequent CI and integration work; transport types do not enable reviews.

`CriticalReviewVault` captures only explicit host selections into private immutable blobs and a
digest-sealed manifest. Readers accept manifest/blob IDs and bounded byte pages, not live paths.
Unselected data, secret paths/known credentials, binaries, unsafe paths and exceeded limits become
explicit omission records without retaining their contents. Capture adapters must provide known
secrets and select only authorized data. Pattern matching cannot prove that arbitrary text is secret-free.
No real repository acquisition or provider transmission is wired. Missing/tampered blobs fail closed.

## Retention and deletion

Schema v2 adds durable lifecycle indexes. Evidence expires 30 days after the last explicit host
use, other retained result/context records after 90 days. Ordinary reads do not refresh expiry.
Owner pin/use/unpin and active/release actions are internal typed primitives, not text approvals.
Expired reads fail even before maintenance unlinks bytes. Active/pinned objects are never silently
evicted. Quotas count retained records, blobs, staged captures and pending deletions, capped at
1 GiB/project and 5 GiB/host; admission fails instead of evicting another object.

Linked copies must carry all parent source IDs. Erasing a source durably revokes it and tombstones
linked records before unlinking blobs. A failed unlink remains unavailable and charged until a
retry completes. No model-context cache is retained here. Citations keep their opaque original IDs;
missing records are unavailable, never reloaded from live content. SQLite secure-delete and a WAL
checkpoint remove application-owned text copies, not provider retention, filesystem snapshots or backups.

There is one store/vault owner per daemon data home. Call `recover()` before admitting captures,
then `maintain()` at host lifecycle boundaries. Startup clears interrupted capture stages; it never
replays acquisition. Session/archive deletion, access-revocation hooks, authenticated app actions,
cache invalidation outside this namespace and maintenance scheduling are **not wired**. Archive alone
must not erase eligible objects. Those integrations must use linked erasure rather than copying text
into another untracked store. No automatic cross-host distribution is implemented.

## Consent and accounting

Schema v3 adds a separate durable ledger. Only a trusted host adapter may install structured
snapshot/run-scoped grants and current verified pricing. Admission enforces one active run per
logical target and two per host. Every call, including classifier and follow-ups, reserves worst-case
money/input/generated/time before a durable send claim. A send claim is single-use. Restart marks
in-flight reservations uncertain and releases concurrency, never refunding or replaying calls.

PR total profiles are $1/32k/6k/2m, $4/120k/12k/5m and $10/300k/24k/10m. Session review is a
separate fixed $4/120k/12k/5m profile. Classifier is included, once only, capped at $0.10/12k/1.2k,
15s provider/30s stage. At least 15% generated allowance remains for final output. Upward transitions
consume a new authorized total, never an additive allowance. Exact provider/model/billing must match
the grant and rate. Subscription calls still consume usage ceilings and require open provider gates;
they cannot silently fall back to paid API calls. Shared rolling limits are $20/600k input/48k
generated per 24h. Unknown usage remains worst-case even after the window until reconciled; known
overruns stay charged and freeze further calls. Duplicate/conflicting receipts never reduce charges.

Rates, provider gates and receipts are host assertions, not model text. No live pricing lookup,
credential access, real provider adapter, consent UI or automatic retry is installed. Production must
authenticate structured owner actions, verify provider maxima/prices, call recovery before admission,
and honor send deadlines/cancellation. Wall time conservatively includes time since run creation;
approval-wait exclusion is not yet wired and cannot extend an allowance through these primitives.
The accounting ledger retains only opaque IDs, hashed target keys and numeric costs after linked
erasure, so deletion cannot reset budgets. No private transcript/context text enters this ledger.

## Restricted capability qualification

`kernel/review-boundary.ts` constructs only `evidence({action: "list" | "read" | "search", ...})`;
search is bounded and literal. The manifest is fixed by a host closure. Tool names/actions/arguments are checked in
host code on every invocation, including follow-ups. There is no executable tool, generic codemode,
MCP/discovery, network tool, live workspace, memory/mission mutation, delegation or GitHub capability.
The module imports no SDK resource loader, Build/Ask session, settings, packages, extensions or hooks.
Evidence is untrusted data, not policy. Limits include 50 KiB tool output, 10s reads, three retained
I/O slots and 256 lifetime tool attempts. Search reports its bounded scan as partial.

`SyntheticReviewer` is deliberately **fake-provider only**, not a production model adapter. Every turn
is separately reserved and single-use sent through the durable ledger; context and turn counts are
bounded and cannot reset the run budget. Unknown/denied tools remain unavailable on follow-up.
Cancellation/deadline errors close the boundary, suppress late output and keep uncertain charges.
Host erasure/expiry/store failure closes synthetic contexts and clears their in-memory copies.

Not implemented or qualified: a real provider/Harness bridge, actual tokenizer/context-window and
provider-output enforcement, model/profile availability, trusted context resolution, production acquisition,
findings publication, UI, host lifecycle scheduling and cross-process erasure notifications. The
daemon remains the sole store owner. Do not wire the synthetic seam to real accounts, enable entry
points or infer semantic quality from these permission tests. No product calls/evaluation ran.

## Read-only PR capture (disabled, synthetic qualification only)

`critical-review-pr-intake.ts`, `critical-review-pr-objects.ts` and
`critical-review-pr-capture.ts` provide a separate internal capture lane. They do not import the chat
PR binder, create a target/run, discover accounts, open an author checkout, create/move refs, or
enable HTTP/UI/model entry points. `ReviewPRReader` has only two host read operations and **no live
implementation**. Fake responses are explicit synthetic fixtures, not recordings from real accounts.

Intake requires the canonical GitHub host, authenticated account ID/login, immutable repository ID
with owner/name, and PR ID/number. Names are normalized; IDs remain exact. Every object response must
match host/account/repository and requested object type and SHA-1. Fork head objects are requested in
the fork's scope, not silently from the target repository. Metadata is checked again before sealing;
account changes, tip movement, deleted refs and inconsistent identity fail instead of retargeting.
The adapter must supply **the current target-ref tip B**, not a historical `baseRefOid` or default
branch. Null, inaccessible or ambiguous targets are unavailable. This contract still needs an
authorized real GitHub capability check; the fake seam does not prove API availability or access.

Capture imports the complete H/B commit-parent closure, requiring every parent object, into an
owner-private object-only database under the existing vault's tracked `.part` staging. It verifies
object payload hashes/types, requires a single `merge-base --all` result M, and checks M is an
ancestor of both H and B. Unrelated, shallow/missing and criss-cross/ambiguous histories fail closed.
Only the H/B/M trees and their immutable blobs are then acquired. There is no fallback to main,
synthetic merge commit, or mutable PR patch endpoint. SHA-256-format Git repositories are not yet
supported and are rejected, not shortened to SHA-1.

Git runs only the fixed `/usr/bin/git` executable against this disposable bare database, with an
allowlisted environment, no ambient config/replacement/graft/shallow/alternate store, hooks disabled,
system/user attributes disabled, external diff and textconv disabled, and all transports forbidden.
No fetch/clone, shell, checkout, index/worktree operation, templates, credential helper, filter,
submodule traversal, LFS hydration, package install, build or reviewed-code execution is performed.
Executable-mode regular files are captured as text data only, never installed with executable mode.
Symlinks/gitlinks have inventory records but omitted surrounding source; symlink blobs may appear as
literal diff data, never filesystem links. LFS pointers remain pointers, not hydrated source.

Sealed evidence contains a versioned `pr/capture.json` receipt naming H/B/M and tree OIDs, ordered
per-path H/B/M inventory records, regular surrounding source for all three trees, and canonical
M-to-H per-path Git patches. Patches use Myers, full indexes, three context lines, no renames, and
UTF-8 byte path order. Literal pathspecs exclude descendants to avoid duplicate patches during
file/directory replacements. The diff is the ordered concatenation of retained `pr/diff/` entries,
**only complete when none of its selections were omitted**. Path-specific labels allow the vault
to omit secret filenames, secret patch/source text and binary content without retaining those names
in a global index. Vault omissions are authoritative: a partial capture never claims full inspection.
No discussions/checks or trusted project-policy resolution are implemented by these modules.

Ceilings: 128 MiB acquired object payloads and separately 128 MiB assembled evidence, 8 MiB/object,
40,000 objects, 20,000 cumulative H/B/M tree entries (directories included), 20,000 vault selections
including metadata, 8 MiB total patches, 64 KiB metadata/read, 10 seconds/read or Git command, and
60-second capture deadline including seal (late seal/revocation/cleanup is awaited, so this is not
a guaranteed response-time bound). A repeated tree consumes the cumulative path budget again.
These conservative bounds can reject repositories below the nominal source-path ceiling. Unsupported
tree modes, non-UTF-8/unsafe paths, depth over 64 and paths over 400 UTF-8 bytes fail explicitly.
No truncated acquisition is promoted to a complete snapshot. Object scratch space and simultaneous
vault sealing both count against existing project/host storage quotas, with no eviction. Startup
`vault.recover()` removes interrupted object stages, without replaying acquisition. Memory can include
assembled evidence, per-object buffers and vault sealing copies; limit-size RSS/latency is not qualified.

Each capture owner admits one capture at a time, without a queue, and retains at most three actual
transport reads even if cancelled adapters ignore their signal. There is no automatic retry. The
future host service must keep one owner per vault, honor access revocation, and terminate transport
resources on cancellation. Atomic vault sealing is not interruptible: a late cancelled/timed-out
seal is revoked and unlinked before capture returns an error. Account/repository/PR scope hashes
and a unique capture source participate in existing linked erasure. Host lifecycle/access hooks
remain unwired; this does not grant acquisition or reviewer authority.

Focused acceptance: `node --test --test-force-exit packages/daemon/src/critical-review-pr-capture.test.ts`.
Cases cover fork/stack identity and exact patches, deleted/ambiguous/unrelated bases, missing and forged
objects, account/host/repository mismatch, tip races, acquisition/storage quotas, cancellation during
reads/sealing, non-cooperative adapters, hostile Git config, literal/file-directory paths, unsafe trees,
binary/secret/symlink/gitlink/LFS coverage, immutable reads after source removal and startup cleanup.
The small synthetic many-path measurement is not production performance or full-ceiling qualification.

Before any live capability probe, obtain separate authorization naming the host, account, repositories
(including forks), private-data owners, read scopes, retention and finite acquisition limits. Then
qualify current target-tip/deleted-ref behavior, exact object retrieval and complete parent visibility,
fork access, account-switch detection, rate limits and cancellation with those authorized resources.
Do not add write scopes, default-branch fallbacks or execution as a workaround. No such probe, live
acquisition, real provider/evaluation call or activation has run. Publishing this capture code does
not authorize live access, review submission, provider/evaluation spend or production activation.

## PR discussions and checks (disabled)

The optional `ReviewPRDiscussionReader` in `critical-review-pr-discussions.ts` extends the existing
`ReadOnlyPRCapture` only when explicitly supplied by its host caller. There is no live transport,
account discovery, API/server/app/tool wiring or enabled entry point. Synthetic fixtures provide
normalized, authenticated-scope responses. This seam does not qualify real GitHub capabilities.

Body, general comments, submitted review bodies, inline comments/replies, check runs, commit statuses
and API file inventory are captured as untrusted text records with IDs, commit SHA where available,
thread/source references and adapter observation times. General comments have no commit binding;
each record separately names the fixed snapshot head. Exact-head and other-head checks are labeled
explicitly: neither green checks nor a successful log prove coverage, and other-head results never
verify the captured head. Optional check output is inert text. No response text grants permission.

The collector uses two bounded observation passes. Differences in body, ordered collection contents,
totals or availability mark capture incomplete while preserving the first observed records; later
digests and observation times document drift. These are not atomic GitHub revisions. Unchanged
re-reads cannot detect every intervening edit or guarantee currentness after the final observation.
Head/base/account/scope movement fails closed under the existing fixed-object capture fence.
No automatic retry, backoff, reacquisition or fallback source is installed. A 403, rate limit,
malformed response or unavailable component remains an explicit omission, not evidence of absence.

Ceilings are 20 pages × 100 items per collection per pass, 256 total discussion/check read attempts,
256 KiB per normalized page/state response, and 20 MiB aggregate charged responses across both passes.
Selected exports, including their wrappers, have a separate 20 MiB ceiling with 256 KiB reserved for
the bounded coverage report. These are also subject to the existing shared 128 MiB capture, 8 MiB
blob, 20,000-selection and storage limits. Reads are sequential and share the owner's three actual
transport slots, including adapters that ignore cancellation. The existing 10-second read and
60-second whole source-capture deadlines include object and discussion acquisition together.
Adapters must enforce byte/deadline/scope limits before parsing and stop transport work on abort;
post-response checks cannot undo an unbounded allocation in an untrusted adapter.

API file totals are compared with observed file records and immutable M→H changed-path inventory.
Rename source/destination paths are reconciled together, without treating the API's one-file count
as the canonical no-renames path count. Missing/unexpected paths, duplicates, cursor loops, unknown
or changing totals and capped pagination are disclosed. Reconciliation includes paths whose source
text is excluded by the vault, not just readable text. Binary/secret/unsafe source omissions remain;
LFS pointers are not hydrated, and submodules/symlinks are not followed. API patches are not used as
a replacement for canonical Git evidence.

Log reads require structured host selection of a previously observed check ID, exact check SHA and
byte range, frozen at capture admission. At most ten excerpts of 50 KiB each are accepted. Offsets,
reported total length, truncation, SHA and observation time are retained; mismatched responses are
omitted. Partial/unknown-length excerpts mark capture incomplete. There is no continuation fetch,
artifact/archive download, decompression, execution, redirect handling or external-link traversal.
Author text, check output and log links cannot expand that selection. A future authorized adapter
must separately qualify check/job mapping, actual range support and endpoint/redirect behavior.

`pr/discussions/capture.json` records bounds, charged bytes/attempts, counts, reconciliation, mutable
observations and component omissions. Its completeness describes acquisition before vault filtering,
not code coverage or a clean review. Vault omissions/redactions apply independently to every record
and to the reports themselves; consumers must check the sealed manifest as well. Recognizable or
host-known secrets omit the entire affected record instead of exposing partial credential text.
All source/body/discussion/check/log/report selections share the original capture's erasure lineage
and private retention. Erasure leaves no live-content fallback. Host lifecycle integration stays unwired.

Focused synthetic checks run the PR capture and PR discussion test files, including pagination,
403/rate limits, concurrent edits, bounded logs, binary/LFS limits, check SHA mismatches, cancellation,
non-cooperative adapters, secret omissions and linked erasure. A collector-only limit-sized diagnostic
reports elapsed time, RSS and event-loop delay; it is not a production transport, GUI or full-system
performance qualification. No live/private acquisition, capability probe, product model call or spend
has occurred. Production activation and real-account qualification remain separately gated.

## Committed session capture (disabled)

`kernel/review-history.ts` and `daemon/critical-review-session.ts` add an internal transcript-only
capture seam, exercised only with synthetic temporary SQLite stores. No server, SessionManager,
agent tool, app entry point or production acquisition adapter calls it. It never starts/resumes a
Harness, acquires the author writer lease, changes the active attempt, migrates/checkpoints storage,
wakes an author workspace or reads queued/held/native input, streaming generation or tool progress.
SQLite may maintain WAL read-coordination sidecars, as with the existing cold reader.

The host supplies the exact attempt and inclusive committed entry boundary (zero means explicitly
empty). Missing attempts/boundaries remain unavailable, never the active/latest/root fallback.
One read-only SQLite transaction pins schema, ancestry, entries and receipts per source. Raw immutable
entries include retained pre-compaction originals, summaries, reset markers, context edits, tool
calls/results and child/artifact references. Fork ancestry inherits only its inclusive parent prefix;
abandoned suffixes and newer entries are excluded. Mutable submission receipts are explicitly labeled
as capture-revision observations, **not** reconstructed receipt state at an earlier entry boundary.

SDK `scanEntries`/`scanSubmissions` hydrate whole JSON rows before byte limits can be imposed, and
ordinary cold snapshots intentionally hide pre-compaction history. This export instead uses a dedicated
off-thread raw reader, qualified against the default pi-durable SQLite schema v1 and retained SDK fork
scans. Future schemas fail closed pending requalification. Metadata pages contain at most 64 rows;
`octet_length` checks UTF-8 bytes without hydrating oversized rows; payload reads are at most 50 KiB,
records/blobs 8 MiB, and aggregate hydrated/exported transcript data 20 MiB. Work is capped at 40,000
records, 41,024 reads, 64 fork ancestors, 16 explicit session sources, two concurrent captures and a
60-second deadline. The aggregate export reserves 256 KiB for bounded coverage reports. Hashing and
history parsing run in a cancellable, memory-limited worker; vault reads retain their existing 50 KiB
page cap. No history is materialized on a daemon refresh/summary path.

Every source requires an explicit host lineage assertion (root, unavailable, or accepted continuation
with the next selected predecessor and an opaque host authorization reference). Transcript prose,
handoff summaries, child references and request-ID prefixes cannot select another store or grant
access. Every selected predecessor enters `sourceIds` for linked erasure. Sources have independent
SQLite revisions, not a cross-store atomic snapshot. A future authenticated host adapter must resolve
same-host/project access, stable deletion identities and accepted lineage before invoking this seam.

Sealed reports disclose compaction, unknown pre-compaction completeness, forks/rewinds, resets/context
edits, original-request/input and submission gaps, legacy origin hints, unavailable sources and limits.
Numeric entry-ID gaps alone do not prove missing history. Child histories and artifact contents are
not acquired: only their committed boundary/reference records survive here. Unavailable continuation
lineage is retained as unknown. This slice always marks the manifest incomplete via an unselected
uncaptured-scope marker; its sealed coverage report explains the scope rather than implying a complete
session/code review. Vault secret/unsafe/quota omissions still apply independently to every selection.

Existing submissions do **not** retain verifiable original pre-expansion input. Unknown origins,
`native:user:` and typed-looking IDs are not authenticated user intent. The pure `originalInputEvidence`
helper defines a bounded future admission record (original host-received text, request ID and prepared
text digest); no production writer is enabled. Export includes such a record only when it matches a
committed input/submission inside the boundary, suppresses conflicting records and excludes unmatched
or queued provenance. Even a match is labeled recorded, not authenticated, and never approval. Trusted
structured app actions remain the only consent/authorization source. Future actual recording and
authentication, plus legacy reconstruction (where possible), remain integration work.

Cancellation or private-store invalidation terminates acquisition and checks cancellation during vault
staging. Sealing's durable `put` is the cancellation linearization point: an already-started final put
may finish and retains its durable result. Source tombstones still prevent sealed reads or resurrection.
No automatic retry/reacquisition occurs after interruption. The vault's optional capture abort signal
is additive; existing callers are unchanged.

Focused fixtures cover compaction/fork/context-edit/reset history, retained/missing originals,
continuation selection, concurrent writer commits, cancellation, linked erasure, secret omissions,
multibyte pages, unsupported schemas and a 20,001-entry byte-limit case. These are storage/boundary
checks, not live data acquisition, model quality evaluation, a GUI performance measurement or rollout
qualification. Code/tree/verification capture, child/artifact content acquisition, production provenance
recording, lifecycle wiring and all user-facing activation remain outside this slice.
