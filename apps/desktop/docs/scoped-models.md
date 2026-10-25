# Local global Scoped models

## Workflow and ownership

Settings answers one decision: which global pi models may be offered on this Local
installation? The native Settings window reuses the app's semantic header, actions,
fields/notices, Kit checkbox, retained search and multiline input. Save is the only
primary action. Current values, permission errors, conflicts and uncertainty remain
visible; literal patterns use disclosure rather than a permanent debug editor.
There is no new typography, theme, per-control timer or alternate persistence layer.

Settings… or Cmd-comma retains the active chat, reader and composer. Scoped models loads
on explicit category selection. Cmd-S invokes the same guarded Save as its button;
Check Local is read-only. A confirmed Use current pi values discards the unsaved selection
and adopts the last observed list without writing or asserting an earlier write failed.
Unsaved/pending/unconfirmed changes block managed close and quit. Native marked text
guards Save, Check, adoption, category/close and pointer paths. The model owner and inputs
outlive the Settings window; background publications use the original Local window.

All displays both null and an empty array, but the original raw baseline/hash is retained
for compare-and-swap. Toggling All before Save does not rewrite the hidden literal list.
Explicit All saves null. Patterns retain order, duplicates, unavailable names, wildcards,
thinking suffixes and Unicode; there is no automatic concrete-model substitution.
An observed newline/control-bearing legacy pattern is refused, not silently split into
different patterns by the line editor. Matching readback settles only the submitted value;
a newer native input commit is retained, not overwritten by the response.

## Authority and truthful outcomes

Audited existing Swift ScopedModelsTransport/State/Store/Section, LocalModelScope,
PilotCore ModelScope and GitHubNativeAccess, and daemon model-scope/server/github-setup.
The contract is global GET/PUT `/api/model-scope`, with **no cwd or project parameter**.
GET includes authenticated candidates/resolution; there is no invented preview endpoint.
PUT sends exactly `enabledModels` and the captured `expectedHash`. Only explicit Save
reads the existing `github-app-capability` after pinned hello, checks bounded regular-file,
owner/private mode and daemon/lineage identity, and sends the existing sensitive native
header to that one loopback route. The token is not retained, logged or exposed to tools.
No account secret/sign-in changes or generalized native-action API are added.

Reads and writes run on one lazy worker thread/runtime/client with one-slot command and
result channels, no proxy/redirect/retry, 2-second connect and 5-second request deadlines.
Every read/save gates pinned Local hello. No remote hosts, current-chat model mutation,
default model, project override, start/send/stop, agent launch or settings import occurs.
Settings selection and refresh never PUT. Preflight failure queues no mutation and is
not falsely classified as a lost write. Both `changed:true` and `changed:false`, non-2xx
and lost replies are followed by literal GET readback. Equality verifies current pi
settings, not filesystem durability or proof of which writer changed them.

Conflicting/different or unavailable readback retains the captured selection and baseline;
no automatic resubmission. Explicit Check can settle equality or supply values for review.
A worker exit fences a pending write as unconfirmed. Check may replace a stopped reader,
never replay its mutation. Unknown chat delivery and its durable operation envelopes are
independent and unchanged.

## Bounds

- At most 256 literal patterns, 256 UTF-8 bytes each; ECMAScript blank classification.
  No ASCII controls. Explicit non-All requires at least one pattern.
- 2 MiB response cap before decode, including unknown-length/chunked bodies; 160 KiB PUT.
- At most 2,048 authenticated candidates, unique canonical IDs, bounded labels/resolution.
  Search keys are prepared off the UI thread. Initially 30 visible candidates, then explicit
  batches of 30; no network pagination or polling. Native input entities stay retained.
- Native capability is no-follow/nonblocking, at most 4 KiB, freshly checked for each Save.
- Hash matches daemon SHA-256 over JSON.stringify(raw list or "absent"), not normalized All.

## Synthetic verification

`scoped_models_tests.rs` and `scoped_models_view_tests.rs` cover literal/hash/schema bounds,
global payload and both success arms/readback, lost-before/after, 409/403/readback failure,
unsupported/malformed/oversized/chunked responses, capability absence/malformed/foreign/
oversized/permissions/symlink and pinned identity failures with zero PUT, original CAS
retention, confirmed read-only adoption, preflight versus uncertain state, stale replies,
native preedit and delayed newer-input commits. Hash constants come from a Node crypto
JSON.stringify oracle, including null/[], Unicode, order, duplicates and thinking suffix.

`--features native-probes --test scoped_models` mounts actual LocalViewer/Settings with an
owned faux loopback daemon and synthetic capability, 680/1100 logical pixels, light/dark.
It checks explicit checkbox/All/Cmd-S saves, GET readback, dirty and unconfirmed close,
worker lifetime across close/reopen, conflict review/zero resend, advanced Unicode literal
input with duplicates/suffix, real framework marked text, lost-write equality recovery,
retained editor/reader and unsent text. Captures are actual offscreen GPUI, not mockups.

No real authorization file, production pi settings or automated live action is exercised.
Static/offscreen checks do not establish OS IME/AX, visible motion, throughput/large-history
performance, Wayland acceptance, full Swift parity, release readiness or user acceptance.

The first oversized-response fixture run hung in synchronous Drop joining an untimed fake
sender after early Content-Length rejection. The failed/canceled receipt and native stack
were preserved; fixture write/connect timeouts plus a bounded teardown assertion fix it.
Subsequent focused check processes use an owned-group deadline, not a slot bypass or a
relaxed product limit. Final exact-source qualification receipts follow when complete.

## Qualified source receipt

Checked base: `2a042c6beb1741a7b814f19ee28c994d2ee79863`.
Exact tested source: `8420fa26ccc58764f8eb5b31ea03d8fc0668ad63`.
Tested tree: `a1f2fcffbb0308b4d3fff40a21dbcbcb00232c60`.
All three runs retained identical PRE/POST source/tree, binary diff SHA-256
`3ea4148cefbad5b59f7768f6f2bddeacf64c1c511f6394a5ffaf60f63f32758b`
and 26 changed/dependency/wrapper input hashes. This results-only section is the
only subsequent source change; publication metadata must preserve executable inputs.

- `7704d3d6-2ec1-4030-a67a-bbb4ecc52764`, exit 0: strict all-target native-feature
  Clippy, ten focused model transport/state/hash/preedit/newer-input tests and four
  actual Settings cases. Theme assertions and inspected pixels confirm real light/dark,
  rather than trusting the filename. Captures: `/tmp/scope103-focused9`.
- `31782e0d-24d7-4989-a740-ed0a439cf14e`, exit 0: actual `scripts/check.sh`,
  serial library 237 passed / three pre-existing ignored, 17 settings-state tests,
  formatting, Clippy, visual worker and all 21 registered native targets, including
  original chat/reader/selection/navigation/Appearance/mission/project guards and
  the four scoped-model cases. Captures: `/tmp/scope103-wrapper-native`.
- `d52f2ea7-112e-47df-a38d-1cdd989c7cc8`, exit 0: all 50 Python CI inventory,
  orchestration and wrapper fixtures. No remote CI result is implied.

Heavy Rust checks used actual shared verification admission; no local Swift build/test
or full pnpm suite ran. Failed initial lint, test-helper lifetime/observation and canceled
fixture-hang receipts remain failed, not rewritten as passing. Earlier dark-labeled
captures were found to follow System during visual inspection, so they are not dark
qualification. The final fixture pins synthetic committed appearance and asserts it.
No production state, real capability file or live mutation was used in these checks.
