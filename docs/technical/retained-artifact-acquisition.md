# Exact stored visual acquisition

Status: host-only acquisition. No endpoint, agent tool, installed dispatcher, visual execution,
provider call, approval or acceptance gate uses this API.

## Storage and byte boundary

`ArtifactStore.publish` writes `artifacts/<id>/<revision>.json` before its atomic `latest.json`
summary. A numbered file above the committed pointer is not a committed revision. `get` parses
JSON and may rebuild image HTML. `MissionService.readArtifactReference` returns parsed fields
without HTML. Neither is an exact stored-byte acquisition API.

`ArtifactStore.readStoredRevision(id, revision, signal?)` requires an explicit positive revision.
It reads the committed pointer with a 4 KiB limit and the numbered container with a 1 MiB limit,
before allocating or hydrating JSON. It checks file stability, owner, project, ID and revision.
It supports visual/API-1 containers only. Missing, unsupported and oversized inputs fail explicitly.
`SessionManager.readStoredArtifactRevision` is a passive wrapper and never wakes a worker.

The original input here means the **numbered stored JSON container**. This includes its exact
UTF-8 bytes, whitespace, BOM and CRLF if present. Current writes do not emit a container BOM or
formatting CRLF. Tests also cover historical disk fixtures with those bytes.
Acquisition does not recover a pre-publication submission, discarded whitespace or earlier
serialization. It does not change writes or history.

## Host capture and reopen

`MissionService.captureRetainedArtifact(sessionId, taskRef, reference, host, signal?)` takes:

- An explicit `{ artifactId, revision, kind: "visual", sourceOwnerSessionId }` reference.
- The existing retained-brief host identity, run, profile, context and review-runtime configuration.
- `validator`: build/runtime/config SHA-256 pins, API, engine and explicit `{ now, timeoutMs }`.
  `now` is a proposed validation time, never inferred historical execution time. The timeout is
  positive and at most 30 seconds, matching the visual check's default execution deadline.

Only the current coordinator can acquire one exact artifact allocated to the current research
task. The source owner must be a current same-project member. A current task link must pin the
same owner, revision and kind. Allocation, submission, assignment, shared-definition revision,
policy, profile and context/event fences must remain current, including link/member/coordinator
ABA changes. Reads before and after each async boundary recheck these pins. The durable barrier
cannot promote later, unflushed authority into the original selection.

Capture seals **one container** with `CriticalReviewVault.capture`. A complete result reopens via
`readExact`; secret/quota omissions stay partial. No replacement empty source is prepared.
Vault quota errors also refuse acquisition. No quota expansion, eviction or automatic retry is added.
The manifest's erasure sources include the mission, explicit source owner and artifact ID. The single
container entry names the artifact ID as its source.

The host may persist the returned descriptor and pass it to
`reopenRetainedArtifact(sessionId, taskRef, descriptor, host, signal?)` after restart. The descriptor
is limited to 64 KiB and binds:

- The existing acquisition header and explicit reference.
- The actual vault manifest and container blob ID, SHA-256 and byte length.
- Separate hashes/UTF-8 lengths for derived source and data JSON, seed/ID, and stored API/engine.
- The frozen validator configuration and explicit options.

The result returns the exact container bytes and separate `validationInput: { source, dataJSON, id }`.
The source is decoded from the stored JSON string. `dataJSON` is derived by the existing
`validateVisualWrite` serialization, the same path used by `prepareArtifact` before `checkVisual`.
Neither is called the original stored container or original submission bytes. The descriptor is
not `InputDescriptor.source/data` and the result is not `PreparedRetainedReviewInput`.

Reopen compares current source and authority to the descriptor and actual sealed manifest. The
last async disclosure barrier is `readExact`, followed only by synchronous access/config checks
and derivation. Cancellation suppresses returned input. Erasure refuses future reopen, including
after restart, but cannot revoke copies already returned to a host.

## Execution remains separate

Acquisition binds intended validator pins, not an observation that the validator ran or that the
claimed runtime is installed. A future validation producer must verify its actual executable,
runtime and configuration, use the bound arguments/options, and record attributable execution.
Stored publish-time API/engine/check metadata is history, not a fresh validation result. No
historic `checkVisual` time is inferred from `createdAt` or `updatedAt`.

Images, shaders, legacy HTML/React/SwiftUI, unknown APIs, oversized containers and source strings
that cannot round-trip UTF-8 remain unsupported.
There is no latest fallback, guessed owner, reserialization-as-original, source execution or
change to the existing persisted-brief acquisition domain.
