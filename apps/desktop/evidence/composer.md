# Composer Unicode and marked-text correction

Scope: fixture-only ordinary editing/input correctness. The A1 window, local
echo, transcript selection retention and manual return-to-tail fix are preserved.
No live data, transport, production Swift, global setup, publishing or fading.
Dedicated accessibility work is deferred under D15; built-in support is untouched.

## Pinned patch

The existing `patches/gpui-base-0.8.0.json` now also changes ordinary keyboard
boundary traversal and adds a defensive marked-text Enter guard. It is still
the same SHA-verified published Base 0.8.0 archive, materialized only into
ignored `.patched/` by `scripts/prepare-patches.py`. No Cargo registry/cache edits,
framework version upgrade or wholesale editor rewrite was needed.

Left/Right, Shift-selection, Backspace and forward Delete use extended grapheme
boundaries via `unicode-segmentation::GraphemeCursor`. The cursor traverses
actual Ropey chunks, supplying preceding context as requested, instead of
materializing the whole document for every key. Existing inline-token/folding
clamps and exact byte/UTF-16 replacement APIs are retained.

Return and Shift-Return are ignored by the action fallback while marked text
exists. A native IME normally consumes these keys first. The guard prevents
fallback newline insertion from ending preedit and making an already queued
Enter event submit the draft. It does not implement or emulate an OS IME.

## Failing-before evidence

- The original combining-accent test expected Backspace on `e` + U+0301 to
  leave `e`. Replaced it with a real correctness assertion (empty value), which
  failed before the grapheme correction and passed after it.
- The synthetic marked-text regression composed Japanese text, then dispatched
  Return and Shift-Return before processing queued effects. It failed before the
  guard: 26 transcript rows instead of 24, proving an unintended local submit.
  The guarded path leaves the preedit intact and sends nothing.

## Focused passing coverage

The production composer is exercised through real Kit key dispatch and its
actual EntityInputHandler, not a separate text-editing model:

- Combining accents, ZWJ family emoji, flags, skin-tone modifiers, Hangul Jamo,
  precomposed Hangul, Indic conjuncts and CRLF.
- Left/Right and both Shift-selection directions, exact selected clipboard
  text, Backspace/Delete, selection collapse, undo and platform redo binding.
- A family-emoji fixture with an asserted cluster split across real rope chunks,
  plus a long regional-indicator fixture requiring preceding chunk context.
- Japanese preedit updates, cancellation, commit, one-transaction undo/redo,
  and local echo only after marked text ends.
- A non-BMP prefix checks UTF-16 surrogate-pair coordinates; Korean `ㅎ → 하 → 한`
  preedit rewrites and subsequent grapheme navigation/deletion preserve focus.
- Existing Shift-Enter/newline, busy draft, pointer-submit and selection tests
  remain in the complete fixture suite.

Commands from the repository root:

```sh
bash apps/desktop/scripts/cargo.sh test --lib --locked composer_tests -- --test-threads=1
bash apps/desktop/scripts/check.sh
bash apps/desktop/scripts/cargo.sh build --locked
```

Final verification passed: rustfmt, strict all-target Clippy `-D warnings`,
all **20** pure/UI tests, native Metal offscreen rendering and the locked normal
binary rebuild. Raw logs are session-local. Source changes remain uncommitted
in this fixture workspace. No visible app was opened by the verification.

Final tracked edit-spec SHA-256:
`158d8c11e9693c0a31be28197fdd8ee5639f7611327ff7688c6dabcc7a4b8f69`.
The combined patch has 18 exact edits in four Base source files, with no
AccessKit/component/platform source patch. The original registry copies were
compared byte-for-byte with the SHA-verified archive and remain unchanged.

## Explicit limits

No visible automation, OS Japanese/Pinyin/Korean candidate-window session or
real Wayland host was available for agent-driven validation. Synthetic preedit
tests verify the input protocol and guard, not macOS text-services routing,
Wayland text_input_v3 behavior, keyboard layouts or candidate placement. Existing
Wayland platform limitations were not silently rewritten in this task.

Typing latency/performance and giant-paste behavior are not measured wins.
The chunked implementation avoids an obvious full-document copy, but no runtime
speedup is claimed. Dedicated AccessKit/TextRun/caret patches, screen-reader
integration and VoiceOver/Orca tests are explicitly deferred, not blockers.
