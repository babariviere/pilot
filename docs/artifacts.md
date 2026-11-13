# Artifacts and attachments

Agents can publish visuals alongside their replies. Open a chat's artifact card to
inspect it, expand it, or copy supported content. A published card keeps its revision;
the artifact list can open the latest version.

Native visuals include charts, tables, diagrams, UI mockups, and interactive controls. Rendering
support is limited: unsupported Mermaid syntax shows its source and a reason rather
than pretending a partial graph is complete.

In ordinary Local Build chats, paste clipboard images or drop supported image files
into the composer. Review the attachment previews before sending. Conversation images
and raster artifacts offer **Copy image** separately from copying source text.

Where the tool offers NSH TSX, it captures and compiles one session-scratch file
before saving a revision. Compile errors leave history unchanged. These artifacts
open with **Preview** in the native Day app. Interactions change only that
preview's local state; closing it resets them. **Inspect source** remains
available. Other clients can still show source without running it.

Other new artifacts use images or native visuals. Creating and previewing HTML, React and
SwiftUI artifacts is no longer available. Their existing sources, revisions and provenance
remain in history for read-only inspection and copying, not execution. Shader
rendering remains unavailable in Pilot Next.

Artifacts are outputs to review, not proof that code was applied, tests passed,
or an external action succeeded.
