# App-owned updater evidence

Initial source checkpoint was based on exact published
`5bd2498d2cd71fc3b4f864620c31deff2576c2a3`; only new updater-subtree paths are owned.
The user subsequently explicitly requested an app-owned updater. The earlier native
Sparkle probe was replaced, not layered alongside a second production updater.

App-owned signed manifest/transport/bounded ZIP staging, Security validation, native
atomic swap, explicit COMMIT+OS parent-exit helper and typed scheduler/worker are now
implemented. No gpui-updater/Sparkle dependency, custom cryptographic primitive or
shared UI/manifest/Settings/CI/packaging seam is adopted here.

## Verification

Final focused verification **passed** on frozen source
`1096ce29d171af3e4c8364447fb0dc825c83170e` (implementation/tests at `5ad7bce0`,
followed only by README wording). Accepted publication base is exact
`46923720ea3a23f8e3d7f3f48e0005fffecfab6c`; replay was limited to the owned subtree.
The original5bd/1168 checkpoints remain historical source evidence, not current tests.

Job `79aa0704-17cb-4110-991a-594e8904fcdc` exited0 on macOS arm64. Its retained
harness was `/tmp/updater-check-acl-fd/run.sh`, invoked through the repository
`verification-slot.py swift` runner and mbx1.26.0 CPU2/4GiB with Rust1.98.1,
macOS15 deployment target and a per-workspace isolated Cargo target. It printed the
full source hash manifest **before** compilation and asserted identical hashes after.
Compiled public updater configuration variables were unset, not real release values.

Passed commands inside the standalone crate:

```sh
mbx fmt --all -- --check
mbx clippy --offline --locked --all-targets --features native-macos -- -D warnings
mbx test --offline --locked --features native-macos -- --test-threads=1
mbx build --offline --locked --features native-macos --bin pilot-desktop-update-helper
```

All **39 tests passed**, none ignored, in0.63s (test execution, not build time or a
production performance claim). Actual macOS component coverage includes Security
framework validation of a temporary ad-hoc-signed bundle, wrong id/build/publisher
requirement and tampering, ACL write grants in safe-mode parents/nested files,
inherited ACL stripping, existing/no-ACL vs missing paths, kqueue exit on an owned
child, native atomic swap in a private fake app directory, retained backup, failed
launch and fast startup acknowledgement. Other fixtures verify ring signatures,
controlled fake-network credentials/redirects/bounds, archive paths/symlinks, bounded
staging, stream COMMIT/EOF/lost ACK, helper death, exact persistence revisions and
controller scheduling/cancellation/generation/teardown. No real app was opened.
The built helper also exited1 for an unconfigured synthetic invocation, before
opening a transaction or attempting installation. Objective-C compiled/linked only
Foundation/Security, not Swift or Sparkle.

Earlier attempts are retained honestly: `731e7da0` failed on missing directory-sync
function and channel type; `a8270c9b` failed one strict lint; `a97ef61b` reached37
tests (27pass/10fail), exposing the clean-path ACL bug. Darwin reports ENOENT for an
absent extended ACL on an existing object. The corrected implementation first opens
a no-follow descriptor, so ENOENT from `acl_get_fd_np` means no ACL without treating
a missing pathname as safe. Final39 includes the positive and negative regressions.
No source changed while any verification invocation was active.

Read-only source review findings (directory identity, journal ordering, descriptor
lifetime, helper-status recovery, ACLs and stopped-state event fencing) were fixed
and covered by focused regressions. Source review is not additional runtime evidence.
This evidence-file update is documentation-only; compiled inputs are unchanged.

## ZIP pre-index admission correction

The original post-index `len()` check did not bound eager zip8.6 allocation or raw
records: the library builds its index before returning and silently deduplicates names.
This is an authenticated archive availability/resource-admission correction, not a
signature bypass or RCE fix. No merged implementation history was rewritten.

Frozen input `33f4243828d92cd608fe7c4b534ef1ef8e233ce9` passed local job
`67418563-7dcd-4569-81c2-07f1b0dfe431` (exit0). The harness
`/tmp/updater-check-zip-admission-retry/run.sh` used the real repository Swift/native
verification slot, mbx1.26.0 CPU2/4GiB, existing Rust1.98.1, macOS15 deployment
and isolated `updater/target/check`. All compiled release configuration was unset.
A full 17-file SHA256 manifest was printed before compilation and checked unchanged
at the end. This subsequent evidence-only fold does not change compiled inputs.

Passed: formatting, locked/offline strict all-target Clippy with `native-macos`,
8 focused admission tests, then **50/50 full standalone tests** (39 existing plus
11 new, none ignored), helper build and unconfigured helper exit1. Full unit execution
was0.93s, not a performance/production-lifecycle claim. The first attempt
`2acaf0d0-c2ca-4a40-afb1-a19ac70a7f74` failed a caused `manual_range_contains`
Clippy lint before any tests. The ordinary range expression was corrected without
suppression and the entire harness rerun. Neither invocation mutated frozen source.

New fixtures deliberately emit raw duplicate central records and establish the pinned
library sees only one deduplicated entry at2/30,000/30,001 raw records. Checked preflight
rejects duplicates before indexing. Separate cases cover exactly30,000 unique ZIP32/64
records,30,001 rejection, underdeclared raw records, file/directory aliases, forged huge
ZIP64 count/size/offset/record-size fields, malformed/truncated/multidisk footer data,
footer changes between admission and snapshot, cooperative cancellation before reads,
during snapshot and before indexing, alternative-footer seek rejection and metadata
read-work exhaustion. Extraction tests cover genuine duplicate rejection before staging,
cancel before staging, normal and ZIP64 entry/footer/extensible metadata, opaque archive
comments containing footer signatures, executable mode, exact payload bytes and safe
internal symlinks. Existing traversal/escaping-link, signature/identity/native Security,
ACL/install/durability/helper/controller regressions all remain and passed.

Admission caps raw records at30,000 and directory metadata at64MiB before library indexing,
with a bounded metadata snapshot/read budget and cancellation on index reads/seeks.
Only canonical single-disk archives with contiguous central/footer records and absolute
offsets are supported, not self-extracting or trailing-junk containers. Maintained ZIP
APIs still own decompression, extra-field interpretation and CRC. The public metadata
reuse API binds the checked snapshot's original offsets to the same open file; its
semantic safety precondition is documented at the call. This is standalone component
qualification only. Shared CI does not currently register this separate crate, and
this correction neither wires nor enables live update/install/restart.

## Acceptance gaps

- No production credentials/key/feed/release, signing secrets, real installed app or
  daemon mutation, global install, local Swift test/build or Linux validation.
- Source is not registered/reachable in GPUI; compiled release identity/key are absent
  by default. Worker/helper fail closed, not silently using a development feed.
- No integrated draft/delivery/Settings acknowledgement+admission fence, actual shared
  daemon stop, GUI clean quit, helper packaging or post-restart durability receipt.
- Unit tests exercise real maintained cryptographic verification and synthetic transport;
  TLS network deployment/private-host authentication and an actual N→N+1 GUI launch
  are not inferred. Native component tests do not establish a production lifecycle.
- Failed launch retains old/new bundles; no automatic rollback or automatic cleanup
  promise. See README for recovery-required states and integration contracts.
