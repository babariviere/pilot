# Artifact storage and publication

`ArtifactStore` owns immutable session-local revisions and the durable latest pointer.
The store accepts images, NSH source, native visuals and the standalone shader contract.
The kernel's agent `artifact` tool writes only images and NSH; visual and shader writes
stay in the store for compatibility and fixtures.

HTML, React and SwiftUI publication and preview are removed. Unsupported writes fail
before compilation, rendering or persistence. Browser-library bundling, Chromium
previews and generated SwiftUI compilation are no longer part of this package.

Historical `ArtifactKind` and library provenance types remain broader than
`ArtifactWriteKind`. Reads return exact stored kind, source, revisions, IDs and
provenance without compiling or executing legacy bodies. No migration or deletion
is performed. Images retain their existing derived prepared-document read contract.
The prepared HTML field remains a compatibility DTO, not a browser execution host.

The [host-only retained-visual precheck](../../docs/technical/retained-visual-precheck.md)
keeps the Node QuickJS evaluator and shared schema/checker. It does not use the
retired native visual worker or the [NSH artifact host](../../docs/technical/nsh-artifact-source.md).
For current publication, see the [bundled artifact skill](../kernel/skills/pilot-artifacts/SKILL.md).
