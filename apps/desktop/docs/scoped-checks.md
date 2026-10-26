# Fast, explicit desktop checks

From `apps/desktop`, choose the smallest unit/transport filter and named native
target that exercises the change. There is no default suite:

```sh
python3 scripts/check-scoped.py --unit bundled_runtime::tests
python3 scripts/check-scoped.py --unit mission_transport::tests
python3 scripts/check-scoped.py --test settings_state
# Batch a library filter with an affected, synthetic offscreen UI target.
python3 scripts/check-scoped.py --unit chat_models --test project_creation --lint
# Keep the same feature combination while iterating on a native slice.
python3 scripts/check-scoped.py --unit chat_models --native-probes
```

The command enters the existing shared verification slot. Cargo still goes
through `scripts/cargo.sh`, including checksum verification, the pinned toolchain,
two build jobs, mbx CPU2/4GiB admission and this worktree's private target and
incremental files. No cache is cleaned or shared target installed. Development
and test already default to opt-level0 with debug0; this command does not claim
to disable previously enabled optimizations or change any profile/flags.

## What is scoped

- One Cargo test invocation selects only `--lib FILTER` and/or the named test
  targets. Mixed batches share feature resolution/preparation and Cargo's normal
  executable environment. There is no separate copied-binary runner.
- Native probes use the stable `native-probes` feature. Unit-only commands can
  opt into the same feature, rather than inadvertently alternating feature sets.
- Existing synthetic custom native mains ignore the library filter/libtest
  arguments. Their assertions still run completely. Capture/scaling benchmark
  executables are deliberately not accepted as ordinary tests. A new argument-
  parsing main cannot be mixed without an explicit implementation change.
- Every selected standard harness must report at least one passed test. Empty
  filters, only-ignored matches, missing results, missing native launches,
  unsupported native execution and nonzero exits fail instead of appearing green.
- `--lint` checks the selected production library/native targets, not every
  integration target. Unit bodies are compiled/executed but this is **not** a
  claim that Clippy linted every `cfg(test)` body. Broad existing CI retains that
  responsibility.
- Only source-audited pure modules and the `controls`/`project_creation`/`chat_actions` native
  targets omit visual-helper preparation/builds. Visual/unknown library scopes
  and other native targets retain the helper conservatively. Use `--worker` when
  adding a worker consumer to a formerly pure module, and update the explicit
  contract alongside it. Required helper failures are never ignored.
- Native execution requires macOS arm64. This is not Linux/Wayland verification,
  OS input/motion/performance acceptance, a real Local action or an app launch.

Choose matching coverage, for example launcher/environment changes map to
`bundled_runtime::tests`; mission transport changes map to
`mission_transport::tests`; project/model UI changes map to the appropriate
library filter plus `project_creation`. Do not add unrelated native targets.
Multiple standard harnesses share the filter, so a module-specific library
filter usually should not be combined with an unrelated ordinary harness.

## Observations, not assumed speedups

`--report /tmp/fresh-scoped-run.json` creates a new file, never overwriting a
receipt. It records explicit targets/features, manifest profiles, hashes of
ambient build overrides (not their potentially private values), platform/CPU,
lockfile hash, command wall time and queue/startup time. The observed Cargo
`Finished test profile` boundary splits preparation/compilation/link/Cargo time
from execution/Cargo time. It is not an isolated linker or rustc CPU measurement.
Commands are bounded to1200seconds and16MiB captured output. Cancellation/deadline
reaps the runner's owned temporary check group, never a PID from a file; this
developer-test cleanup is not the bundled Local daemon lifecycle.

Measure before claiming gains: compare identical unit/native selections,
features, profile and cache state, including warm no-change and a disposable
single-module edit with exact byte restoration. Record cache/queue effects,
first-use compilation and no-improvement cases honestly. Do not mutate an active
check's frozen inputs or use a live profile/visible benchmark. Cargo still
compiles the complete library harness for `--lib`; selecting a filter does not
make it a standalone tiny compilation.

Run this entrypoint directly, not as a child beneath an already-held slot.
For an existing shell wrapper, use `exec python3 scripts/check-scoped.py ...`
so the verified holder PID is preserved. An inherited different holder fails
fast instead of deadlocking on its own queue. A stale inherited marker must be
cleared only after confirming no live check owns it, not used as a bypass.

The explicit full `scripts/check.sh` and all CI jobs are unchanged. Run a broader
local gate only for a concrete cross-cutting risk or an explicitly requested
integration check, not as the default after every isolated fix.

## Initial measured observation

