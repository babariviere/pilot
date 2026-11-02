# Linked project knowledge catalog

**Design, 2026-11-02; the storage, API, agent tool and native reader below now ship.** D46 already
selects project ownership. This specifies the smallest catalog for research and component
documentation, not provider jobs, automatic repository writes or new approval/retention policy.
See [what shipped](#shipped-slice) for the exact implemented surface.
Source audit: repository `0c3b3238212603f5daa5a629af94822fd0a0adc3`; source inspection only.
The [desktop workflow](mission-desktop-workflow.md#explorer-findings-and-source-linked-review)
remains the surrounding experience. Concrete contracts below are proposed, not shipped APIs.

## Reuse before adding storage

This is a scoped inventory of relevant stores, not an inventory of the whole project.

| Existing home and exact read seam | Reuse and concrete gap |
| --- | --- |
| Repository research, e.g. [Empryo study](empryo-code-exploration-evaluation.md) and [relationship evaluation](code-relationships-evaluation.md) | Keep original reports, pinned source links, negative findings and attributed measurements. Both already separate observation, inference and proposal. Link rather than rewrite them. No current project-document catalog/read route exists. |
| Repository component contracts, e.g. [code exploration](code-exploration.md), [artifact reader](../apps/desktop/docs/mission-artifacts.md), [design system](../apps/desktop/docs/design-system.md) | Keep these as maintained detailed documentation. A catalog entry supplies discovery, relationships and freshness, not another competing manual. [General documentation plans](reliability/documentation-plan.md) retain their owners and unresolved author-handoff blocker; this proposal neither imports that prose nor takes over those guides. |
| [MissionStore](../packages/daemon/src/missions.ts): `brief_revisions`, `decisions`, `tasks`, `events`, `resources`, `artifact_links`; `detail`, `brief`, `activity` | Reuse canonical IDs and original records. `GET /api/missions/:id`, `/brief?revision=N`, `/brief/revisions`, `/events?before=ID` in [server](../packages/daemon/src/server.ts); tool `get`, `brief`, filtered `activity`, `links`, `artifacts` in [service](../packages/daemon/src/mission-service.ts). Tasks/logs/comments are execution/discussion, not a reusable research schema. Mission-owned children cascade on mission deletion. |
| [ArtifactStore](../packages/artifacts/src/store.ts), `get(id, revision)`; [SessionManager](../packages/daemon/src/sessions.ts), `artifacts`, `artifact`, `projectArtifacts` | Existing session-owned immutable bodies, atomic latest pointer. `GET /api/projects/:id/artifacts` lists current summaries across registered owners, including archived ones; `GET /api/sessions/:owner/artifacts/:id?revision=N` reads an exact body without waking a worker. Mission pins do not transfer ownership. Missing latest pointers/bodies still fail; no historical revision catalog exists. Do not scan all owners on each knowledge read or repurpose executable visual artifacts as the document database. |
| [Non-code delivery](mission-non-code-deliveries.md), `MissionService.saveNonCodeDelivery` | Internal immutable submission references only brief/artifact revisions. Not an active report catalog, public API, acceptance or completion path. Do not activate or widen it to implement knowledge. |
| [Project memory](../packages/daemon/src/project-memory.ts), [disk log](../packages/daemon/src/memory-disk.ts), [memory tool](../packages/kernel/src/memory-tools.ts) | Existing project facts/preferences are short notes, 280 UTF-8 bytes, with replacement links and derived summaries. `GET /api/projects/:id/memory/tree` browses; tool `recall` locates leads. Base `/memory` can schedule compaction, unlike tree reads. Neither summaries nor remembered claims replace source reports. |
| [Review preference proposal](mission-review-preference-memory.md), [coordinator continuity](coordinator-memory.md) | Personal/scoped user guidance and private session continuity are separate concerns, not shared component evidence or decisions. Do not reuse consolidation as research publication. |

Bounded memory recall also located `docs/reliability/documentation-plan.md` and the reminder that
`DESIGN.md` holds reusable guidelines, not a feature-decision diary. Those notes led to source
inspection; they are not independent historical evidence or authority.

**Recommendation:** extend the existing daemon-owned `missions.sqlite` persistence, not create a
new database, repository index, memory tier or file-copy system. Add project-keyed catalog rows
and immutable small document revisions. Reuse repository documents and artifacts as cited primary
detail where they exist. Repository-only Markdown is insufficient for projects without a repository,
app-owned pending work and mission links; memory is too small and semantically different. A new
standalone knowledge service/blob store is unnecessary. Physical reuse of this database does not
make the mission the owner. The [daemon](../packages/daemon/src/daemon.ts) already opens it at
`join(config.home, "missions.sqlite")`; [replication](../packages/daemon/src/mission-replica.ts)
already persists transactions off the event loop.

## Storage and content contract

Use four small tables in that store, with ordinary project/kind and mission-link indexes:

| Proposed row | Fields and invariant |
| --- | --- |
| `project_knowledge` | `id` UUID, canonical `project_id`, `kind: investigation|component`, immutable origin `{missionId?, taskId?, sessionId?, recordedAt}` and current revision. Origin is provenance, not ownership or a guessed task-purpose claim. |
| `project_knowledge_revisions` | `(knowledge_id, revision)` primary key; append-only payload: title, short synopsis, Markdown body, typed sources/relations, author from admitted caller, recorded date and change reason. Store operation ID/request hash with a project-scoped uniqueness constraint for exact retry lookup. Full original revisions remain readable. |
| `mission_knowledge_links` | Unique `(mission_id, knowledge_id)`; monotonic `link_revision`, `linked` flag and optional pinned revision, otherwise explicitly follows current. Unlink retains a tombstone/revision; relink continues that counter. Same-project validation at write/read. A mission is a linked subset, never a second body. Removing a link cannot remove knowledge. |
| `project_knowledge_checks` | One row per entry: last successful scoped check `{knowledgeRevision, checkedAt, checker, sourceVersions, coverage}`, pending generation/reasons/trigger refs, optional existing task ref and last failure. Coalesced pending state is also the durable work queue, not a second job store. |

Only knowledge revision/link/check rows depend on `project_knowledge`. Origin mission/task/session
IDs and source IDs are provenance locators, **not cascading foreign keys**. Mission deletion may
remove its link rows, never project entries. Archive changes neither. A missing origin remains
visible as unavailable provenance. Project removal makes reads unavailable through current project
admission, not a new erasure operation; [ProjectStore.remove](../packages/daemon/src/projects.ts)
currently unregisters the project while sessions retain their project IDs. No path/title matching
reattaches knowledge to a newly registered ID. Explicit deletion/retention changes need separate policy.

One revision is at most 64 KiB UTF-8 including body/metadata, at most 64 source/relation refs; reject
oversize writes, never silently truncate findings. Large evidence stays in existing source stores.
Investigations retain **question, method/scope, findings/conclusions, evidence, limitations/unknown
coverage, resulting decision/task refs**. Give findings stable local labels so a correction can
identify what it changes. Each conclusion says `observed`, `inferred` or `proposed`, with an outcome
such as supported, negative or inconclusive. Observed implementation is not an executed experiment.
Empty/no-result and failed/incomplete investigations are valid content, not discarded failures.

Every entry must contain a useful readable Markdown body, not just a title/synopsis and links.
Research bodies retain the question, findings and limits above even when evidence cannot be opened.
Components retain **purpose/boundary, architecture, interfaces, constraints, rationale and known
gaps**, plus relevant investigation and canonical decision refs. Where a maintained document exists,
store a concise source-attributed account of those essentials and cite it for full detail, without
copying the whole manual or restamping decisions as new authority. The entry must still explain
how the component works when local source opening is unavailable; no file reader is a prerequisite.
Component synthesis is explanation, not policy; conflicting decisions go to the coordinator.

### Source identity, corrections and authority

Sources are typed locators, not inferred titles or opaque arbitrary fetch URLs:

- Repository: project ID, relative path, exact commit when known, observed byte hash when checked,
  optional section/span and inspection date. Dirty/live observations say so; no invented commit.
- Artifact: owning session ID, artifact ID, explicit revision and observation date. Preserve its
  original source links. Never substitute latest for a missing pin.
- Mission: mission ID plus decision/task/event ID, or brief revision. Task/decision numbers are
  display only. [Decisions](../apps/desktop/docs/mission-decisions.md) have `updatedAt`, not immutable
  revisions/CAS: retain observed timestamp and exact text/hash as a historical citation, then resolve
  the canonical current decision separately. A retained quotation cannot keep a revoked choice binding.
- Web: original URL, access date, publisher revision/date if actually available and any retained
  excerpt/hash. Access date alone is not an immutable source revision; unavailable originals stay unknown.
- Knowledge: exact entry/revision and optional finding label; relations `supports`, `supplements`,
  `supersedes` or `documents`. Supersession names the affected finding/range, not a blanket erasure.

Append corrections/supplements with reason, source and author, linking the original. Research's
original conclusions are never silently replaced by today's account. A fresh investigation can
supersede part of an older one; the older report and negative results remain accessible. Components
may publish revised summaries with history, citing that change. Removing a canonical decision or
losing source access shows a broken/currently unavailable citation, not replacement authority.

## Proposed read/write and navigation seams

No routes below exist today. Add protocol types alongside existing [mission types](../packages/protocol/src/index.ts),
store methods alongside `MissionStore`, and project admission/reference resolution in the service.
Reuse its transaction/replica and **await `durable()` before acknowledging writes**. Do not expose
the raw database. Do not automatically add these tables to shared/remote mission replication.

**Strictly passive reads:** GET/list/get/revisions read stored catalog bodies, link states and
check metadata only. They perform no reconciliation writes, source fanout, queue mutation, lazy
record creation, worker starts or provider calls. Refresh repeats these stored reads only. Current
source verification is a separate admitted #87 host operation, never a GET side effect.

| Proposed interface | Contract |
| --- | --- |
| `GET /api/projects/:projectId/knowledge?kind=&missionId=&q=&limit=&cursor=` | Summary rows only: ID/title/synopsis/kind/origin, revision, freshness and pending-task hint. Kind/mission filters optional; `q` is literal title/synopsis matching, not body/repository/semantic search. Default 25, max 50; explicit next cursor and `more`. Order by immutable creation time then ID descending. Cursor binds project/filters/last ordering tuple. Pages are observations, not an atomic snapshot; refresh restarts discovery of new entries. |
| `GET /api/projects/:projectId/knowledge/:id[?revision=N]` | Exact stored project entry/revision, source/relation locators and separately stored check/pending state. Omitted revision means current. Source availability is last reported or unknown, not probed here. Distinguish missing entry, loading/error and confirmed empty. A historical revision never inherits a newer revision's successful check. |
| `GET /api/projects/:projectId/knowledge/:id/revisions?cursor=&limit=` | Paged revision summaries, same 25/50 bound, no bodies or source fanout. Exact detail read opens a historical revision. |
| `POST /api/projects/:projectId/knowledge` and `PUT .../knowledge/:id` | Explicit create/append by an already admitted documentation writer; client operation ID, expected revision (0 on create), complete bounded payload. Same operation/same bytes returns its saved result; stale revision or reused operation/different bytes conflicts. No blind lost-ACK replay. This conveys no task/decision editing or execution grant. |
| `GET /api/missions/:missionId/knowledge/:id` | Stored link state and `linkRevision`, including unlinked tombstones. Never linked is `{linked:false, linkRevision:0}` without creating a row. Same-project admission; no body/source fanout. |
| `PUT /api/missions/:missionId/knowledge/:id` / `DELETE` same path | Coordinator/user links or unlinks same-project knowledge; PUT supplies explicit pin or `followCurrent:true`. Both require `expectedLinkRevision`; atomically compare the counter, mutate and increment it, returning the stored state/revision after durability. Unlink retains its tombstone; relink never resets the counter. Stale requests conflict even if the pin value matches again. No body changes. |

For example, pin A at link revision 1 → pin B at 2 → pin A at 3 must reject an unlink
captured at revision 1. Unlink at 3 leaves `{linked:false, linkRevision:4}`; relink becomes 5,
so the old unlink cannot remove the new link. This is one retained row/counter, not a new framework.

Agent access should be a thin supervised-IPC `knowledge` tool with `list/get/revisions` and explicit
`create/append`, using these same service checks, not agents calling loopback REST as user. Read-only
roles keep their current write restrictions: explorers can publish session-local research artifacts
and report findings; an authorized documentation writer registers them later. A documentation
assignment does not confer coordinator planning power. Linking stays coordinator-owned. #86 must
validate the caller seam and existing capability checks before exposing any writes, not infer them
from payload author/project fields. Pending-check mutation is host-internal, not an agent freshness claim.

**Access:** require the current canonical project and the caller's existing project/session access,
then recheck after asynchronous source reads. Cross-project linking is rejected in this slice.
Links do not grant transcript, filesystem, artifact or decision access; source opens use their own
existing admission. Current local HTTP is loopback, not hostile-process authentication. Desktop
retains current hello/lineage and selection-generation fencing, not a new security model. Archival
does not revoke project knowledge; current project/source restrictions still apply. No global memory,
private continuity state or unrelated project material is copied to make a citation readable.

**Separate source opens/checks:** explicit source opening or admitted #87 verification may reuse
passive mission detail/brief and exact artifact GETs above, not catalog GET handlers. They do not
subscribe/start a chat. Repository source inspection uses the caller's already authorized
[SourceReader](../packages/kernel/src/source-reader.ts); its current non-atomic ancestor limitations
remain. There is no existing project-document HTTP reader. Do not route a project path through an
arbitrary session's `/files`, start a worker, or fetch external pages to populate a knowledge view.
For #86, native readers show the useful retained research/component body and citations and can open
an explicit supported web source on user action. Local source opening may initially be unavailable;
that does not block reading the core entry or require a new file reader.

**Discoverability in apps/desktop:** Project overview → **Knowledge**, with **Components** and
**Investigations**, title/synopsis filter and **Needs a check** filter. Mission Overview → **Knowledge**
shows only its linked subset, with **All project knowledge** returning to the same project catalog.
An entry shows readable content first, related research/components and resulting decisions/tasks;
Sources/history disclose exact provenance. Keep a meaningful Needs a check reason and pending task
visible, not only in Details. Preserve selection/Back/keyboard access and retained-offline labeling
using existing reading-column/list patterns, not a new global sidebar or required taxonomy.
Task/report views can link to the same entry identity; worker context gets selected refs on demand,
never full-catalog prompt injection or a claim that relevance selection is authority.

## Freshness and bounded update flow

Freshness means **last checked against named sources within stated coverage**, never timeless truth.
Track `not_checked`, `checked`, `needs_check` independently of supersession and source availability.
An affected source change means Needs a check, **not automatically incorrect**. Keep prior checked
date/revisions/coverage while pending or failed; failed checks do not erase usable original research.

1. Register source dependencies when a writer saves an entry. Meaningful delivery, decision change
   or published research marks linked/dependent entries pending and unions trigger refs by project/entry.
   Use direct registered references and declared component path scopes, not every repository file.
   A delivery without usable changed-source scope leaves mapping coverage unknown for coordinator triage,
   not an invented claim that no documents are affected.
2. Persist the mark with the source mutation where both are in this store. For artifact/repository
   changes, notifications are hints: store observed source versions and pending marks durably on receipt.
   One pending generation per entry coalesces repeated triggers; no job per event/commit. Cap retained
   trigger detail at 64 refs and expose overflow as broader pending coverage, not silently dropped work.
3. #87 provides an admitted host-only `observeKnowledgeSources(projectId, entryIds)` operation,
   bounded to at most 50 entries and their registered refs per batch. Startup/reconnect observation
   and explicit reconciliation invoke that seam separately, never through catalog GET or Refresh.
   Cheaply compare registered source versions: current decision timestamps/text hashes,
   brief/artifact pointers, and one repository
   head/change-list observation where already available. Inspect only declared paths when necessary.
   Live uncommitted edits, external web changes and inaccessible sources may remain unchecked; show
   reconciliation coverage/date. Do not promise a complete changefeed from generic `onChange` callbacks
   or the newest page of events. Missed events must not require a full-repository model scan.
4. Coordinator batches one scoped documentation task for pending entries after related work settles,
   reusing an existing pending task. Cheap unchanged-source checks need no model. Provider work and
   repository writes still need ordinary admission/authorization; this proposal activates neither.
   Required contract/docs changes belong in the delivery's acceptance criteria and cannot be deferred
   past acceptance. Optional follow-up documentation may be asynchronous and stays visibly pending.
5. The writer checks only applicable sources and appends a correction, supplement or component revision,
   or records **checked, no content change**, with evidence/limits. Compare captured entry revision,
   source versions and pending generation before clearing pending; a newer event remains queued.
   Record the resulting revision/check outcome atomically. A source read failure stays pending with
   a reason, not checked or empty.
6. Tag catalog mutations/check results and documentation-task deliveries with a host-recorded
   documentation origin. These cannot launch more documentation tasks. A docs-only delivery updates
   relevant citation versions/marks without model fanout; it does not certify dependent conclusions.
   Mixed code/docs deliveries still trigger checks for changed code/decisions. Never suppress real
   changes merely because a commit message says docs. Do not use memory compaction as this scheduler.

This needs small pending rows and source comparisons, not a permanent agent, search platform or
new workflow engine. #87 owns admitted maintenance wiring after #86, including missed-event and
non-recursion tests. Reading/listing reveals stored pending work only, with no reconciliation,
source fanout, queue mutation, worker starts, provider calls or documentation writes.

## Two worked entries

### Investigation: public exploration patterns and remaining relationship gaps

Illustrative catalog entry, not an import performed by this change:

- **Question:** which exploration patterns should be reused, and can current tools compare retained
  callable relationships? Origin is this project's originating research mission. Register exact
  mission/task/session IDs only from recorded ownership, never infer them from a report title.
- **Original evidence:** [Empryo study at its delivered document commit](https://github.com/babariviere/pilot/blob/f17eea3d8fb5e5250b49a99af793d38abcf0b7a2/docs/empryo-code-exploration-evaluation.md),
  inspected 2026-10-30; it preserves public core `c27dac116d2ee1637abfc6634bebf08b5c379454`, original
  Pilot `fa9662723f3aaf2d57aefabab4c5c7cdec6f8726`, and separate refreshed Pilot `6149d396c0211eb16541c425cea869df7c2192ff`.
- **Findings:** observed source has candidate-vs-literal and unavailable-vs-empty pitfalls;
  saturation omissions are inferred, not an executed reproduction. Reuse composition/bounded discovery;
  persistent indexing is deferred. Negative result: no comparative/runtime/token-savings qualification;
  public v2 findings do not describe private v3. Preserve the license restriction and higher reported RSS.
- **Supplement:** [relationship evaluation](code-relationships-evaluation.md), source baseline
  `7222fe3e398855b34a43f17837d4c6d94a12009e`, delivered in `02c63ac74e3d62af597ef334a6a9271902cb7ceb`,
  inspected 2026-10-30. It recommends retained-input qualification before static-edge comparison.
  No retained graph provider existed at that observation. The earlier single-root-only gap was
  already superseded by the Empryo study's own delivered update, not silently rewritten now.
- **Consequences:** link originating research task #32 by recorded UUID
  `ba9e94d7-ea66-49b0-9df8-b6c904c24e9f`; D28 is decision
  `d73c781d-d4f8-43bc-a1ec-350576c2a032`, D29 is `c8f628e4-41dc-4a33-b723-4c4d7a23e779`
  in the originating mission. These establish direction, not empirical support for the findings.
  No new implementation task or approval is created by this example.
- **Freshness:** source-inspected as of those baselines; **not checked against today's implementation**.
  A later graph delivery marks the relevant gap Needs a check and links a pending task; the original
  study and its inconclusive outcomes remain readable after that mission is archived.

### Component: first-party code exploration

- **Home:** one project component entry, primary detailed contract [docs/code-exploration.md](code-exploration.md),
  observed at this proposal's audit baseline. A second mission links the same entry, not a copy.
- **Stored body, interfaces/architecture:** kernel native tools `code_search({query,path?,limit?,cursor?})`
  and `code_symbols({query?,path?,exact?,limit?,cursor?})` provide literal search and TS/JS declarations.
  `code_call_paths` traverses from an exact callable; `code_impact` accepts 1–8 roots in one shared
  graph scan. Source/graph workers use SourceReader for bounded admitted source reads. Result pages
  carry source identities, locations and partial coverage; fuller signatures stay in the cited manual.
- **Constraints/rationale:** source-inferred, not runtime or complete impact; live observations are
  non-atomic. One nearest-root witness is not all paths. Keep a single graph and no persistent index
  for the demonstrated scope, citing the investigation above rather than duplicating its conclusions.
- **Decision links:** D25 first-party tools, D28 call paths, D29 Review navigation, resolved by exact
  canonical IDs. Their current text controls applicability; the component cannot authorize retained
  analysis, broaden source access or turn a recommendation into approval.
- **Update example:** a later retained-analysis delivery queues only this component and related gap
  findings. The writer appends current interface/gap changes and a supplement to research as needed.
  Original snapshots remain; check metadata names the new exact sources and unchanged limitations.
  If no source was checked, display unknown coverage, not Current because the document was saved.

## Existing research and coordinator validation

Start with explicit links supplied by users/coordinator and newly delivered research. For older work,
record the known source/date verbatim, `origin unknown` where unproven, and `not_checked` coverage.
Do not reconstruct a conclusion from a task title, success receipt, memory summary, absent artifact
or chat silence. Link unfinished investigations as inconclusive/unknown. Do not migrate all history,
copy transcripts, regenerate missing reports or touch the unresolved general-docs handoff.

Before #86, coordinator validates: (1) four-table reuse and append-only research, (2) bounded passive
project reads and admitted writer/link seams, (3) project/mission navigation and unavailable local
source behavior, (4) examples and correction/freshness semantics, (5) #87 batching/reconciliation and
no recursion. D46 ownership is not reopened. Required future checks include archive survival,
cross-project refusal, exact pins/history, lost-ACK/CAS, negative research, pending-generation races,
passive GET/Refresh, link A→B→A and unlink/relink CAS, readable bodies without a file reader,
missed events and docs-only non-recursion. This delivery runs only document/source-link/whitespace
checks, not runtime tests; validation/publication of this proposal activates no catalog or jobs.

## Shipped slice

- **Storage:** the four tables above in `missions.sqlite`
  ([store](../packages/daemon/src/project-knowledge-store.ts)), written through MissionStore's
  transactions and replica. Writes await `durable()` before acknowledging, and HTTP and tool reads use
  the same barrier before and after reading; a durability failure fails the reply. Only mission deletion
  removes link rows; nothing removes entries.
- **HTTP** ([server](../packages/daemon/src/server.ts), [service](../packages/daemon/src/project-knowledge.ts)):
  the GET/POST/PUT routes in the table above, plus `DELETE /api/missions/:id/knowledge/:entry?expectedLinkRevision=N`.
  HTTP writes act for the local user. GETs read stored rows only. Types are in
  [protocol](../packages/protocol/src/knowledge.ts).
- **Validation:** investigation bodies need Markdown headings for Question, Findings (or Conclusions)
  and Limitations (or Unknowns); components for Purpose (or Boundary), Interfaces (or Architecture)
  and Constraints (or Gaps). Artifact, mission, and knowledge citations must exist in the same
  project at write time; repository paths must be relative and are not opened. Appends need a reason.
  An operation ID is project-scoped; its request hash covers target, author, origin and content.
- **Agent tool:** `knowledge` over supervised IPC ([tool](../packages/kernel/src/knowledge-tools.ts)),
  registered for writable project chats. pilotd derives identity and project from the session and
  refuses read-only roles and shared chats. Linking requires the caller to coordinate its own mission.
- **Check state:** `markPending` and `recordCheck` exist as host-internal store methods with
  generation CAS for later maintenance wiring; no route, tool or job calls them yet.
- **Native:** see [project knowledge in Pilot Next](../apps/desktop/docs/project-knowledge.md).
- **Not shipped:** automatic registration, source observation or freshness maintenance, bulk
  import of existing research, local source opening, knowledge in Ask chats, cross-project links.
