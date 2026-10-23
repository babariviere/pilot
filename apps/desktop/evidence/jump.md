# Bounded Local resource jumps

Cmd/Ctrl-K is a read-only jump palette, not a general action launcher or full
Swift palette replacement. It projects existing loaded Local pages, configured
project IDs and chat IDs only. It never treats folder equality as identity.
No transcript scan, new endpoint/subscription, private review marks, provider
reasoning, canonical write or inferred authority is involved in building/search.

## Behavior and boundaries

- Pages: global Home, current-scope-preset Inbox, global All chats and current
  configured project's Overview. Projects switch the existing browse-only scope,
  restoring its existing state. No cwd/permission/creation authority is inferred.
- Search follows Swift's grouped best-token score direction: title above context,
  prefix/word-boundary above substring, equally good resources before chat groups,
  exact chat titles not artificially demoted, stable source order for ties.
  Unicode NFKD/combining-mark removal/lowercase handles case, accents and width;
  this is not a claim of every locale-specific Foundation folding equivalence.
- Empty search shows pages/projects and up to three recent writable, nonarchived
  chats other than the selected reader. Explicit queries can find archived or
  retained read-only chats; existing reader/write restrictions remain unchanged.
- Up to256 projects/1000 summaries, at most1259 catalog entries and six rows per
  each of three groups (18 matches), virtualized. Queries stop at240 scalars or32
  words, with explicit refusal rather than truncated-prefix matches. Normalized
  labels/indexes are built off-thread; bounded search also runs off-thread.
- The palette exists only while open, uses existing feeds and creates no timer or
  hidden subscription. Cancellation drops pending work; weak allocation identities
  fence source reuse without retaining obsolete full summary/cwd payloads.
- Async results are ticketed. Source/scope/selected-owner and current live query
  are checked before activation. Pointer closures capture the rendered destination
  and ticket, not a changing index. Refresh retains keyboard identity or clears
  a missing selection, never selecting its replacement by row number.
- Opening refuses editor/folder/sidebar-search preedit. Palette preedit refuses
  Enter, Escape, toggle and pointer navigation before focus can change. Ordinary
  typing and clipboard shortcuts stay native; Tab stays in its sole search focus.
  Existing guarded navigation captures draft/reader state only on an explicit
  jump. Closing restores previous focus, without changing the reader/history.
- Search/opening the palette does not create, send, Stop, approve, retry, check
  receipts, mark read, archive, merge or reconfigure anything. Explicit chat open
  alone uses the existing reader contract, including possible server-side PR
  refresh. Loopback + Origin rejection/identity pinning is not authentication.

## Verification

Focused commands (synthetic/faux channels only):

```sh
cd apps/desktop
bash scripts/cargo.sh test --locked --lib jump:: -- --test-threads=1
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
bash scripts/cargo.sh test --locked --features native-probes --test jump
bash scripts/check.sh
```

Initial verification is in progress; no pass or delivery claim yet. Native scenes
exercise the production root at680/1100pt, light/dark, and never open a visible
window or access real Local/private state. The separate SwiftUI artifact is a
labelled static reference, not GPUI/rendering or acceptance evidence. Offscreen
checks do not establish OS IME, macOS15 hardware, visible smoothness, full Swift
parity or a CPU/RSS win. HTML/browser, shaders, terminal, Linux verification,
updater/release/default switch and Swift removal remain excluded.
