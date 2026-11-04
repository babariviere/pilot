# Artifacts and attachments

Agents can publish visuals alongside their replies. Open a chat's artifact card to
inspect it, expand it, or copy supported content. A published card keeps its revision;
the artifact list can open the latest version.

Native visuals include charts, tables, diagrams, UI mockups, and interactive controls. Rendering
support is bounded: unsupported Mermaid syntax shows its source and a reason rather
than pretending a partial graph is complete.

In ordinary Local Build chats, paste clipboard images or drop supported image files
into the composer. Review the attachment previews before sending. Conversation images
and raster artifacts offer **Copy image** separately from copying source text.

New artifacts use images or native visuals. HTML, React and SwiftUI authoring and
preview are no longer available. Their existing sources, revisions and provenance
remain in history for read-only inspection and copying, not execution. Shader
rendering remains unavailable in Pilot Next.

Artifacts are outputs to review, not proof that code was applied, tests passed,
or an external action succeeded.
