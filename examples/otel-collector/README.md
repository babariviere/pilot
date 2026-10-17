# Local OTLP collector example

This is a vendor-neutral, loopback-only OpenTelemetry Collector for evaluating Pilot's explicitly opted-in export.
It does not create an account, deploy a service or enable Pilot's settings. The collector image is pinned to 0.162.0
and accepts OTLP/HTTP on `127.0.0.1:4318`. It has a 128 MiB memory limiter and 512-span maximum batch. Its file
exporter rotates at 10 MiB and keeps at most three backups for seven days in a Docker-managed volume.

```bash
cd examples/otel-collector
docker compose run --rm collector validate --config=/etc/otelcol-contrib/config.yaml
docker compose up -d
docker compose logs -f collector
```

In Pilot's local Diagnostics settings, explicitly enable remote operational reporting and use
`http://127.0.0.1:4318/v1/traces`. Enable product analytics separately only if you intend to evaluate the cataloged
events. Pilot does not read generic `OTEL_*` environment variables or accept exporter headers.

Stop collection and delete the local volume with:

```bash
docker compose down -v
```

The file exporter writes newline-delimited OTLP/JSON to `pilot-traces.json` inside the `pilot-otel-data` volume.
The file exporter is an alpha Collector component and is for local evaluation, not a production retention system.
To inspect a copied file with only the Python standard library:

```bash
python3 query_traces.py distributions pilot-traces.json
python3 query_traces.py adoption pilot-traces.json
```

The reader ignores content fields and groups only reviewed release, outcome, feature and safe tool-category fields.
It reports counts with percentiles and unique-installation counts. Small cohorts remain identifiable even under a
pseudonym, so do not publish row-level output or low-count groups.

Completed OTLP spans cannot reveal a call that has not ended. After the tool-call diagnostics schema lands, save a
bounded diagnostic response and inspect live age separately:

```bash
python3 query_traces.py live-tools diagnostics.json
```

That command reads only `tool.in_flight` evidence and prints safe category, active/progress/liveness ages, state and
whether the call is nested. It does not infer that an old call is dead or recommend automatic retry.

See [starter queries](../../docs/telemetry-starter-queries.md) before adapting this example to a backend. Keep the
collector close to each host; a devbox should export to its own loopback collector rather than relay through a Mac.
