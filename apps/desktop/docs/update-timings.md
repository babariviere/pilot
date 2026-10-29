# Update restart critical path

The update download, signed archive validation and first extraction finish while
the app is open. Restart preparation/checkpointing also happens before quit.
Blackout starts only when the old GUI exits. It ends when the new GUI appears,
which is distinct from its later exact durable startup acknowledgement.

## Deadline audit

These are failure bounds, not unconditional sleeps:

- GUI checkpoint: 15 seconds, refuses without the exact writer acknowledgement.
- Helper readiness: macOS 120 seconds including pre-quit full extraction/sync;
  Linux 30 seconds. The GUI remains open, with restart editing/admission fences.
- Helper COMMIT receipt: 30 seconds, lost receipt remains Unknown.
- Helper COMMIT input: 60 seconds, EOF/ordinary quit without COMMIT aborts.
- Parent exit: 120 seconds, native kqueue NOTE_EXIT, never PID polling or killing.
- Native relaunch command: 15 seconds, 10ms owned-command completion spacing.
- External Local identity read: 2s connect / 5s request.
- Retained owner reads: 1s connect / 5s request (prepare request up to 15s).
- Managed reservation: nonrenewable 180 seconds, verified again after parent exit.
- Bundled startup validation/launcher: 45 seconds, with separate 2s cleanup bound;
  Node launcher has 20s overall / 10s preactivation and 100ms readiness spacing.

None explains a mandatory one-minute blackout. Runtime activation/publication and
loaded application state are separate from the minimal updater fixture below.
Do not infer that the user's reported minute is proven or fixed from this fixture.

## Preparation moved before quit

The macOS helper freshly authenticates/extracts/syncs `install-payload` before
READY, independently of the earlier download-stage preview. It keeps the exact
bounded closed-tree digest only in memory, never in a mutable journal. After
COMMIT and kqueue-confirmed parent exit it still authenticates the signed archive,
rehashes every path/mode/byte/link (including unsealed extras), verifies the native
signature and source, and rechecks the owner/lease or external identity pin before
the unchanged atomic exchange and durable relaunch intent. Old bundles/receipt ACK
and Unknown/no-repeat behavior are unchanged. Linux keeps its existing extraction
path; this work does not qualify Linux or change its native lifecycle.

macOS helper readiness allows 120s instead of 30s because full extraction/sync now
precedes READY. That bound is not a sleep and occurs before quit. No COMMIT receipt,
parent-exit, reservation or startup safety deadline is shortened or extended.
An interrupted prepared helper cannot resume by trusting stored digest evidence.

## Isolated native measurement

```sh
python3 apps/desktop/scripts/verify_update_lifecycle.py --timings
```

This builds synthetic-key helpers and hidden LSUIElement temporary minimal apps,
uses owned faux Node daemons and runs three app-only update lifecycles. Each bundle
contains the test executables, Node and 4,096 synthetic 128-byte resource files.
It exercises real Security verification, signed archive extraction/file syncing,
OS parent exit, atomic swap, Launch Services relaunch and exact startup ACK.
No installed app, real profile, production feed or signing key is read or changed.

The optional `lifecycle-timings` feature emits fixed phase labels and numeric
monotonic seconds only. Normal builds emit no phase diagnostics. The fixture also
records numeric cross-process monotonic markers, not process identities or user
data. Its immediately-before-exit marker and observer's 20ms polling bracket real
exit. Reported blackout intervals are **upper bounds**, not exact window paint
timings. Relaunch entry and durable ACK are measured independently. Compilation,
fixture assembly/signing and polling after ACK are excluded from blackout.

The private temporary report retains source/binary fingerprints and observations;
qualification refuses source changes while running. These are fixture records,
not production install acceptance or evidence of the actual user's elapsed time.
Full GUI startup, payload sizes, cache state and host load can differ substantially.
Refusal fixtures wait for positive release of the helper's inherited target lock,
not a fixed sleep or a transient journal phase, before inspecting final evidence.
The faux daemon stays alive through that boundary so owner death cannot mask an
expired-reservation refusal. The default run also tests post-READY payload tampering.

## Measured fixture results (macOS arm64, unoptimized dev builds)

Three independent temporary app-only fixtures per version, on the same host and
same 4,096-resource workload. All six completed with exact StartupAcknowledged,
unchanged daemon/capsule identity and retained rollback bundle. These are measured
upper bounds to **minimal fixture entry**, not painted GPUI windows:

| Seconds, run 1 / run 2 / run 3 | Before | After |
| --- | --- | --- |
| Exit marker → new process entry | 21.833430 / 18.201018 / 30.104552 | 9.894187 / 9.867284 / 14.884819 |
| Exit marker → durable startup ACK | 22.240149 / 18.598653 / 30.581652 | 10.294658 / 10.293899 / 15.317797 |
| Pre-quit preparation (includes initial stage) | 17.872428 / 18.359480 / 19.873998 | 40.925479 / 41.739968 / 43.514429 |
| Post-exit extract/sync | 16.392874 / 12.821217 / 23.796782 | moved before quit |
| Post-exit exact closure hash | not needed after fresh extraction | 4.263619 / 4.351153 / 8.011371 |

Median exit→entry upper bound: **21.833430s → 9.894187s**. Median
exit→ACK upper bound: **22.240149s → 10.294658s**. Exit observation bracket
was 5.720–16.926ms; native helper parent-exit wait was 1.319–1.831ms, not 60s.
The helper's COMMIT input wait was 0.107117–0.142013s, not its 60s deadline.

This deliberately trades longer **pre-quit** work for shorter blackout. Median
fixture preparation grew 18.359480s → 41.739968s; median total preparation+ACK
grew 40.112577s → 52.033867s. Do not claim reduced total click-to-completion
time. Full archive authentication remains after exit; hashing and real GUI startup
still cost time. Variable host load/cache state and dev SHA256 speed affect these
observations. No one-minute cause, production speedup or full-GUI startup acceptance
is established.

These historical measurements predate OS-temporary macOS payload staging. That
layout now adds a post-exit copy into a suffixless private same-volume commit entry,
exact closure verification and syncing before atomic exchange. Do not apply the
numbers above to the current layout or claim unchanged restart latency without a
new measurement. Temporary purges never affect the durable rollback/journal.

## Remaining evidence for the reported minute

If the minute persists, obtain the exact installed/target versions, whether the
minute starts at Download, Restart or actual disappearance, and the retained
transaction's phase timestamps plus read-only startup/helper diagnostics. Separate
pre-quit verification from post-exit work and new-GUI state loading/first paint.
Do not replay an Unknown transaction or shorten safety deadlines to diagnose it.
