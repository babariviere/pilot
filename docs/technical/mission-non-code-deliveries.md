# Non-code delivery foundation

The daemon has an internal, unaccepted non-code submission record. It is not exposed
as a mission action or HTTP endpoint and does not complete a task, accept evidence,
retire a member, or assert that code was reviewed or merged. A report can be saved
as an artifact and pinned to the task. The other supported reference is the current
mission brief revision. References are explicit and versioned; checks and limitations
are supplied by the submitter, not verified assertions.

`MissionService.saveNonCodeDelivery` is the submission seam: it validates the
caller and artifact access/identity, then the store rechecks the task, current brief,
and task-scoped artifact pins after asynchronous reads. The service waits for local
mission-store durability before returning. One immutable record per task allows exact
retries; a different record conflicts. Revalidation may refuse a retry after access
or an artifact link is removed. This record is separate from existing completion
receipts and is not included in shared mission projections.

Future activation must define revision-specific acceptance and required code,
review, PR, and check gates before connecting this seam to completion or lifecycle
effects. It must revalidate references and authorization at acceptance, handle
concurrent changes, and address shared-host projection and desktop presentation.
The existing legacy code receipt validates only the shape of its 40-hex commit;
it does not verify that the commit exists or landed.

See [acceptance prerequisites](non-code-acceptance-prerequisites.md) for the source-grounded
completion routes, zero-code evidence requirements and bounded implementation proposals.
That plan activates nothing and does not adopt legacy missions.
