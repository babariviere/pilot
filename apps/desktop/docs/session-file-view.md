# Read-only file detail from Changes

Expand a canonical Changes row, then choose **Open file** (Tab/Enter also works).
The native detail reads the current workspace file, not the base or a historical
Git revision. Refresh is explicit. Escape or Close returns to the retained Changes
snapshot, restoring mounted composer/navigation focus before removing the detail.
Deleted rows explain why Open file is unavailable. No path field or root browser,
edits, saves, reverts, checkout, shell/Git/filesystem fallback or external opener.

## Audited authority

Swift `SessionFileViewer` calls `ClientDirectory.file`, whose host-resource fence
delegates to `PilotClient.file`. It encodes one query parameter and requires an
exact echoed path. The existing `GET /api/sessions/:id/files?path=…` returns the
protocol `SessionFileContent {path,text,binary,truncated}`. Unlike Changes, this
route does **not** call `assertWritable`: it resolves the session's current `cwd`,
then `RepositoryBrowser.file` scopes a regular file to that root, rejects lexical
escapes/symlinks and checks the opened inode. Its text read caps at 512 KiB.

The native reader keeps immutable Local options (endpoint, daemon and lineage),
chat, captured Changes workspace and exact inventory path. Hello and exact
`GET /sessions/:id` id/cwd checks bracket the file GET. UI request serials and
source-generation checks fence late replies. Replacing/dropping a reader cancels
in-flight reads and coalesces a single command/output slot. A changed endpoint,
home identity, chat or workspace never retargets the existing detail. Hello pins
identity, not authentication. HTTP409 is a server refusal, not identity-drift proof.

These are bracketed snapshot checks, **not an atomic workspace/revision token**.
The existing server cannot prove that the workspace did not change and return
between checks, or that file contents did not change during a read. No backend
contract was changed. Continuous repository refresh remains separate.

## Bounds and honest text

Each JSON response is streamed under a 4 MiB wire cap, including chunked bodies;
oversized/malformed bodies are rejected, never partially decoded. Socket work,
JSON decoding and prefix preparation run on the private reader thread. Redirects,
proxies and automatic retries are disabled, with 2s connect/35s request deadlines.

Only one file detail renders. Text keeps an exact Unicode-scalar-boundary prefix
of at most 32 KiB, 300 LF-delimited lines and 1024 bytes per line. No highlighting,
Markdown or file-controlled links execute. Selectable text wraps within the pane;
the explicit copy action preserves original Unicode, BOM, tabs, CRLF/newlines and
final-newline presence. If any server/client cap applies, the label is **Copy shown
portion**, never whole-file copy. Empty text is a valid complete snapshot.

Binary files have no text surface or copy. The existing server only detects NUL
and decodes UTF-8 lossily. The client therefore refuses C0/C1 controls other than
tab/CR/LF and any U+FFFD, which might represent lost bytes. Genuine U+FFFD text is
conservatively unsupported too. Unsupported encodings never appear as replacement
gibberish. Missing/deleted, refused, unsupported, busy and oversized reads remain
explicit; failed refresh retains the last snapshot under a stale warning.

## Verification

Change → test rationale: bounded parsing/identity/cancellation maps to the nine
`session_file_view` library tests; actual native detail and existing Changes
composition map to the `session_file_view` and `workspace_changes` targets.
`scripts/check-scoped.py --unit session_file_view --test session_file_view
--test workspace_changes --lint` uses shared admission and CPU2/4GiB/private mbx
outputs, compiling production code plus those native targets. CI retains full
suites and registers the new native target. Python CI/scoped orchestration tests
cover the additive registration. No live data writes, daemon/app restart or install.

Native synthetic checks cover 680/1100 light/dark bounds, keyboard Open/Refresh/
Escape, actual Unicode selection and clipboard copy, prefix copy, binary/lossy
states, error retention, deleted rows, preedit opening guard, retained drafts,
streaming/reader anchors, source cancellation and mounted focus restoration.
Offscreen captures are real GPUI fixtures, not OS IME, motion/performance,
screen-reader or Linux/Wayland qualification or user acceptance.
