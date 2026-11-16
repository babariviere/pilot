# Artifacts and attachments

Agents can publish artifacts alongside their replies. Open a chat's artifact card to
inspect it, expand it, or copy supported content. A published card keeps its revision;
the artifact list can open the latest version.

New artifacts are NSH TSX views or images. NSH covers charts, tables, diagrams, UI mockups
and interactive controls.

In ordinary Local Build chats, paste clipboard images or drop supported image files
into the composer. Review the attachment previews before sending. Conversation images
and raster artifacts offer **Copy image** separately from copying source text.

Where the tool offers NSH TSX, it captures and compiles one session-scratch file
before saving a revision. Ask chats can publish NSH too: the tool writes that one
scratch file itself and never touches the project. Compile errors leave history
unchanged. These artifacts show as a preview in the native Day app: on a delivered result's page, the
primary image or native preview opens automatically. Others open with **Preview**. A preview pauses
while it is scrolled out of view and starts again from the same revision when
it shows. Interactions change only that preview's local state; hiding or
pausing it resets them. **Reset** starts it again without changing the saved version.
Failed native previews keep readable source and **Retry preview**. **Inspect source** remains available. Day's
**Artifacts** page shows what the project's chats saved as a gallery, newest
first, and each mission's overview shows its linked artifacts by task. Cards
show the kind, title and revision; opening one shows its preview, image or source.
Search loaded outputs by title, kind or linked task. Compare a previous version
in the gallery, or choose Before and After from a result's pinned outputs.
**Export source…** and **Export image…** save the displayed bytes through the
system Save dialog. Suggested filenames include the saved title and version.
Legacy code exports as text, not executable HTML. Captured previews cannot use
the app's exporter or service access. Images above the saved-reader's 1 MiB
container limit stay unavailable, never shortened; unusually large raster dimensions
are also refused before decoding.
Other clients can still show source without running it.

Agents can no longer create or update native visual, shader, HTML, React or SwiftUI
artifacts. Their existing sources, revisions and provenance remain in history for
read-only inspection and copying. The desktop app still shows older native visuals;
unsupported Mermaid syntax in them shows its source and a reason.

Artifacts are outputs to review, not proof that code was applied, tests passed,
or an external action succeeded.
