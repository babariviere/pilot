# Logical mission producer fixture

`logical-mission-producer.json` is captured by `scripts/test-native-mission-producer.test.ts`
from the actual loopback dashboard HTTP route backed by `ControlPilot`, using disposable faux
state. The Node test checks route/service equality, resource-filter independence and the saved
payload on every run. It never reads history, starts a worker or contacts a real devbox.

Refresh deliberately after reviewing producer changes, never by hand-editing the JSON:

```sh
PILOT_REFRESH_MISSION_FIXTURE=1 node --test --test-force-exit scripts/test-native-mission-producer.test.ts
```

The former `LogicalMissionCatalogTests.swift` consumer is removed with the Swift GUI.
The producer test still checks the saved payload. Keep this backend fixture, the
workspace-terminal harness and the loopback WebSocket fixture independently of the old app.
