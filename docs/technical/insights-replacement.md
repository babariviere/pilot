# Confirmed deleted-report replacement

This does not diagnose a real deletion or activate real resources. The desktop confirmation is
described under [Native confirmation](#native-confirmation-desktop). User-reported deletion and
missing metadata are not proof that old authority,
admitted work or entered effects are gone. Existing [enable](insights-enable.md),
[settings/Apply](insights-settings.md), [history](insights-history.md) and [review](insights-review.md)
contracts still apply. Existing frozen payloads and receipts stay unchanged.

## Native sequence

1. Require `hello.capabilities.insightsReplacement:1`, `insightsEnable:1` and pinned daemon/lineage.
   Keep exact project, backlog and unavailable report IDs. Do not clear pins, use titles, create a
   backlog or generate a successor UUID in the client.
2. Passive `GET /api/insights/replacement/preflight?projectId=P&missionId=M&reportSessionId=OLD`
   returns `InsightsReplacementPreview`. Optional `model` and `thinking` select an exact configured
   fresh model. The default uses the existing unique Terra 6.1 name resolver, never a provider/Pi/
   project fallback. Missing/ambiguous models refuse or require an explicit configured choice.
3. Confirm only `state:"ready"`, `coverage:"bounded"`, non-null payload. One compact confirmation
   shows old ID, exact rule IDs/revisions/dispositions, a separate new report and **effective**
   `payload.enable` values. These are fresh fixed defaults, not copied old desired settings:
   Friday 18:00 Europe/Paris; local admitted cross-project/archive read-only scope; partial 1/2/4
   sampling; selected-provider processing; advisory approximately $5/report; unknown pricing/spend.
   No immediate review, global Automations opt-in or copied/rebound grant. The new rule starts at the
   next strictly future occurrence when created, not a stale preview date.
4. Freeze `payload` verbatim as UTF-8 JSON in the existing private durable writer, kind
   `insights-replace`, `targetId:payload.successorSessionId`. Keep hash, operation ID, producer,
   sequence, origin and destination. Persist before one native-gated `POST /api/operations` with
   `x-pilot-github-capability`, including exact re-admission. `expectedHome` stays verbatim, including
   hostId; native envelope hostId may be `local` at the daemonId + lineageId envelope seam.
5. Lost/malformed ACKs stay Unknown. Passive `POST /api/insights/replacement/status` takes the same
   complete envelope, no capability token required. Pending/accepted/rejected use status only.
   Only an unknown receipt permits re-admission of the **same** native-confirmed envelope. Absence
   is a read-point observation, not proof of no effect. Never replace its ID or bytes.

All reads are no-store. Missing required parameters: 400; unknown project/backlog: 404; wrong/inactive
backlog: 409; wrong method: 405; unavailable service: 503. Existing journal conflicts, retirement and
destination fences apply. Automations must already be on. Reads never start workers or read source
history, full operation payloads, saved rule prompts, grant secrets, arbitrary paths or another backlog.

## Schemas and pins

Types are in `packages/protocol/src/insights.ts`:

- Preview: `{projectId,missionId,oldSessionId,state,reason,coverage,references,rules,supersession,
  payload,nextAt,model,cost}`. State: `ready|blocked|replaced`; coverage: `bounded|overflow|unavailable`.
  Bounded describes this observation, not complete discovery/deletion proof. Cost:
  `{pricing:"unknown",spendUsd:null}`.
- References: at most 32 non-rejected retained `{operationId,kind,targetId,state,payloadHash}` entries.
  Rejected receipts stay stored but grant no authority. Unreadable journal/authority or overflow refuses.
- Rules: at most eight `{id,revision,digest,title,trigger,state,paused,targetSessionId,recurrence,
  disposition}` projections. Digest is SHA-256 of host-canonical full-row JSON, including saved prompt
  and run identity without disclosing them. Disposition: `cancel|keep|blocked`. Integration-owned pending
  rules, including paused ones, use exact row/revision cancellation CAS; terminal rows stay. Manual,
  dispatching, mismatched or uncertain rules refuse. Foreign bindings disclose no rule contents.
- Payload: `{projectId,missionId,expectedHome,context,oldSessionId,successorSessionId,
  expectedReplacementRevision:0,references,rules,enable,disclosure:"insights-replacement-v1"}`.
  `enable` is exact fresh fixed `InsightsEnablePayload`, chat/schedule null, no settingsRevision.
  Context hashes local storage home, exact host, project/path and backlog. The successor is a stable,
  distinct host-derived UUID from context + old ID, never from an attempt ID.
- Receipt: standard `{operationId,payloadHash,destination,targetId,state,result?,reason?}`. Result:
  `InsightsReplacementProgress` `{phase,oldSessionId,sessionId,scheduleId,chat,cancelledRules:
  [{id,revision,digest}]}`. Chat is null until committed passive-create identity is acknowledged.
  Accepted phase is `replaced`, not review success or benefit proof.
- Status: `{receipt,state,reason,supersession,sessionId,scheduleId,nextAt}`. State:
  `not_found|unknown|partial|blocked|replaced`. Current Stop/authority/rule changes can block accepted
  operations. Durable completion beside a pending receipt does not accept that receipt. Keep the
  attempt and Check. Reads never settle/promote journal state.
- Supersession: `{oldSessionId,successorSessionId,projectId,missionId,context,revision,state}`.
  Revision 1 / `fenced` means denial/ownership only. Revision 2 / `replaced` is exact durable
  transaction completion, not resource-value equality. No old record or identity is rewritten.

Native checks the complete payload and keeps both pins. Send/status results must match exact
operation/hash/destination/target and both frozen IDs. Phase markers are not success. After restart,
adoption from passive preflight requires a revision-2 replaced link for exact old/project/backlog/
context. Re-read the successor's admitted settings snapshot; validate project/backlog/context,
expectedHome against pinned hello and chat ID. Discard stale replies after identity/hello changes.
A fenced link cannot authorize adoption. Preserve old attempts/receipts and historical outcomes.
Ordinary enable explicitly pinned to the old ID refuses `report_superseded_use_replacement_status`.
Unpinned enable discounts old references only through completed exact-context links to its one
currently admitted successor, never through pending links or missing metadata.

## Authority and recovery

An accepted retained enable (or completed replacement) must qualify old project/backlog, home/context
and host. Create-only/rule-only references lack immutable home evidence and refuse
`old_identity_home_unqualified`. Missing/retired references, unavailable storage and user-reported
deletion are not enough. The reported real incident may still receive an actionable refusal.

The exact old storage directory must be absent, not skipped by the index. Existing/unreadable/
symlinked storage refuses. No old worker/startup/save/delivery/configuration/create/backlog/accounting/
history call may remain admitted. Active or uncertain reviews (`preparing|ready|sent|unknown|interrupted`)
refuse. The host conservatively waits while any review dispatch drains. Pending old create/enable/
Save/Apply/delivery or other exact-old operations and ambiguous same-backlog references refuse without
settling receipts. Stop alone is not executor-quiescence proof.

Before successor admission, an existing `missions.sqlite` transaction saves an append-only old-ID
deny/operation-ownership fence, then waits for durability. Old grant admission, restored metadata and
automatic create recovery consult it. Old IDs cannot be recreated as ordinary chats or new schedule
targets. New report creation in this backlog must belong to the exact successor/operation. Unique
old/successor/operation keys plus synchronous scope ownership prevent duplicates. Marker-less concurrent
contenders entered no effect: scope ownership/CAS selects one; passive preview still refuses pending
replacements. Entered competitors refuse. Old findings/settings/run receipts/memberships/journal bytes
stay. Fences survive backlog deletion (no cascade). Capacity: 1,024 links, 16/backlog; no eviction.
Steady-state admission denial uses a limited in-memory ID set.

| Phase | Recovery authority |
| --- | --- |
| `fence_pending` | Exact operation/hash transaction lookup. Missing receipt stays pending; never re-enter. |
| `fenced` | Recheck old absence/quiescence, references, home/context and rules before unentered cancellation. |
| `cancel_pending` | Status-only after interruption/lost ACK. No exact downstream cancel receipt exists. Cancelled values never settle it. |
| `rules_fenced` | Exact live cancel ACK digests (or no rules); revalidate before unentered passive create. |
| `chat_pending` | Lookup only: exact createOperationId, committed grant/model, revision 1, Stop/input generation zero. Absence never recreates. |
| `chat_ready` | Committed chat ACK; revalidate before unentered next-occurrence rule creation. |
| `schedule_pending` | Lookup only: stable rule ID, operation owner, revision 1, empty runs, cadence/destination. Absence never creates. |
| `replaced` | Exact final transaction receipt; recovery returns it without effects. |

References, catalog availability, home/context, old absence/quiescence, rule digests/CAS and successor
grant/Stop/idle are rechecked at effect boundaries. Busy/failed schedule storage refuses a stale cache.
Changed/disappeared cancellation ACK rows block later steps. Stop on the successor blocks recovery/
scheduling, also after restart. Post-entry failures keep partial resources pending, with no rollback,
unpause, regrant, clearing or provider input. Recovery cannot replay entered effects.

## Native confirmation (desktop)

`apps/desktop/src/insights_replace.rs` parses preview and status strictly: exact keys, the selected
project/backlog and old ID, the pinned daemon/lineage home, and a payload equal to the observation it
summarizes. The nested `enable` must be fresh (chat and schedule null, no `settingsRevision`); no
`blocked` rule may be confirmed. `insights_replace_view.rs` is a step inside the existing Weekly
Insights panel. **Replace report chat…** takes Enable's place at the enable blocker only when the pinned
preflight refused exactly one known report as `report_identity_unavailable` or
`report_superseded_use_replacement_status`, the pinned hello has `insightsReplacement:1`, and the ID
has the host's UUID form. An older Local keeps the unchanged, disabled Enable.

- Opening reads the preflight for that exact project/backlog/old ID. Ready shows the old chat, cancelled
  rules (kept ones are counted as history), the new empty chat, the effective schedule and first report
  (at the earliest), model and thinking, provider processing, read scope, partial sample and advisory
  budget. Details show both full IDs. Blocked, overflow and unavailable show the reason with **Check
  again**; blocking rules are named; an ambiguous model offers an exact choice. **Back** or Escape leaves.
- **Replace report chat** freezes the payload verbatim in the private writer, slot `replace:<old>`, kind
  `insights-replace`, persisted before one native-gated POST. A late preview never replaces it.
- **Check** reads status first; only an `unknown` receipt resends the same envelope. Pending markers are
  status-only. **Replaced** beside a pending receipt keeps Check and is not acceptance. Receipts and
  results must name the exact operation, hash, destination and target, both frozen IDs, this target's
  committed chat and only planned cancellation ACKs. A rejection returns to the step with a fresh preview.
- Pins: the backlog's known report identities move old → successor only from an accepted receipt with
  phase `replaced`, or a revision-2 link adopted after the successor's settings snapshot names the same
  successor, project, backlog and context on the pinned home (kept in the open panel only). Fenced links,
  pending receipts, status values and a changed preflight target never move a pin. The old enable
  attempt and every replacement attempt stay in the private book.

Verification: `insights_replace_tests.rs` (8 tests: exact freeze, malformed/stale/foreign previews,
fence versus completion, attempt round trip, exact progress and status, adoption re-read, reasons) and
the hidden mounted `insights_replace` probe (`cargo test --features native-probes --test
insights_replace`, synthetic Local only). Its interactions run at 1100 light: blocker, passive
preview, Escape back with focus kept, stale and overtaken previews, exact payload, lost ACK, close and
restart without replay, same-envelope Check, status-only pending steps, completion beside a pending
receipt, acceptance and pin transition, navigation, an unqualified old home, an untrusted rule, a
malformed copied grant, a fence-only link, mismatched and exact successor adoption, an older Local and
rejection. 680 light/dark and 1100 dark are render-only. Limits: headless macOS TestPlatform evidence,
not OS IME/accessibility, Linux/Wayland, live Local, a real deletion, rules or models.

## Synthetic host checks

`insights-replacement.test.ts` uses temporary homes, real metadata/SQLite, faux catalog and a worker
factory that throws on every start. Coverage includes deletion versus missing index/storage, exact
identity/home/disclosure, pending old operations, admitted work/reviews, rule drift, concurrency,
chains, overflow, Stop, native HTTP and lost ACKs before/after fence/cancel/chat/rule/final transactions
with restart. Assertions check old receipts, no duplicate chat/rule, no replay and zero worker starts.
Adjacent enable/settings, journal, review/backlog and scheduler tests remain applicable. This is not
live diagnosis, native UI acceptance, a broad suite pass, real history/provider/scheduling, report
quality or realized-benefit evidence.
