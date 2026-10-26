# User long-message disclosure

`message_fold*` owns long user-message presentation, not source
storage, Markdown, tools, work, links, images or artifacts. Assistant messages
always remain fully expanded, including streaming and committed replies, and
never expose a folding control. Swift's
`CollapsibleMessage`/`MessagePreview` supplied the threshold vocabulary:
more than1600 graphemes or16 lines, preview up to800 graphemes/8 lines/3200
UTF-8 bytes. Native segmentation first bounds work to6400 scalars/25,600
bytes, discarding the final potentially incomplete grapheme. A giant combining
cluster can therefore produce an empty preview, never a broken cluster.

The collapsed parser receives only escaped plain-prefix HTML, not full Markdown
under a clipping mask. Selection copies only the labeled source preview.
**Copy full source** copies the exact loaded source, including whitespace and
line endings. This does not recover source already omitted by the existing
1MiB per-message and8MiB aggregate reader admission limits. Those refusal placeholders
remain unchanged. Expansion uses the existing full-source renderer and limits.

Intent is window-local and bounded to512 entries/16MiB (source plus preview
HTML), qualified by Local home/daemon/lineage/port, exact chat, canonical
entry/model/block identity. It survives allocation-ID changes, prepend,
virtualization, same-chat reset/reconnection and source extensions. A different
source revision resets its own default, not another row's state. Evicted intent
returns to the default when loaded again. Ambiguous canonical identities never
adopt a disclosure. Uncommitted local user rows lack committed identity, so
remain expanded without an identity-unsafe disclosure. Once committed, a new
long user message receives the default preview. Already known short user rows
do not automatically fold when extended past the threshold.

Kit Buttons provide a calm chevron and explicit Show more/Show less action.
Both Show more and Show less follow the message body, after the preview or the
expanded content respectively.
Enter/Space toggle within the mounted disclosure; Escape collapses it. These
keys cannot submit the composer. Pointer disclosure is guarded before sibling
IME blur, and mutation rechecks source/key/history generation. Focus moves to
the mounted disclosure wrapper before parser replacement. Existing
hold-for-disclosure runs before remeasurement/notification, retaining reading
intent rather than jumping to the new bottom.

Loaded-source Find is independent of folding: it still searches the unchanged
loaded sources under its existing caps. Explicit navigation shows its exact
source-match excerpt in the row header, even when that result lies beyond the
prefix. The match context wraps instead of using the ordinary metadata's
single-line truncation. It does not silently change expansion intent or pretend the Markdown
body is highlighted. Find count/coverage and Copy source semantics are unchanged.

Verification rationale: pure boundary/identity/source tests plus the mounted
production reader at680/1100 light/dark cover bounded parsing, disclosure,
copy, selection, Find, stream/prepend/reset, focus and sibling composition.
The existing Find and disclosure native targets cover composition with their
owners; matching strict Clippy and a production build cover the new seam.
Synthetic offscreen frames are not OS IME, performance, Linux or release proof.
