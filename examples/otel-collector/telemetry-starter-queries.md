# Telemetry starter queries

These templates use a conventional `spans` view with `name`, `start_time`, `duration_ms`, `resource_attrs` and
`span_attrs`. Adapt the JSON access syntax to the chosen OTLP backend. Keep release and counts in every latency view,
and apply a minimum cohort threshold before sharing analytics results.

## Interaction latency and failure by release

```sql
SELECT
  resource_attrs['service.version'] AS release,
  name,
  count(*) AS observations,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms,
  sum(CASE WHEN span_attrs['pilot.outcome'] <> 'success' THEN 1 ELSE 0 END) AS non_success
FROM spans
WHERE name IN ('pilot.message.send', 'pilot.chat.open')
GROUP BY 1, 2;
```

Break a slow trace down by `pilot.phase`, but never group a metric by trace, session or host ID.

## Completed tool duration and outcome

The tool reliability slices add `pilot.tool.call` with a safe `pilot.tool.category`. Categories are a closed enum;
arbitrary built-in/MCP names and arguments are not labels.

```sql
SELECT
  resource_attrs['service.version'] AS release,
  span_attrs['pilot.tool.category'] AS category,
  span_attrs['pilot.outcome'] AS outcome,
  count(*) AS observations,
  percentile_cont(0.50) WITHIN GROUP (ORDER BY duration_ms) AS p50_ms,
  percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95_ms,
  percentile_cont(0.99) WITHIN GROUP (ORDER BY duration_ms) AS p99_ms
FROM spans
WHERE name = 'pilot.tool.call'
GROUP BY 1, 2, 3;
```

Query `pilot.tool.cancel_wait` separately to find tools that ignore cancellation. Keep `failure`, `timeout`,
`cancelled`, `interrupted` and `unavailable` distinct. A completed span cannot answer whether a currently unfinished
call is stuck. Use the bounded local diagnostics projection for active age, time since real progress and time since
liveness; liveness is not progress and age alone is not proof of deadlock.

## AI context and cache efficiency

Cache efficiency uses only spans with an observed consecutive input change. Keep the numerator, denominator and
observation count visible rather than treating missing first reports as zero reuse.

```sql
SELECT
  resource_attrs['service.version'] AS release,
  span_attrs['pilot.ai.scope'] AS scope,
  sum(span_attrs['pilot.ai.cache_read_tokens']) AS cache_read_tokens,
  sum(span_attrs['pilot.ai.input_tokens']) + sum(span_attrs['pilot.ai.cache_read_tokens']) AS denominator_tokens,
  sum(span_attrs['pilot.ai.input_growth_observation_count']) AS observations,
  100.0 * sum(span_attrs['pilot.ai.cache_read_tokens']) /
    nullif(sum(span_attrs['pilot.ai.input_tokens']) + sum(span_attrs['pilot.ai.cache_read_tokens']), 0) AS cache_efficiency_pct
FROM spans
WHERE name = 'pilot.ai.usage'
  AND span_attrs['pilot.ai.scope'] IN ('direct', 'child')
  AND span_attrs['pilot.ai.input_growth_observation_count'] > 0
GROUP BY 1, 2;
```

For current context pressure, query session-scope observations and report counts with percentiles of
`pilot.ai.context_percent_millis / 1000`. These are latest point observations, not time-weighted occupancy.

Catalog estimate per observed successful outcome is a cost proxy, not billed or marginal subscription spend and not
a quality score. Keep partial estimates separate and include the success denominator.

```sql
SELECT
  resource_attrs['service.version'] AS release,
  span_attrs['pilot.ai.scope'] AS scope,
  span_attrs['pilot.ai.estimate_status'] AS estimate_status,
  sum(span_attrs['pilot.ai.estimated_usd_micros']) AS estimated_usd_micros,
  sum(span_attrs['pilot.ai.success_count']) AS observed_successes,
  sum(span_attrs['pilot.ai.estimated_usd_micros']) /
    nullif(sum(span_attrs['pilot.ai.success_count']), 0) AS estimated_micros_per_observed_success
FROM spans
WHERE name = 'pilot.ai.usage'
  AND span_attrs['pilot.ai.scope'] IN ('direct', 'child')
  AND span_attrs['pilot.ai.estimated_usd_micros'] IS NOT NULL
GROUP BY 1, 2, 3;
```

An observed success is a completion signal only. It does not establish correctness, acceptance or user value.

Compaction evidence similarly keeps its paired-measurement denominator:

```sql
SELECT
  resource_attrs['service.version'] AS release,
  sum(span_attrs['pilot.ai.compaction_count']) AS observed_compactions,
  sum(span_attrs['pilot.ai.compaction_paired_count']) AS paired_measurements,
  sum(span_attrs['pilot.ai.compaction_removed_tokens']) AS tokens_removed_in_pairs
FROM spans
WHERE name = 'pilot.ai.usage'
  AND span_attrs['pilot.ai.scope'] = 'session'
GROUP BY 1;
```

Do not divide removed tokens by all compactions. Only paired measurements have before/after context, and no
compaction duration is available.

## Worker relaunches and context preparation

```sql
SELECT
  resource_attrs['service.version'] AS release,
  span_attrs['pilot.ai.launch_reason'] AS reason,
  sum(span_attrs['pilot.ai.launch_count']) AS launches
FROM spans
WHERE name = 'pilot.ai.usage'
  AND span_attrs['pilot.ai.launch_reason'] IS NOT NULL
GROUP BY 1, 2;
```

Query `pilot.ai.prepared_context_count` and `pilot.ai.prepared_context_tokens` separately by release. The schema does
not export a chat identifier, so it cannot join an individual launch to a later context observation or reconstruct
per-chat relaunch sequences. Relaunch cost and compaction timing are unavailable, not zero. The launch reasons are
observed lifecycle classes and never trigger restart or recovery behavior.

For a release-level relaunch rate, exclude `initial` and divide by observed direct requests rather than installations
or chats, which operational telemetry intentionally cannot identify:

```sql
WITH relaunches AS (
  SELECT resource_attrs['service.version'] AS release,
         sum(span_attrs['pilot.ai.launch_count']) AS relaunches
  FROM spans
  WHERE name = 'pilot.ai.usage'
    AND span_attrs['pilot.ai.launch_reason'] IS NOT NULL
    AND span_attrs['pilot.ai.launch_reason'] <> 'initial'
  GROUP BY 1
), requests AS (
  SELECT resource_attrs['service.version'] AS release,
         sum(span_attrs['pilot.ai.activity_count']) AS observed_requests
  FROM spans
  WHERE name = 'pilot.ai.usage' AND span_attrs['pilot.ai.scope'] = 'direct'
  GROUP BY 1
)
SELECT relaunches.release, relaunches.relaunches, requests.observed_requests,
       100.0 * relaunches.relaunches / nullif(requests.observed_requests, 0) AS relaunches_per_100_requests
FROM relaunches JOIN requests USING (release);
```

Both sides are partial daemon observations. This release cohort cannot prove that a relaunch wasted work or changed
quality.

## Adoption funnel

Only include spans with a consent-gated `pilot.analytics.id`. Do not substitute operational host or trace IDs.

```sql
SELECT
  span_attrs['pilot.feature.name'] AS feature,
  span_attrs['pilot.feature.stage'] AS stage,
  coalesce(span_attrs['pilot.feature.availability'], span_attrs['pilot.feature.outcome'], '-') AS detail,
  count(DISTINCT resource_attrs['pilot.analytics.id']) AS installations
FROM spans
WHERE name = 'pilot.feature'
GROUP BY 1, 2, 3;
```

Keep `not_configured`, `disconnected` and `unsupported` separate. Available without exposure means undiscovered only
when delivery is known complete. Exposure without attempt is not evidence that a feature is unwanted. An attempt
followed by failure is broken use, while unavailable and cancelled are separate denominators.

## Repeat use

```sql
WITH successful_days AS (
  SELECT
    resource_attrs['pilot.analytics.id'] AS analytics_id,
    span_attrs['pilot.feature.name'] AS feature,
    date_trunc('day', start_time) AS use_day
  FROM spans
  WHERE name = 'pilot.feature'
    AND span_attrs['pilot.feature.stage'] = 'outcome'
    AND span_attrs['pilot.feature.outcome'] = 'success'
  GROUP BY 1, 2, 3
)
SELECT feature, count(*) AS adopted,
       sum(CASE WHEN used_days >= 2 THEN 1 ELSE 0 END) AS repeated_on_another_day
FROM (
  SELECT analytics_id, feature, count(*) AS used_days
  FROM successful_days
  GROUP BY 1, 2
) cohorts
GROUP BY 1;
```

For day-1/day-7/day-28 retention, cohort by the first successful UTC day and report cohort counts. Identity rotation
on revocation intentionally ends the sequence. Recommended raw-event retention is at most 30 days and aggregate
cohort retention at most 90 days; no example here deploys or enforces a backend retention policy.
