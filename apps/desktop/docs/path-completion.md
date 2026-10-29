# Composer path completion: contract audit

The initial audit below found no safe candidate API at
`c3b6e2779acdd7211fc2dbad92decff16e9c30fb`. The user subsequently authorized
the narrow read-only session API described here. Slash commands remain outside
this feature. The client never reads filesystem paths directly.

## Authorized session contract

`GET /api/sessions/:id/path-candidates` requires exact `daemonId`, `lineageId`,
`cwd` and a literal relative `prefix`. Hello advertises
`capabilities.sessionPathCandidates: 1`; missing capability means unavailable,
never a fallback to older routes. The response echoes `sessionId`, `cwd`,
`prefix`, `daemonId`, `lineageId`, plus `entries: {path, directory}[]` and
`truncated`. It is a read, not a durable mutation receipt or workspace lock.

The server checks the existing Changes admission before and after enumeration,
also refusing absent/parked/starting/failed workers, archival and cwd mismatch.
It never opens a worker, emits session changes or runs commands. Candidates
come only from that session's cwd. No home/project roots, parent traversal,
absolute paths, tilde expansion, symlinks or shell/URL interpretation. Hidden
entries require a dot prefix. Root-relative paths use strict lexical components
and existing no-symlink `scopedPath`, with canonical directory/device/inode
revalidation around enumeration. This is not an atomic filesystem snapshot or
authentication, and candidates may cease to exist immediately after the read.

Limits: two concurrent server enumerations, 512 scanned directory entries,
eight matches, 1024 UTF-16 prefix units (client also caps UTF-8 at 1024 bytes),
255-unit entry names. The bounded subset
is sorted after scanning; `truncated` means coverage is incomplete, not that
the returned subset is the global alphabetical first eight. Client replies are
capped at 16 KiB and eight direct-child candidates, with exact response identity
and a second hello check. Redirects, proxies, retries and alternate-root/host
fallbacks are disabled. Requests time out after three seconds.

### Refusal diagnostics

The composer reports the HTTP status and the daemon's existing `error` text
instead of replacing every non-200 response with a generic refusal. Error
bodies share the 16 KiB response bound; displayed reasons are plain text,
control-free and limited to 512 characters. Missing or malformed error bodies
retain the HTTP status and explicitly say no reason was returned. The daemon
version from the verified hello is included when present. This is diagnostic
data, not proof of compatibility or permission.

A missing/unsupported `sessionPathCandidates` capability stops before the
candidate request and points to Settings → Updates. An advertised capability
with the existing `404 / Not found` response is described as a missing endpoint,
not assumed to be an older daemon. Other refusals retain their actual reason,
including mismatched identity/cwd, unavailable active Build workspace,
read-only mode, symlinks, filesystem access errors and busy reads. No refusal
starts a worker, changes a guard, retries, updates a daemon or uses a fallback.

The reported cropped screenshot alone does not identify which guard refused
the user's request. Compatible synthetic idle/working Build sessions succeed;
parked/starting/failed sessions still refuse. The user chose improved diagnostics
followed by a retry. This change does not claim to fix an unconfirmed backend
regression or qualify the user's installed daemon.

## Native composer behavior

Tab explicitly opens suggestions for a supported collapsed-selection token in
an existing Local chat. Typing refines the open chooser after a 120 ms debounce;
replacement cancels the old future, and idle input never polls. Up/Down selects,
Tab/Enter inserts, Escape closes. Loading/empty/refused results stay quiet and
never become a send. A source generation/home/daemon/lineage/chat/cwd change,
selection move or blur invalidates suggestions. New-chat/project-root completion
is intentionally unavailable, since no admitted session cwd exists yet.