On a Mac15,6 (36GiB,11 logical CPUs), Rust1.98.1/LLVM22.1.8, unchanged
opt-level0/debug0 and CPU2/4GiB admission, one **warm** paired observation used
the runtime environment-whitelist unit plus all8 `project_creation` native
records. Both arms used `native-probes`, the same existing private target,
lockfile and test coverage. The target pair was primed once; no cache was cleaned.

| Selected workflow | Command wall | Observed preparation/Cargo boundary |
| --- | ---: | ---: |
| Separate ordinary Cargo unit + native invocations |11.320s |0.991s combined |
| One explicit scoped batch |11.032s |0.498s |

The observed total saving was0.288s (2.5%), not a large compiler speedup.
Native execution/Cargo varied from10.329s to10.534s. This is one paired
observation, not a statistically established latency guarantee, cold-cache win
or application runtime improvement. The warm preparation/front-end component
roughly halved; compilation was already fresh. This observation is pinned to the
pre-selector application composition848749ee on e81833c3, with8 project records;
it must not be transferred to the later12-record model-selector composition.

Reproduce on an isolated checkout with no concurrent writer/check. Prime the
same selection once before timing these equivalent arms:

```sh
filter=bundled_runtime::tests::runtime_environment_retains_restrictive_and_resource_policy_without_ambient_authority
# Before: time the sum of these two commands.
bash scripts/cargo.sh test --locked --color never -p pilot-desktop --features native-probes --lib "$filter" -- --test-threads=1
bash scripts/cargo.sh test --locked --color never -p pilot-desktop --features native-probes --test project_creation -- --test-threads=1
# After: one Cargo invocation, still all native assertions.
python3 scripts/check-scoped.py --unit "$filter" --test project_creation --report /tmp/fresh-scoped-observation.json
```

Keep the before commands inside the usual shared verification admission too.
Do not interpret a first-use compile or the JSON boundary as isolated linker
time. The initial qualification's13.66s compilation and41.01s unit+`controls`
batch were first-use observations, not used as the warm comparison baseline.

## Single-module edit, accepted model-selector composition

A separate bounded pair used published application source
`295ad854f3db1f7e9564bb71ffa00fc26e8d810c`, the same machine/toolchain/profile,
mbx1.26.0, native-probes in both arms, the whitelist unit above and **all12**
`project_creation` records. A fresh equal-length A/B suffix changed only one
fallback error label in `src/bundled_runtime.rs`. This invalidates an actual app
module's MIR without changing policy, safety bounds or a live app. It is a small
synthetic edit, not a representative large feature or cold dependency build.

| Selected edit workflow | Command wall | Before observed Cargo finish | After finish, including wrapper tail |
| --- | ---: | ---: | ---: |
| Separate unit/native commands, label A |40.571s |9.148s total |31.423s total |
| One unit/native batch, label B |34.334s |6.083s |28.251s |

Observed saving:6.237s (15.4%), **one pair only**, not a guaranteed speedup.
The post-finish column includes native execution **and** Cargo/mbx tail work;
even the unit-only command's tail was4.112s although its test reported0.00s.
Do not label that whole column test time or claim the linker alone improved.
The remaining~28s component dominates this native slice. Compiler/linker work
and native/test-wrapper costs remain; no optimization/profile change or shared
cache-hit benefit is claimed. Actual edit-arm cache summaries reported0 hits,
incremental work and bypasses. No forced cache miss or cache cleaning was used.

The experiment primed original295 once, ran edit A with the two before commands,
restored the exact original and did a compile-only reset, ran edit B with one
batch, then restored/reset again. A private0600/fsynced backup and expected-byte
guard refused to overwrite a concurrent edit. All156 original input hashes
matched after restoration; only the designated module differed in either arm.
No compiled variant was installed or published. Queue/startup was0.334s, outside
the command totals. No further timing loops were run.

To reproduce privately, back up the module and replace the unique label
`The bundled runtime could not start safely. No existing daemon was stopped or replaced.`
with distinct equal-length nonce suffixes A/B. Use the exact commands above,
the existing shared slot and identical features for both arms. Between arms and
after the final exact-byte restoration, reset the original outputs with:

```sh
bash scripts/cargo.sh test --locked --color never -p pilot-desktop --features native-probes --lib --test project_creation --no-run
```

