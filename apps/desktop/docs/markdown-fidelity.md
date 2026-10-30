# Native Markdown and copy fidelity

The conversation uses the retained Kit Markdown state, the app's typography,
and existing service-link/Mermaid hooks. It does not round-trip ordinary code
through HTML. User input remains literal text. Long-message folding remains
user-only; existing tool/automatic disclosures and parser, row and reading-anchor
ownership are unchanged.

## Copy contracts

- **Copy source** copies the exact loaded message source, including Markdown
  delimiters, indentation, Unicode and final line endings. It is not a claim
  that unloaded older history is included.
- **Rendered selection** follows Kit's existing plain serialization. Emphasis
  markers and code fences disappear, entities/escapes in prose decode, list
  markers are omitted, and table cells are space-separated with row newlines.
  It is not raw Markdown, TSV, or a document-format round trip. Paragraph/block
  separators and prose/mixed keyboard-copy edge trimming are distinct from source
  bytes. A drag starting inside a table cell stays confined to that cell. A drag
  starting outside the table can include it between other selected blocks.
  Ordered starts and nested hanging markers use Kit's depth-based marker style
  (including alphabetic nested ordinals), not literal Markdown marker spelling.
- Fenced code treats HTML, entities, backslashes and Markdown metacharacters
  literally. Markdown consumes the line ending separating its body from the
  closing fence. Copy source retains that original spelling too.

The initial hidden regression reproduced keyboard Copy removing two leading
spaces from an ordinary fenced code body. Kit's generic Copy action used
`trim()`. The scoped patch keeps native projection and serializers intact, but
uses the selected code's literal text when the selection is wholly one ordinary
code block, including a leaf inside list/blockquote containers. Code-only
Select All also retains its body whitespace when those containers hold only
that code leaf.
Prose/mixed selection, Plain/tool text and source-selection formats keep their
existing behavior. This is not a parser replacement or a table-copy redesign.

Nested blocks exposed two additional defects: the code-only query stopped at
the container, and code source mapping greedily aligned body spaces with
container indentation (and applied prose whitespace alignment to literal code).
The query now walks existing container children, refusing a second code leaf
or any selected prose. Block-code source mapping matches the canonical parser's
literal value line by line against source-line suffixes, excluding container
prefixes. Non-literal parser transformations retain the previous mapping path;
they are not newly qualified. Inline code/prose mapping and rendered serializers
are unchanged.

The actual reducer/native stream exercise also exposed parser replacement when
an assistant's live row acquired its committed reader key. The reducer already
aliases that same reserved live row ID, but the view treated any reader-key
change as unrelated. The view now retains its parser for that one-way live-to-
committed alias with unchanged/prefix source. Canonical-reader replacement,
source replacement and chat reset still discard selection; content matching
alone never adopts another row's identity.

## Focused hidden native check

`tests/markdown_fidelity.rs` mounts the actual synthetic LocalViewer with native
text shaping and offscreen rendering, not the unit-test text-system substitute.
The `markdown_fidelity` target covers 680/1100pt, light/dark, short ordinary
fences, nested ordered/unordered lists, aligned tables with a wrapping long
cell, Unicode combining marks/flags/ZWJ emoji, and cross-block pointer selection.
It compares explicit rendered-text expectations independently of exact
source-owned Copy, and exercises keyboard Select All/Copy and reverse dragging.
It also reconstructs the same content through open-fence streaming, canonical
commit promotion and a three-entry older page, checking retained parser/row
identity, selection, reading anchor, draft, focus and simulated marked text.
Paging uses the real Earlier admission and presentation response owner over a
synthetic command channel, including fitting-history slack, not a bare prepend
or real network request. Fixtures are small and deterministic, not giant-source
performance benchmarks.

`transcript_view::markdown_fidelity_tests` checks literal code/whitespace-only
Copy, explicit source-selection mode and unchanged mixed prose serialization
without requiring the native-probes feature. These context tests complement,
but do not replace, the hidden native text-system matrix.

