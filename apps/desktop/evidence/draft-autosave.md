# Bounded private draft autosaves

Scoped persistence follow-up on the navigation-history checkpoint, not a default
switch, backend change, Swift import or full replacement acceptance. All state
and requests in these checks are synthetic and isolated. No real chat action,
private state read, visible application or Linux/native rendering run was used.

## Change and durability boundary

- Keep the existing private `state-v1.json`, initialization fence, lock inode,
  identity/validation/size bounds, 0700 directory, 0600 files and atomic
  file-fsync/rename/directory-fsync transaction. No journal, migration or new
  recovery/compaction crash boundary.
- Editable draft autosaves now use 250 ms idle debounce and a fixed 1 s ceiling
  from the first unsaved edit observed by the worker. Subsequent wakes cannot
  extend the ceiling; an expired timer has priority over edit wakes. The latest
  per-key mailbox remains bounded at 128 drafts.
- Every explicit command bypasses this timer and forces the existing flush.
  Create/send/Stop intent reservation, receipt adoption, ownership changes and
  final close still acknowledge only after their unchanged durable transaction.
  No intent, pending receipt or terminal adoption is buffered by autosave.
- Semantic no-op transactions validate as before but skip encoding and disk
  replacement. Stale edits, repeated pending receipts and revision-fenced
  cleanup therefore do not rewrite unchanged state. An existing I/O fault still
  rejects even no-ops. Failed saves retain queued input and fence delivery.

The tradeoff is explicit: sustained, not-yet-saved editable text may remain
labelled Saving longer, up to the 1 s schedule instead of 250 ms. A short burst
still saves 250 ms after its last observed edit. These are scheduling bounds,
not hard wall deadlines: the existing single worker can be busy on synchronous
I/O or bounded network work. Crash/force-quit can lose unsaved edits; native
Dock/system termination still lacks a guaranteed flush. Normal application
close/quit forces the final flush. Durable intent acknowledgments are unchanged.

## Reproduce without real data or native windows

Run through the existing project-local mbx wrapper (two build jobs, shared
CPU2/4GiB admission scheduler, per-workspace targets), with machine-wide checks
serialized as appropriate. No global setup/cache edits are required.

```sh
python3 apps/desktop/scripts/prepare-visual-worker.py
bash apps/desktop/scripts/cargo.sh build --locked -p pilot-visual-worker
bash apps/desktop/scripts/cargo.sh fmt --all -- --check
bash apps/desktop/scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash apps/desktop/scripts/cargo.sh test --lib --locked -- --test-threads=1
bash apps/desktop/scripts/cargo.sh test --lib --locked \
  interaction::tests::coalesced_snapshot_writer_workload \
  -- --ignored --exact --nocapture --test-threads=1
bash apps/desktop/scripts/cargo.sh test --lib --locked \
  delivery_store::tests::private_snapshot_writer_workload \
  -- --ignored --exact --nocapture --test-threads=1
```

The replay seeds 128 drafts of 32 KiB each in fresh private temporary directories.
It compares the previous first-edit + 250 ms policy with the production autosave
scheduler for identical 10 **logical** seconds of 200 edits (20 Hz), including
final flush and restart verification of revision 201. Time advances logically,
but each due snapshot really serializes, fsyncs and atomically replaces the
file. Count replacements by inode changes and sum encoded snapshot lengths.
Initialization/seeding are outside the timed/count region. Byte totals are
application snapshot bytes, not filesystem/SSD physical writes or syscall counts.

## Observations (macOS, debug build)

Original writer, before production changes: 4,216,528-byte snapshot; ten atomic
updates took **663.110 ms**. This reproduces the earlier ~0.69 s observation.

| Identical sustained replay | Atomic replacements | Encoded bytes | Actual replay wall |
| --- | ---: | ---: | ---: |
| Previous fixed 250 ms batching | 40 | 168,661,180 | 2,860.681 ms |
| 250 ms idle / 1 s ceiling | 10 | 42,165,296 | 693.994 ms |

This is **75% fewer replacements and encoded bytes**, roughly 16.1 to 4.0 MiB/s
per logical second for this workload. Replay wall time includes real synchronous
clone/validation/encoding/I/O, not ten real seconds of typing. These are local
debug observations, baseline first, not a statistical latency/smoothness result.
An earlier replay gave 4,455.632 / 1,207.228 ms with identical bytes/counts,
illustrating wall-time variability. Ten ordinary changed snapshots after the
change still took 685.019 ms: individual snapshot cost is not improved.
Single-save cost, full-state cloning, large recovery snapshots and command-driven
write bursts remain. There is no claim of incremental persistence or matched
Swift/GUI/CPU/RSS performance.

## Coverage

Focused persistence/courier tests cover the fixed ceiling, idle extension/reset,
continuous edits saving before idle, final flush/restart, ready commands flushing
in their first poll without a timer, no-op inode stability, validation/fault fences,
failed-write input retention and unchanged durable adoption. Existing tests cover
immutable operation restart/retry, initial ownership, identity/corruption/missing
snapshot/private permissions, late acknowledgments, revision-safe recovery,
pending/no-repost, cancellation and once-only uncertain Stop. Full native/UI
regression remains separately owned and is not claimed by this checkpoint.

Final verification on 2026-10-23: rustfmt, strict all-target app Clippy, locked
helper build, **134 library tests passed / 2 opt-in workloads ignored**, followed
by both explicit disk workloads passing. Commands ran serially through the
machine-wide verification slot and bounded mbx wrapper. An initial library run
failed eight helper-dependent tests because the fresh workspace had no helper;
materializing/building the existing helper resolved all eight without source
changes. A test-only redundant `drop` was removed after strict Clippy flagged it.
The existing `block 0.1.6` future-incompatibility notice remains. No native
renderer executable, complete `check.sh`, visible or Linux suite was run here.
