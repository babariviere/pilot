# Read-only mission decisions

## Design and audited scope

Read the exact selected mission's current decisions without changing authority.
The existing neutral page/text/action/notice/tray vocabulary carries number,
audience and bounded wording. Individual text and source identity are disclosed
on demand. Pending suggestions sit in a separate labelled section and tray
surfaces, never in place of current text or as accepted strikethrough content.
Keyboard uses native Tab/Return; copy is explicit. No animation/timer is added.

The requested readability pass removes repeated warning paragraphs, keeps ordinary
counts/audience/source metadata in the caption role, places decision controls below
the wording, and groups proposal copy controls with their Reason/Proposed text
labels. Body line spacing uses the shared type role; current rows have clear
separators and proposals keep a distinct neutral tray, without new colors or scale.

Audited Swift `MissionTabs.swift`, `DecisionProposalView.swift`, audience labels,
the TypeScript protocol, and actual `mission_browser`/`mission_reader`/Browser
owners before implementation. The existing detail GET already carries decisions
and proposals. There is no proposal captured-decision revision or CAS contract.
No author or chronology is inferred. A missing current target stays unknown.
No management/comment/coordinator-notice endpoint is added or called.
See [the contract](../docs/mission-decisions.md) for exact limits and failure states.

## Mapped checks

Rationale: new bounded detail projection and native disclosure require projection,
actual GET-only reader and mounted Browser checks; the additive accept/navigation
seam also warrants the existing Browser library and real shell retention checks.

From `apps/desktop`, shared slots and the normal mbx CPU2/4GiB/private-target wrapper:

```sh
python3 scripts/check-scoped.py --unit mission_decisions --test mission_decisions --native-probes --lint
python3 scripts/check-scoped.py --unit mission_browser --test missions --native-probes
python3 -m unittest discover -s scripts -p test_ci.py -q
```

- Six Decisions projection/source tests passed, including absent/empty/malformed,
  pending-only status, all audiences, removed target, UTF-8/item/aggregate caps,
  bounded disclosure retention, exact snapshot/generation/home/project, and the
  actual reader's GET inventory plus wrong-hello/foreign-home refusal.
- Four new mounted Browser journeys passed:680/1100, light/dark, multiline Unicode,
  current-versus-proposed copy, pending edit/removal, unknown target, actual
  Tab/Return disclosure, sibling task draft and preedit-beforeblur guard, retained
  refresh failure, selection clearing, long/capped content, empty/absent/error.
- The additional production-shell journey passed: exact canonical keyboard
  navigation into Decisions and back retains the editor/transcript entities,
  Unicode draft, genuine selected source range and reading-away scroll anchor.
  Marked chat input refuses navigation; the owned private writer flushes and
  retains the exact draft with no pending delivery. Pointer and copy behavior is
  covered by the four Browser journeys; pointer presses intentionally clear the
  window's text selection, so range retention is tested on the keyboard path.
- Scoped Clippy (`-D warnings`) and native/lib compilation passed. The only
  compiler advisory was the existing dependency `block0.1.6` future incompatibility.
- The production, non-native-probes `pilot-desktop` binary build passed through
  the shared slot after rebasing onto the file-viewer/passive-model composition.
- Nine affected Browser library tests passed. The old `missions` native target
  failed before reaching the new surface: its fixed initial Tab count chooses
  foreign home instead of Local. The identical failure was reproduced on unchanged
  main `f4b9dfcdf94b0cf0e95c5b8faf6164e09c510def`. It is not ignored or fixed in
  this feature; a separate follow-up tracks the stale native fixture.
- All46 fake-tool CI orchestration tests passed, including manifest/native-target
  registration. Focused rustfmt and diff-whitespace checks passed.

Receipts remain private under `/tmp/pilot-decisions-205-{final,composition,baseline}.json`
and `/tmp/pilot-decisions-readable.json`; the earlier12 source hashes matched at
that checkpoint, before the requested readability pass. Native screenshots
are session artifacts from actual production GPUI rendering with synthetic data,
not SwiftUI mocks. The owned target also includes an additive full-shell retention
journey rather than weakening or modifying the old failing native fixture.

The passing owned-target receipt is `/tmp/pilot-decisions-landable.json`, with a
12-file compiled/orchestration source hash record. Earlier rebased/readability
receipts include the retained test-only failures, not hidden passes: the shell
main needed its real keybindings and its selection proof needed keyboard, not
pointer, activation. Assertions were retained. The CI registration conflict was resolved as the union of both native
targets, preserving the existing file-viewer contribution. No foreign commits
were rewritten. Formatter checks cover the new feature modules and Browser seams;
the upstream `lib.rs`/`local_view.rs` registration ordering is not represented as
a passing repository-wide formatter gate.

After the next fresh-main rebase, `/tmp/pilot-decisions-context-composition.json`
passed the same six tests and all five native journeys with scoped Clippy; the
production binary build passed again. No feature code changed during those checks.

## Limits

No full suites or live mutations. No installation/restart, production release,
backend/authority changes, remote fanout, polling or Linux claim. These are native
synthetic rendering/input checks, not OS IME qualification, visual-motion/FPS,
runtime performance, accessibility acceptance or replacement approval. The surface
uses explicit overview Refresh, not a new update feed. Capped copies contain only
bounded displayed text; the complete stored source remains unchanged.
