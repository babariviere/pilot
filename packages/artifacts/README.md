# Artifact storage and publication

`ArtifactStore` owns immutable session-local revisions and the committed latest pointer.
It publishes and reads images and captured NSH source. Image revisions store their bytes
once and rebuild the sandboxed image document on read. Exact captured reads return the
numbered container bytes without preparing a preview.

HTML, React, SwiftUI, shader and visual artifacts are unavailable. Their files and
chat references are left in place. No migration or deletion runs.
