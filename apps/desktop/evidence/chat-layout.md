# Chat layout refinement

Source base: `af230ba6625eb3cb914a968acf4c6fd3c1ff3846`.

- Shared conversation/editor outer cap grows from 760pt to 960pt, with existing
  insets and responsive minimums. Pages/artifact views retain their 760pt cap.
- Existing recovery, question/model notices, errors and delivery/Unknown text
  move above the unchanged tray. Recovery stays contextual and left-aligned.
  No delivery predicate, immutable envelope, handler or backend changes.
- An optional per-MessageScroller visibility mode reuses Base's existing list
  handle, overlay geometry, idle/fade owner and drag events. Only the transcript
  opts into Scrolling; default/global behavior is unchanged elsewhere.

## Scoped verification

On macOS arm64, through the existing serial slot, pinned Cargo wrapper and
CPU2/4GiB admission:

```sh
PILOT_NEXT_COMPOSER_DIR=/tmp/chat-layout/composer \
PILOT_NEXT_HISTORY_DIR=/tmp/chat-layout/history \
python3 scripts/check-scoped.py --unit chat_editor \
  --test composer_controls --test history --lint \
  --report /tmp/chat-layout/report.json
```

Actual final exit 0, with selected Clippy warnings denied:

| Change/risk | Evidence |
| --- | --- |
| Recovery relocation | Four actual composer scenes, 680/1100 light/dark: error and Unknown region above tray, retained immutable operation, contextual native Recovery keyboard/Space/Escape and mounted focus restoration. |
| Composer preservation | Same four scenes plus 29 editor tests: 76pt tray/34pt input, editor/tray light/dark contrast, Send/Option-Enter/Stop routing, marked text refusal, readonly/pending/error guards and Unicode draft retention. |
| Width/responsiveness | Mounted conversation/editor bounds align at 680/1100; two additional explicit 1600 light/dark windows assert the 960pt cap. Actual theme checked after mounting. |
| Scroll/selection/streaming | Eight history scenes retain selection entities, prepend reading anchors (within 1pt), short-document tail slack, live append/update and Latest; real wheel and scrollbar release request exactly the expected bounded pages. |
| Contextual scrollbar | Four long-history scenes compare actual native pixels after real wheel input and wall-clock idle/fade. Each reports 940 changed thumb-strip pixels and zero idle ink, even with global scrollbar mode forced Always. Global mode restored afterward. |

Matching rustfmt checks passed on edited formatted Rust modules. No full
check.sh, all-native suite, Swift build/test, live Local action or install ran.
This is native offscreen screenshot/input evidence with synthetic content, not
a SwiftUI mock, OS IME qualification, Linux validation or an FPS/RSS benchmark.
No runtime performance improvement is claimed; no new production clock, reader
or scroll owner was introduced.

## Exact-source receipts and visual review

All 312 recorded desktop input hashes matched before/after the final run.
SHA-256 of both input manifests:
`e63914d963c66b2d78cbb064d6526e6da6487325baf07e8bd25cf4c6227733b4`.
Final scoped report SHA-256:
`8b95d13603b4add79531fa034691c0df320125b394ad8329fa6f19c196b03227`.
This evidence document was added afterward; checked source was not changed.

Real 680/1100/1600 light/dark screenshots were reviewed. Conversation and editor
edges remain aligned, light editor stays white on gray, dark hierarchy stays
distinct, and uncertain-delivery information remains visible above the tray.
Screenshots/logs/manifests remain private test outputs, not bundled assets.

Earlier failed fixture receipts were retained: headless `Window::resize` did not
change the mounted width, so cap checks now use explicit WindowOptions; a fade
observation left the thumb hidden before the following drag, so independent
drag interaction is now checked before idle pixel observation. Neither assertion
was removed. Final scoped run passed all selected cases on the exact source.
