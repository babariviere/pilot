# Host workflow confirmation receipts

Backend implementation only. No native confirmation UI, mission admission, reviewer execution,
spending, feedback producer or acceptance gate is activated by this seam. Existing missions are
not adopted. No live records or backfill are created by development or verification.

## Ingress and packages

`POST /api/operations` recognizes five distinct purposes: `workflow-approve`, `workflow-revoke`,
`review-consent`, `review-consent-revoke`, and `review-disposition`. Each requires the existing
native host-action capability before journal reservation. The capability is an ingress filter,
not workflow authority by itself. Actor labels and extra keys are rejected. The host binds the
kind, full immutable payload, target, host lineage and operation identity through the existing
`DurableOperation` and `OperationJournal`. There is no new capability file or authentication service.
Creation-enrolled Day interviews also bind the exact complete submitted answer snapshot to the
approval package. Its host-only consumer and uninstalled-adapter boundary are documented in
[Day mission agreements](day-mission-agreements.md). No legacy gate is activated by this addition.

The practical assurance excludes hostile same-user processes and UI automation. Native user
confirmation remains separately unqualified; this is not proof of human presence.

Passive, no-store GETs:

- `/api/missions/:id/approval-package`
- `/api/missions/:id/reviewer-consent-package`

Both accept only `action=approve` (default) or `action=revoke`. They return a complete immutable
package and `expectedPriorOperationId`. They do not reserve an operation or write an approval.
The payload is `{purpose, package, expectedPriorOperationId}`. No caller-chosen package source,
authority, project path, provider or actor is accepted.

The package contains the exact saved brief, active decisions, named coordinator and bounded powers,
Balanced review/check policy, exclusions, project/coordinator configuration digest, context fence
and conservative mission event high-water. Bounds are 32 KiB of brief and 16 KiB/128 decisions;
oversize inputs refuse, never truncate. Any mission event conservatively invalidates a prior package.
Owner/member/coordinator edit/revert cannot restore its old event fence. Project settings edit/revert
also changes the persisted host-owned `workflowGeneration`; environment and hook settings already
carry their own revision identities. A held package is checked again inside the store transaction.

## Storage, currentness and consent

`workflow_approvals` and `reviewer_consents` are append-only tables in `missions.sqlite`, using its
existing transaction and disk-replica lane. Each row stores the complete operation identity and
confirmed package. A unique operation ID and exact prior-row CAS prevent duplicate or competing
effects. Revocation appends a separate row. Records survive as history and do not transfer to a new
coordinator or a changed package. No authority is inferred from an older identical package.

The host-only `current()` reader separates missing, applicable, stale, revoked, expired and unknown.
Positive results pin the observed row and workflow authority before `MissionStore.durable()`, then
refuse changed identities after journal I/O. A later append is not covered by the earlier barrier.
Revocation can block
immediately in memory. A pending revocation journal entry also blocks positive currentness and new
positive confirmation, even if a crash lost its exact store effect. Historical accepted receipts
never renew a grant. There is no active admission/dispatch consumer of these rows.

Consent requires a current exact workflow approval plus a trusted host disclosure configuration:
data scope, provider, model, non-secret account, terms, configuration revision, retention and expiry.
The fixed limits are $20 cumulative per mission and $4 cumulative per logical task across rechecks.
Consent records never allocate a fresh budget, silently refill on replacement, switch accounts/models,
or select paid fallback. Mission end, expiry, revocation or changed configuration makes consent
unusable. Accounting, logical-task continuity and enforcement within shared ceilings belong to the
separate accounting/run-linkage implementation, not this receipt writer.

No concrete provider/account/terms producer is installed in `server.ts`. Consent preparation therefore
refuses as unavailable rather than inventing terms or selecting credentials. The host-only disclosure
port exercises the real consent storage/admission code with local fixtures, without transmission.

## Human review producer boundary

`review-disposition` strictly binds a nonempty selected list of exact project/session/snapshot,
repository/change, base/head commit, layer, diff SHA-256 and comparison digest identities. It includes
the exact disposition, text, expected prior record and producer package digest. The operation target
is that package digest, not a chat or mission. There is no guessed task attribution or approval of
future revisions. Comment and Request changes carry no required-approval waiver.

`QualifiedReviewDispositionSource` is the narrow integration port for the real feedback/annotation
producer. It must build the current package from authorized retained comparisons, bind request,
configuration and authority revisions, perform atomic prior-record CAS and final prerequisite checks,
make its own durable write, and provide exact-operation lookup. It is absent in production until
that producer is wired. No duplicate feedback table is added here. Approve also requires a qualified
passing checks and independent-agent-review source; missing, partial or blocked is not passing.
Passing sources in the tests are synthetic only. The receiver cannot infer approval from a diff,
chat status, agent claim or empty checklist.

## Crash recovery

The journal's atomic reservation reports `firstEntry` only to the original handler. Before entering
an effect, that handler saves `workflow-effect-entered` with its exact purpose and payload hash through
the existing checkpoint. It appends with current-package/prior CAS, awaits store durability, and only
then lets the journal publish acceptance. Any durability failure remains pending, not rejected.

Every pending re-entry, including generic startup `journal.recover` and repeated POST, is lookup-only.
It requires the exact entry checkpoint and exact complete operation row from the authoritative store.
Missing or unreadable rows remain Unknown/pending. Matching current state or a passive package GET
cannot mint a replacement. A crash after reservation but before the checkpoint is also Unknown;
it cannot be distinguished from an interrupted confirmation and is not replayed.

`POST /api/operations/receipt` is passive and returns the existing journal receipt or Unknown. Check
never submits a confirmation. A crash after a durable effect but before the final receipt can settle
from that exact historic row, even when the grant is now stale/revoked, without making it current.
The feedback producer has the same exact-lookup obligation. Its uncertain writes are never replayed.

Focused tests cover capability/purpose spoofing, payload mutation, held packages, project/coordinator/
membership ABA, prior CAS, conflicts, lost ACK, restart on both sides of the effect, missing/unreadable
rows, failed durability and unavailable feedback/check producers. Tests use temporary databases and
faux host configuration only.

## Native confirmation

The desktop sheets for the four workflow purposes are described in
[apps/desktop/docs/workflow-confirmations.md](../../apps/desktop/docs/workflow-confirmations.md).
They send the prepared package verbatim, save the envelope before one POST, and use only the
passive receipt lookup for Check. `packages/daemon/src/testing/workflow-host.ts` runs these routes
for the native journeys in a temporary home. Review dispositions have no native producer here.
