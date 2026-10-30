# Update restart critical path

The update download, signed archive validation and first extraction finish while
the app is open. Restart preparation/checkpointing also happens before quit.
Blackout starts only when the old GUI exits. It ends when the new GUI appears,
which is distinct from its later exact durable startup acknowledgement.

## Deadline audit

These are failure bounds, not unconditional sleeps:

- GUI checkpoint: 15 seconds, refuses without the exact writer acknowledgement.
- Helper readiness: macOS 120 seconds including pre-quit full extraction/verification;
  Linux 30 seconds. The GUI remains open, with restart editing/admission fences.
- Helper COMMIT receipt: 30 seconds, lost receipt remains Unknown.
- Helper COMMIT input: 60 seconds, EOF/ordinary quit without COMMIT aborts.
- Parent exit: 120 seconds, native kqueue NOTE_EXIT, never PID polling or killing.
- Native relaunch command: 15 seconds, 10ms owned-command completion spacing.
- External Local identity read: 2s connect / 5s request.
- Retained owner reads: 1s connect / 5s request (prepare request up to 15s).
- Legacy GUI receipts retain their nonrenewable 180-second reservation.
  New GUI swaps use read-only inspection, with no agent pause or reservation.
- Post-startup macOS daemon handoff: up to 10 minutes for tool boundaries,
  cancellable before shutdown, followed by the existing daemon reservation.
- Bundled startup validation/launcher: 45 seconds, with separate 2s cleanup bound;
  Node launcher has 20s overall / 10s preactivation and 100ms readiness spacing.

None explains a mandatory one-minute blackout. Runtime activation/publication and
loaded application state are separate from the minimal updater fixture below.
Do not infer that the user's reported minute is proven or fixed from this fixture.

## Preparation moved before quit

The macOS helper freshly authenticates/extracts `install-payload` before
READY, independently of the earlier download-stage preview. It keeps the exact
bounded closed-tree digest only in memory, never in a mutable journal. After
COMMIT and kqueue-confirmed parent exit it still authenticates the signed archive,
rehashes every path/mode/byte/link (including unsealed extras), verifies the native
signature and source, and rechecks the owner/lease or external identity pin before
the unchanged atomic exchange and durable relaunch intent. Old bundles/receipt ACK
and Unknown/no-repeat behavior are unchanged. Linux keeps its existing extraction
path; this work does not qualify Linux or change its native lifecycle.

macOS helper readiness allows 120s instead of 30s because full extraction/verification now
precedes READY. That bound is not a sleep and occurs before quit. No COMMIT receipt,
parent-exit, reservation or startup safety deadline is shortened or extended.
An interrupted prepared helper cannot resume by trusting stored digest evidence.

The OS-temporary preview and helper-preparation trees are disposable and are not
fsynced. Their closed bytes still pass ZIP/CRC, native signature, source and exact
closure checks. The retained authenticated archive stays durable. The final
same-volume copy is still fully synced before swap, and both swap parents and
journal remain durable. Linux and legacy same-volume extraction retain syncing.
Temporary deletion now follows the relaunch command. An interrupted helper leaves
the exact ownership record for locked, proven-post-swap recovery cleanup. Cleanup
does not stand in for an ACK or resolve an Unknown transaction.

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

### Disposable extraction, full payload, 2026-10-30

One paired isolated run used the same authenticated 1.97 macOS ZIP as the stage
investigation: 159.6 MB compressed, 495.2 MB expanded, 24,276 entries including
20,912 files. Inputs were copied into private OS-temporary fixture storage; the
source evidence was only read. No installed app, transaction, runtime store or service was modified;
no app or daemon was launched by this measurement.

Both arms used Rust 1.98.1, dev opt-level 2/debug 0, the same pinned dependencies,
mbx CPU2/4GiB admission and the same loaded macOS arm64 host. The fixture compiled
the exact before/after extraction source, authenticated the manifest and archive,
extracted once, checked native/source/filesystem policy and exact closure, copied
with `ditto`, checked the copied closure/native seal and synced every final file
and directory. Compilation and admission waits are excluded below.

| Phase, seconds | Before | After |
| --- | ---: | ---: |
| Full extraction | 74.813255 | 5.741418 |
| Final copy | 6.887666 | 6.443090 |
| Copied closure verification | 4.914416 | 4.528355 |
| Final copied-tree sync | 1.867715 | 1.957791 |
| Temporary deletion | 1.581797 | 2.515645 |

Both extractions and final copies had the exact same closed-tree identity. All
native/source/filesystem checks passed. The final sync was **not** removed.
Cleanup itself did not become faster in this pair: its work now follows relaunch,
and locked recovery can finish an interrupted deletion without replaying install
or startup ACK. The native lifecycle fixture separately checks success, cancel,
expired guard, interrupted COMMIT, failed startup, external/managed reconnect and
post-READY tampering. Unit fixtures cover missing/partial temporary data, final
sync-boundary failure, cleanup interruption, pending writes, replaced workspace,
corrupt archive and wrong rollback inode.

This is one warm-cache pair, not a statistical benchmark or additive forecast for
two production extractions. An earlier measurement attempt completed extraction
in 75.069848s but failed its copied-closure check because the measurement harness
used a noncanonical `/var` path; the corrected pair above passed every check.
The investigation's separate copied-tree sync observation was 38.284s, much higher
than this pair, so cache/load effects are substantial. These are isolated phase
durations, not visible GUI blackout, click-to-completion, release qualification or
production acceptance. No live installation or restart was performed.

### App-only qualification, 2026-10-29

`verify_update_lifecycle.py --app-only` passed both native external and managed
retained-runtime fixtures with unchanged source fingerprints. The faux daemon
reports active work and rejects pause, admission freeze and non-inspect owner
requests. Both swaps preserve its boot identity and acknowledge reconnect-only
startup receipts.

| Seconds | External | Managed retained |
| --- | ---: | ---: |
| Pre-quit preparation | 5.263 | 6.946 |
| Exit marker → new process entry, upper bound | 3.950 | 4.715 |
| Exit marker → durable startup ACK, upper bound | 4.123 | 6.678 |

These are single synthetic runs, not a before/after speedup or production GUI
timing. They demonstrate that agent readiness is no longer on the GUI swap path.
The full-GUI payload and large-session streaming cost remain unmeasured here.

If the minute persists, obtain the exact installed/target versions, whether the
minute starts at Download, Restart or actual disappearance, and the retained
transaction's phase timestamps plus read-only startup/helper diagnostics. Separate
pre-quit verification from post-exit work and new-GUI state loading/first paint.
Do not replay an Unknown transaction or shorten safety deadlines to diagnose it.
