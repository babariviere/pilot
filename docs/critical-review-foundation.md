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
