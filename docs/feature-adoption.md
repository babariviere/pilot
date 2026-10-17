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
Do not add a `repeat` event or a persistent counter because repeat use is a cohort query over successful outcomes.

Raw analytics retention is a collector policy, not an app promise. A conservative deployment should retain raw
events for at most 30 days and derived aggregate cohorts for at most 90 days, then delete them. This recommendation
does not configure or deploy a backend. Revoking analytics immediately drops queued events and rotates the local
analytics identity, intentionally ending longitudinal linkage.

## OpenTelemetry mapping

The macOS app emits these events as `pilot.feature` spans only after both remote operational reporting and the
separate Product analytics setting are enabled on Local. Feature spans use an isolated tracer resource containing
`pilot.analytics.id`; they never contain `pilot.host.id` and never inherit an operational trace parent. Operational
spans never contain the analytics identity.

The closed event fields map to `pilot.feature.catalog_version`, `pilot.feature.name`, `pilot.feature.stage`, and the
stage-specific `pilot.feature.availability`, `pilot.feature.outcome` and `pilot.feature.reason` attributes. The app
has no raw-event API. Revocation replaces both tracers, marks their bounded queues revoked before asynchronous
shutdown, and gets a rotated identity from the daemon before analytics can be enabled again.