The native completion surface uses existing Kit Buttons/theme tokens above the
unchanged editor tray. Pointer acceptance prevents sibling blur and checks
preedit. Native Input action capture precedes Enter/Tab/Escape handling; the
preedit guard runs before Escape can unmark composition. Acceptance compares
full text, selected range, token, draft key, edit-intent serial and exact source
again. It replaces only the captured UTF-16 range through the native input
handler, not `set_value`; normal undo, Change-driven draft autosave and immutable
send/queue/steering envelopes remain the owners of their existing behavior.
Quoted tokens and escaped spaces retain surrounding text; unsupported delimiter
names are refused rather than silently rewritten. Paths are inserted as text,
never sent or executed. No automatic single-match insertion occurs.
The literal prefix must be nonempty: `./R` is supported, bare `./` is not;
directory tokens such as `src/` can list that subdirectory. The client is not a
shell parser and does not complete selections, mid-token suffixes or expansions.
Completion capture is bounded by the existing 32 KiB draft limit before text
materialization. Tab on an oversized draft neither queries nor mutates it;
acceptance also refuses a replacement that would exceed that limit.

### Verification scope

The focused checks cover the new pure token/source model, bounded faux-loopback
reader, actual mounted production LocalViewer/ChatEditor, and backend admission
and enumeration. Existing composer-controls and new-chat native journeys cover
the shared Input hook after integrating the separately owned new-chat layout.
Matching strict Clippy and a normal production-feature build verify both
feature configurations; no broad desktop suite or Swift rebuild is warranted
for these bounded input/read additions and type-only Swift mirrors. CI retains
the full gates. Captures are actual offscreen GPUI rendering at 680/1100 in both
themes, not a SwiftUI mock. No live daemon data, account or filesystem candidate
source is used by these fixtures. Full OS IME, performance and Linux acceptance
remain unverified.

The final focused native batch passed six pure/transport tests and four mounted
completion flows (680/1100, light/dark), plus the existing `composer_controls`
and `new_chat_view` targets. The completion flow covers Up/Down, Enter/Tab,
pointer acceptance, Unicode surrounding text, undo, exact stale callback refusal,
typing refinement, retained IME/preedit on sibling click and Input Escape, and
an actual delayed response canceled across source generation change. All
flows also paste an oversized draft with native Cmd-V and verify Tab makes no
query or text mutation. All
completion flows assert no send/create/queue/stop commands. Three backend tests
cover literal candidates, directory/concurrency caps, symlink cwd refusal,
daemon/cwd identity and repeated session admission without worker commands.
The unchanged repository-browser tests also pass. TypeScript typecheck and
matching strict native Clippy pass; 46 CI registry and 22 scoped-wrapper checks
pass. Evidence commands:

```sh
node --test packages/daemon/src/path-completion.test.ts packages/daemon/src/repository-browser.test.ts
node_modules/.bin/tsgo --noEmit
cd apps/desktop
python3 scripts/check-scoped.py --unit path_completion --test path_completion --test composer_controls --test new_chat_view --native-probes --lint
```

Actual native images are attached to the task. No packaged app was installed,
launched or restarted. Production-build completion is recorded with the landed
commit on the task, separate from the native-probes build.

## Initial audit

## Actual Swift behavior

- `apps/macos/Sources/Pilot/ChatView.swift` passes `session.cwd` as
  `completionDirectory`, or nil for Ask and non-Local contexts.
- `ChatTextEditor.swift` calls `PilotCore.PathCompletion` directly on Tab or
  AppKit completion. It does not call `PilotClient` for path candidates.
- `PilotCore/PathCompletion.swift` finds a collapsed-selection token using
  UTF-16 ranges, whitespace, quotes and escapes. A caret inside a token suffix
  is refused. Candidates come from `FileManager.contentsOfDirectory` and
  `fileExists`, relative to the supplied directory. That helper also supports
  absolute paths, tilde, parent traversal and directory symlinks. Those behaviors
  are not authority for equivalent Next filesystem access.
- A single match inserts immediately. Multiple matches use the non-activating
  `CompletionPicker` panel, at most six visible rows, positioned within the
  screen. Arrow keys select; Tab/Return insert; Escape dismisses. The path
  callback compares captured text and selection before `insertText` replaces
  its captured range. Text changes, directory changes and focus loss dismiss
  the path picker. This is not a daemon/source-generation/edit-intent fence.

## Existing HTTP contracts are not a completion source

The routes are in `packages/daemon/src/server.ts`, backed by
`repository-browser.ts`; shapes are in `packages/protocol/src/repositories.ts`.
Swift exposes them through `PilotClient.repositoryDirectory` and `.file`,
neither of which is used by `PathCompletion`.