From the repository root, using the existing private-target CPU2/4GiB mbx
admission and a fresh report/capture directory:

```sh
PILOT_NEXT_MARKDOWN_FIDELITY_DIR=/tmp/markdown-fidelity-new \
  python3 apps/desktop/scripts/check-scoped.py \
    --test markdown_fidelity --lint --report /tmp/markdown-fidelity-new.json
```

## Qualification boundary

2026-10-30, macOS27.2 arm64, Rust1.98.1, Kit0.8.1/GPUI0.3.10,
existing unoptimized dev/test profiles: all16 native content cases and all4
stream/commit/page cases passed. The native bounds checks also prove that the
narrow code, long table cell and mixed document wrap taller than their wide
counterparts without changing copy bytes. Reviewed actual light/dark captures
show the existing nested-marker hierarchy and left/center/right table alignment.
No renderer rewrite or new copy control was needed.

Five focused context regressions pass in both ordinary and native-feature paths;
eight readonly and two unmount/stream-selection regressions also pass. Matching
native/production-library Clippy, changed-file rustfmt, normal production build
and CI target-registration checks pass. Full suites remain CI's responsibility.

Headless clipboard assertions are in-memory native event tests, not macOS
pasteboard acceptance. OS clipboard interoperability, real IME, accessibility,
visible motion/FPS, release performance and Linux/Wayland qualification remain
separate. The existing giant-tool-source measurements and limitations in
[tool-source-performance.md](tool-source-performance.md) are unchanged.
Other selection formats and comprehensive Markdown grammar parity are not
newly qualified. Table selection remains plain text, not TSV.

## Nested literal-code corpus

`src/markdown_nested_corpus.rs` defines four small cases: fenced and indented
code in an unordered list, and fenced and indented code in a blockquote. Their
literal body includes two leading spaces, trailing spaces, an interior blank
line, a tab, Japanese text, combining `é`, a skin-tone ZWJ emoji and a flag.
Fenced cases retain a final body newline; indented cases follow the canonical
parser's removal of final line endings. Fixture construction records explicit
source/body byte segments while adding the known container prefixes. Native
assertions compare those independent expectations with canonical source mapping
and actual keyboard clipboard results, never HTML or guessed rendered text.
The indented-list case starts with a `Before` paragraph inside the same item;
the indented quote starts with an empty quote line. These spellings produce
one canonical code leaf. The parser can split an initial-line indented form
into adjacent code leaves; this change does not merge them or change mixed
selection trimming.

The hidden native cases use the same 680/1100pt light/dark production root.
They distinguish code-only Select All (and mixed Select All for `Before`),
partial and multiline forward/reverse pointer selection, code-only selection
beside prose in the same container, mixed prose's existing trim policy, and
exact source-owned Copy. Each case also streams its first code line through
append and canonical commit, actually recycles/remounts the row, and checks
parser identity, literal selection, drafts, focus and simulated marked text.
This is not OS IME qualification. Existing top-level code, whitespace-only,
explicit-source, mixed prose, table-cell confinement and cross-block negatives
remain in the same scoped checks.

2026-10-30, the same macOS/Rust/Kit versions and unchanged profiles above:
all16 nested content cases and all16 nested stream/commit/recycle cases passed,
alongside the existing16 content/four reconstruction cases. Eight context
regressions passed in both ordinary and native-feature paths, including new
mixed/multiple-code negatives and literal source positions with LF/CRLF and
an indented backtick body. Eight readonly regressions passed. Native-target
and ordinary production-library Clippy, changed-file rustfmt, and the plain
locked production build passed, using serial private-target CPU2/4GiB mbx
admission with over80GiB disk free. Actual narrow/light and wide/dark captures
were reviewed for readable code and preserved list/quote hierarchy; no new
chrome, renderer layout, or Copy control was introduced.

These four forms do not establish arbitrary nesting,
all fence/indentation spellings, or full CommonMark compliance. Parent #134
remains open for unrelated content/performance gaps.
