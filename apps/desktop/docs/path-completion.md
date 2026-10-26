# Composer path completion: contract audit

Status: blocked on an absent session-scoped listing/completion API. No composer
completion UI, filesystem reads, transport routes or input hooks were added.
This audit covers source at `c3b6e2779acdd7211fc2dbad92decff16e9c30fb`.
Slash commands are outside this feature.

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

There is no session-scoped path candidate/listing route in the audited daemon
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

## Blocker and verification boundary

The approved scope permits wiring an existing safe contract only. Implementing
the required session-root candidate source and its refusal semantics would
require new backend capability and separate authorization. No partial chooser
is mounted and no empty-result claim hides the missing API. Existing composer,
draft, send, steering, queue and recovery behavior remains unchanged.

If that capability is separately authorized, retain exact home/daemon/lineage,
chat/cwd, source generation, draft key, edit intent, token, full text and
selection fences through response publication and pointer/keyboard acceptance.
Debounce/cancel bounded token reads; no polling. Use native Kit and existing
theme/geometry, with no layout or send-side-effect changes. Then verify pure
range/source fences, bounded faux-loopback transport, and the mounted production
composer at narrow/wide sizes in both themes, including IME, late responses,
source switches, Escape, typing, undo, pointer acceptance and no-send assertions.
Those implementation checks were not run or claimed for this documentation-only
audit; no live API calls, app launches or native rendering were needed.