| Existing GET | Actual scope and result | Why it cannot supply this feature |
| --- | --- | --- |
| `/api/repositories/directories?rootId=…&path=…&offset=…` | Home by default, or a project root resolved by project ID. Non-hidden directories only; 4096 scanned entries, 100 per page, four concurrent browser reads. Strict relative paths and no symlink components. | No session/cwd admission, no regular files, and no Ask/parked/recovery refusal contract. Mapping a chat to a home/project root would substitute a different scope. |
| `/api/sessions/:id/files?path=…` | Reads one already-known relative regular file under `session.cwd`; 512 KiB text cap, binary/truncation flags, no directory listing. | Cannot discover candidates. Calls `sessions.get`, not workspace write admission; does not inherit the Changes refusal contract. Never probe guessed filenames to simulate completion. |
| `/api/sessions/:id/changes` | Uses `sessions.changeBase` and its workspace admission, returning repository changes. | Changed files are not a directory/completion inventory. Reusing this would misrepresent coverage and cannot implement the requested path source. |

There was no session-scoped path candidate/listing route in the audited daemon
or protocol. Hello identity checks cannot turn the project/home directory API
into a session-scoped grant. Neither a matching project path nor a successful
file read establishes the missing completion authority. Do not fall back to
direct filesystem reads, home/project enumeration, Changes, or guessed paths.

## Next input and durability hooks audited

- `src/chat_editor.rs` owns the production `Entity<TextareaState>`, selected
  draft key, cache and revision, plus Input Change/PressEnter subscriptions.
  `record_edit` increments the draft revision and queues a private draft save;
  `load_input` uses `set_value` for source changes, not user insertion.
- `submit_mode` captures the existing immutable draft delivery request. Enter
  steers/starts; the input wrapper captures Option-Enter for follow-up queueing.
  A future completion handler must consume acceptance before either path and
  must never invoke submit, create, retry, Stop or queue commands.
- `marked` checks textarea, cwd, questions and picker preedit. A future popup
  must guard preedit before sibling pointer blur and capture the native Input
  Escape action before Input unmarks it; raw-key handling alone is insufficient.
  See the existing action capture in `src/queued_message_view.rs`.
- `src/interaction.rs` owns bounded private autosave (250 ms idle debounce).
  Completion acceptance must use native range replacement, preserving undo
  and Change-driven autosave, not replace the entity or call `set_value`.
  `src/queued_message_probe.rs` exercises native `replace_text_in_range`;
  `src/composer_tests.rs` covers selection, graphemes, undo and preedit. AppKit
  UTF-16 offsets must not be copied into Kit's byte-based `selected_range`;
  the input-handler UTF-16 range interface is a separate boundary.
- `src/local_client.rs` supplies Local home/daemon/lineage discovery and hello
  verification. `src/session_file_view_reader.rs` brackets known-file reads
  with hello and exact chat/cwd checks, cancellation and generation fencing.
  That is a useful transport pattern, not a candidate API or atomic workspace
  proof. Content equality alone cannot fence an edit-away-and-back intent.

## Original blocker and verification boundary

The original scope permitted wiring an existing safe contract only. The missing
session-root source blocked implementation; a documentation-only audit was
published as `f0d7173776868f390b1ea542d755a5f3994a9f5c`. The user's subsequent
explicit authorization permits only the new bounded API above, not general
backend capabilities or client filesystem access.

Verification must retain exact home/daemon/lineage,
chat/cwd, source generation, draft key, edit intent, token, full text and
selection fences through response publication and pointer/keyboard acceptance.
Debounce/cancel bounded token reads; no polling. Use native Kit and existing
theme/geometry, with no layout or send-side-effect changes. Then verify pure
range/source fences, bounded faux-loopback transport, and the mounted production
composer at narrow/wide sizes in both themes, including IME, late responses,
source switches, Escape, typing, undo, pointer acceptance and no-send assertions.
The initial documentation-only audit did not claim those implementation checks.
Implementation evidence is recorded separately on delivery. Synthetic native
tests do not establish OS IME, performance, Linux support or user acceptance.
