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
