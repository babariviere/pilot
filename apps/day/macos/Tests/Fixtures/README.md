# Historical logical mission fixture

`logical-mission-producer.json` records the former cross-host dashboard with synthetic data.
The corresponding Swift consumer was removed with the GUI. The current
`packages/daemon/src/native-mission-producer.test.ts` checks a Local-only catalog against the live
loopback route in a temporary profile. It does not regenerate the historical fixture.