That reset is compilation only, not a zero-test pass. Keep each phase's source
hashes, actual command output, profile/ambient-flag hashes, hardware/toolchain,
cache counters and stage wall times. Never run this edit experiment against a
live profile, someone else's checkout or frozen inputs used by another check.
These timings are **prior-implementation observations**, not passing timing
results for the later cleanup repair. The measured runner SHA-256 was
`22c23867f6a060b4a6a28a6964561b975962f463d92b1ef619696865b2bcb12c`.
Command construction, selected targets, features and profiles remain unchanged;
the later run-lifecycle changes below have only Python-faux verification. No new
Rust/native/timing pass is inferred from the old measurements.

## Scoped verification

The prior implementation's13 script regressions and Python compilation passed, including the real copied
Cargo wrapper under system Bash3.2 and PATH Bash, bounded output/deadline/owned
process cleanup, helper-build failure, zero-result checks and nested-slot denial.
The actual final entrypoint ran9 `mission_transport::tests` cases,0 ignored,
under normal admission;156 checked input hashes stayed identical. Earlier
selected lib/native Clippy, runtime9+`controls`, and the timed unit plus
`project_creation` batches passed. These are scoped observations, not a full
desktop/CI/production-app validation claim. No CI, release profile, dependency,
toolchain, shared-cache policy or existing verification wrapper was changed.

### Exited-leader failure cleanup repair

The prior `run()` could reap a failed leader and then skip group cleanup because
`poll()` reported it exited, leaving descendants holding stdout or redirected
descriptors alive past the runner/slot. Both cases reproduced with a private,
finite faux child and socket lifetime handle, with no arbitrary PID/file signals.

Failure/cancellation/deadline/cap cleanup now retains the actual session leader
unreaped with POSIX `waitid(WNOWAIT)`, reserving its identity until the owned
test-group signal; it reaps that leader only afterward. Default SIGCHLD and an
exclusive waiter are required. Missing identity, signal/reap failures remain
unconfirmed, never a success. Normal successful commands keep their prior
behavior. This is not bundled-daemon supervision or permission to kill daemons.

17 current Python-faux regressions plus pycompile passed. They assert that the
exit7 leader is still an unreaped child at group signaling, inherited/redirected
descendants lose their private control connection, unexpected reapers are
refused, and lost ownership never triggers a group signal or successful result.
Fixture cleanup releases its child through owned socket EOF, even against the
broken implementation; its finite fallback prevents an unbounded test orphan.
No Rust/native/full suite or additional benchmark was run for this repair.

### Darwin exited-singleton cleanup

On macOS, `killpg(SIGKILL)` can return `EPERM` for a group whose only member
is its exited, still-unreaped leader. A fresh synthetic exit101 reproduced
this while `waitid(WNOWAIT)` retained the actual child; even `getpgid` and
`getsid` returned `ESRCH`. Neither permission errors nor PID/`ps` absence
prove cleanup. The earlier generic error also discarded the actual signal
errno, making historical failures impossible to classify from that report alone.

The narrow fallback runs only after Darwin `EPERM` and a terminal, retained
actual child. The system `libproc.proc_listpgrppids` census must positively
return exactly that one leader and no other member. It returns **PID counts**,
not bytes. A two-PID buffer rejects any extra member or full/truncated result;
empty results, query errors and unexpected values do not establish cleanup.
Another non-consuming wait must confirm the same terminal child/status before
the leader is reaped. The kernel enumeration includes live and zombie members;
this is affirmative singleton evidence, not a rule that `EPERM` means gone.
Even multiple zombies remain conservatively unconfirmed. No stale PID/group
from a report is accepted as signaling authority.

Per-command reports now retain the actual leader PID, retained status, signal
errno, census result when applicable and cleanup/reap disposition. A confirmed
exited singleton still fails with its original nonzero command status, never a
passing test. Live descendants, failed queries, lost ownership, deadline/output
failures and nonzero exits retain their existing guards. This does not supervise
escaped groups or authorize any app/daemon cleanup.

21 Python-faux regressions passed, including the real native exit101/EPERM
condition, positive singleton census, injected denial with an actual live
descendant (rejected and released through its private lifetime socket), incomplete
or denied census and changed/lost retained identity. Existing inherited-pipe and
redirected-descendant cleanup, cancellation, deadline/cap, nonzero/zero-result,
admission and copied-wrapper resource guards also passed. No Cargo/native UI,
app/service action or performance experiment was needed for this helper-only fix.

The historical gallery compile failure that motivated this investigation had
already reaped its leader without recording its group identity or signal errno.
Fresh reproductions and the new helper do **not** retroactively prove that job's
cleanup or release its source freeze. Preserve that failed receipt and report
its original cleanup as unconfirmed unless separate authoritative evidence is
available.
