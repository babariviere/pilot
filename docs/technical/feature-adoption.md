# Feature-adoption catalog

Catalog version 1 answers whether three high-value workflows are available, discovered, attempted, successful and
used again. It does not record content or infer intent from absence.

| Feature | Eligibility | Exposure | Attempt | Outcome |
| --- | --- | --- | --- | --- |
| `diagnose_chat` | A non-diagnostics chat and its qualified host are available | The chat More menu shows **Diagnose this chat** | The user invokes it | The specialist is created, creation fails, is cancelled, or the host became unavailable |
| `devbox_chat` | A devbox is configured and connected; other states are reported explicitly | The new-chat destination presents the devbox | The user submits a chat for that devbox | Remote creation succeeds, fails, is cancelled, or becomes unavailable |
| `slack_triage` | Slack triage is configured and connected; other states are reported explicitly | The Slack triage board is opened | The user changes a local type, label, severity or status override | The change succeeds, fails, is cancelled, or becomes unavailable |

Every event has only `catalogVersion`, `feature` and `stage`, plus the fields required by that stage:

- `eligibility` requires `availability`: `available`, `not_configured`, `disconnected` or `unsupported`. `reason` is
  `none` for available and otherwise repeats that closed availability value.
- `exposure` and `attempt` have no additional attributes.
- `outcome` requires an outcome/reason pair: `success/none`, `cancelled/user`, `failure` with `rejected`, `transport`
  or `unknown`, or `unavailable` with one of the three unavailable reasons above.

Unknown fields and invalid combinations are rejected. There are no IDs, names, titles, paths, URLs, integration
identifiers, raw errors or open attribute maps. The event timestamp comes from its OpenTelemetry span. The
independent random `pilot.analytics.id` is added only by the consent-gated exporter; it is not part of this event.

## Analysis semantics

Use only cohorts with analytics enabled and healthy collector delivery. Missing events after revocation, queue
shedding or exporter failure are unavailable observations, not product behavior.

- **Undiscovered:** an `available` eligibility event with no exposure in the following seven days.
- **Unavailable:** an eligibility event whose availability is not `available`. Keep each reason separate.
- **Exposed, no attempt:** an exposure with no attempt in seven days. Call it exactly that, never “unwanted.”
- **Broken:** an attempt followed by `failure` or `unavailable`. Report both separately and keep cancelled attempts
  out of the failure rate.
- **Adopted:** a successful outcome.
- **Repeat use:** successful outcomes on at least two distinct UTC days in the 28 days after first success. Report
  day-1, day-7 and day-28 return rates with cohort counts.

Eligibility and exposure are deduplicated once per feature per app process. Attempt/outcome pairs represent explicit
user actions. Producers admit at most 128 feature events per process; overflow is dropped and counted by telemetry.
Do not add a remote `repeat` event: remote repeat use remains a cohort query over successful outcomes.

Raw analytics retention is a collector policy, not an app promise. A conservative deployment should retain raw
events for at most 30 days and derived aggregate cohorts for at most 90 days, then delete them. This recommendation
does not configure or deploy a backend. Revoking analytics immediately drops queued events and rotates the local
analytics identity, intentionally ending longitudinal linkage.

## OpenTelemetry mapping

The macOS app emits these events as `pilot.feature` spans only after both remote operational reporting and the
separate Product analytics setting are enabled on Local. Feature spans use an isolated tracer resource containing
`pilot.analytics.id`; they never contain `pilot.host.id` and never inherit an operational trace parent. Operational
spans never contain the analytics identity, and each tracer gets an independent `service.instance.id`.

The closed event fields map to `pilot.feature.catalog_version`, `pilot.feature.name`, `pilot.feature.stage`, and the
stage-specific `pilot.feature.availability`, `pilot.feature.outcome` and `pilot.feature.reason` attributes. The app
has no raw-event API. Revocation replaces both tracers, marks their bounded queues revoked before asynchronous
shutdown, and gets a rotated identity from the daemon before analytics can be enabled again.

## Private local evidence, independent of uploads

**Settings → Diagnostics → Local feature usage** is a separate opt-in, off by default. It permits only daily,
content-free counts from this Mac's existing closed UI catalog across chats. It works with both remote reporting
and product analytics off and does not change either upload setting. Counts describe observations in this Mac's UI,
including actions involving devboxes, not comprehensive activity on their execution hosts or other clients.
An enabled devbox without a native producer reports unavailable, not zero.

The app immediately aggregates eligibility, exposure, attempts and each closed outcome/reason separately. It never
retains a raw event log, chat/project identity, title, path, transcript, event timestamp or analytics ID. Eligibility
and exposure use their independent once-per-feature/process deduplication. Local counts are capped at 10,000
observations per UTC day; further observations increment a capped drop lower bound. The remote 128-event process
cap and remote deduplication are unchanged. This local aggregate cannot establish user cohorts or repeat-user rates.

At most seven UTC day buckets are retained, with at most 336 closed cells per producer and sixteen app-process
snapshots on the daemon, bounded to 1 MiB in a private 0600 file. A single next-midnight expiry timer removes old
buckets even while idle. Startup also prunes before reading; there is no periodic network polling. Cumulative
snapshots are coalesced on activity, with at most one native delivery in flight; revision/epoch fencing deduplicates
lost acknowledgements and prevents pre-clear or pre-revocation data from returning. Pending app counts stay bounded
in memory while disconnected, may be lost on app exit, and are retried on later activity or verified reconnect only.

Disabling local collection deletes its retained aggregates and clears the native accumulator. **Clear local
diagnostics** deletes them too and rotates the collection epoch; neither action deletes chats, changes budget
settings, enables uploads or stops work. Native capability/installation/connection fences apply to delivery.

Diagnostics can read the host aggregate in app health or page `diagnostic_context` with `action: "features"`.
`query` optionally selects one exact catalog feature, `since`/`until` select inclusive UTC days, and the qualified
`host` selects a trusted available host through the existing read-only courier. Results expose the catalog, observer
scope, requested/retained time windows, enable/clear epoch start time, observed-from/through bounds, retained producer
count, producer-cap pruning, and retained-producer reported drops. Drop values are capped lower bounds and are not
time-filtered; drops in unobserved/evicted processes are unknown. Coverage is always partial. Disabled, missing
producer, failed storage, offline, out-of-retention and dropped observations are explicit gaps. Only positive observed
cells are returned. A missing feature/stage/day is unknown, **never zero** and never evidence of disinterest or success.
