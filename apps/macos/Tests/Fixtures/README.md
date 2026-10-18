# Logical mission producer fixture

`logical-mission-producer.json` is captured by `scripts/test-native-mission-producer.test.ts`
from the actual loopback dashboard HTTP route backed by `ControlPilot`, using disposable faux
state. The Node test checks route/service equality, resource-filter independence and the saved
payload on every run. It never reads history, starts a worker or contacts a real devbox.

Refresh deliberately after reviewing producer changes, never by hand-editing the JSON:

```sh
PILOT_REFRESH_MISSION_FIXTURE=1 node --test --test-force-exit scripts/test-native-mission-producer.test.ts
```

`LogicalMissionCatalogTests.swift` consumes these same payloads and tests compatibility with only
the additive logical-list/total fields removed. Cases cover aliased home labels, distinct homes,
archived canonical precedence, complete/incomplete and tied sequences, the provenance cap,
task-only/provisional evidence, self-replicas without a definition and clipped identity totals.
The JSON is outside SwiftPM test source directories so it is not an unhandled target resource.
