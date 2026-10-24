# Mission text whitespace compatibility

Mission conversion matches `packages/daemon/src/missions.ts` `text()`:
ECMAScript `String.prototype.trim()` decides blankness and normalized text;
the **raw outbound** UTF-16 length still has the existing 200-title/4,000-goal
limits. The native form captures trimmed title and goal, while direct requests
are validated against their actual outbound strings before any reservation.
An empty normalized goal is allowed; an empty normalized title is not.

Rust `str::trim` is not equivalent. ECMAScript removes U+FEFF (BOM), but retains
U+0085 (NEXT LINE), which Rust removes. The mission-local allocation-free helper
uses the exact union of ECMAScript WhiteSpace and LineTerminator:

- U+0009–U+000D, U+0020, U+00A0, U+1680;
- U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000;
- U+FEFF.

This is not a general editor whitespace replacement or a BOM-only special case.
Interior characters are preserved. Default title preparation and Ready blank
checks use the same helper as title/goal capture and new request validation.
References: [ECMA-262 WhiteSpace](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-white-space),
[LineTerminator](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-line-terminators),
and [TrimString](https://tc39.es/ecma262/multipage/text-processing.html#sec-trimstring).

## Preserve previous uncertain attempts

A previous version could durably record a BOM-only title before the daemon
refused it. Tightening **new admission** must not invalidate that entire private
snapshot on reopen, lose other drafts or authorize another POST for that source.
Retained records therefore accept the union of the previous pinned Rust and
current ECMAScript nonblank classifications, under the same source/ID, UTF-16,
byte and outcome bounds. This is read-only compatibility, not a retry gate.
`Store.prepare_mission` separately requires strict current request validation
before building/writing any new attempt. Previously invalid ordinary ASCII blank
records remain invalid. Retained requests/outcomes are not rewritten or pruned.

The existing Unknown/no-retry policy is unchanged, including after an empty
membership read. No generic HTTP400 is reinterpreted as safe non-creation. No
backend/protocol, schema version, SDK, CI or permission behavior changes.

## Independent oracle and bounded verification

`tests/fixtures/ecmascript-trim.json` was generated with Node 24.21.0, using the
actual repository Node verification slot and no inherited SDK preload. The scan
checks every Unicode scalar against JavaScript `trim()`, producing 25 trimmed
code points and 16 whole-string controls. The Rust test scans every scalar
against that independent oracle and checks all padded/BOM/Unicode/nonblank and
interior-character controls. This is scalar parity, not a claim about unpaired
UTF-16 surrogates, which a Rust UTF-8 string cannot represent.

Focused transport/form/store cases prove invalid blank titles produce no attempt,
no state-file change and no POST; NEL-only content remains accepted; title/goal
normalization and existing padded/emoji UTF-16 boundaries agree. A prior-version
BOM Unknown snapshot reopens, permits unrelated draft saves, and retains the same
request/ID/outcome across reopen and attempted replacement. Current membership
observation cannot settle or replay it.

The existing 20-case native mission matrix adds a real padded BOM title before
confirmation and asserts no attempt/POST, then submits BOM-padded Unicode (light)
or a NEL nonblank control (dark). It verifies the exact normalized title/goal and
retains all existing uncertainty, 201/private-write-fault, copy/reopen, ordinary
draft/Stop, scroll/selection and no-duplicate assertions. It uses owned faux HTTP
and synthetic private state only. There is no live create/send/approval action,
local Swift, unrelated full suite, visible smoothness or OS IME acceptance claim.

Initial exact source `e4ac1233330d8a91dfd5642764cf7354bc9a0afe`, tree
`11c2d42616ce2a4ffbfddbf8b73d1d8d0d41b9d2`, completed strict Clippy,
26 mission-matching library cases (one explicit ignored workload), nine original
editor cases and the native 20-case matrix in job
`fdeb4a82-22aa-4632-83fb-0e21e55f7d61`, with identical PRE/POST receipts.
The retained-record compatibility safeguard was added afterward; this earlier
pass is not transferred to that later source. Final exact-source receipts and
publication mapping are reported with the PR.

## Final compatibility qualification

Exact tested source `e3c3d17dc0ea6e5672c6436c366d6dc9cda7c8cc`, tree
`ab4d260cfa7b60b36e3bbb12f6a491c3cc7e0b41`, based on accepted
`ed791a68dfb282c3fadf1ff447e379b4c2bc9c2d`:

- Job `675dfb91-a6eb-4d94-8234-2bc43e51cd51` passed formatting, strict
  all-target native-probe Clippy, **28 mission-matching library cases** (one
  explicitly ignored workload), **16 Store cases** (two explicitly ignored
  workloads), **nine original editor cases**, and the **20-case native mission
  matrix**. These focused groups overlap; they are not a summed full-suite count.
- The stable Node/Biome check passed under the actual Node slot, scanning
  **1,112,064 Unicode scalars**, **25 trimmed points** and **16 string cases**.
- Both final runs have identical **14-file source/lock/hash and tracked-diff
  receipts before and after**, on that same exact tested source. This results-only
  section was appended after all checks terminated. The PR records its
  documentation-only and final metadata mapping; tested source/tests are unchanged.

The first Node verification `65990849…` passed its actual oracle and formatting
assertions but correctly failed its frozen-source receipt: another job’s initial
formatter changed two test files between its PRE and POST. That failed record is
retained, not relabeled as qualification. Only the small Node/Biome check was
repeated after Rust/native completion on stable inputs; no unrelated full suite
was duplicated. No CI, SDK, production auth, backend or release changes were made.
