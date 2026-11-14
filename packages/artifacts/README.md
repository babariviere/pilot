# Artifact storage and publication

`ArtifactStore` owns immutable session-local revisions and the durable latest pointer.
The store accepts images, NSH source, native visuals and the standalone shader contract.
The kernel's agent `artifact` tool writes only images and NSH; visual and shader writes
stay in the store for compatibility and fixtures. Shader rendering is still deferred in Pilot Next.

HTML, React and SwiftUI publication and preview are removed. Unsupported writes fail
before compilation, rendering or persistence. Browser-library bundling, Chromium
previews and generated SwiftUI compilation are no longer part of this package.

Historical `ArtifactKind` and library provenance types remain broader than
`ArtifactWriteKind`. Reads return exact stored kind, source, revisions, IDs and
provenance without compiling or executing legacy bodies. No migration or deletion
is performed. Images retain their existing derived prepared-document read contract.
The prepared HTML field remains a compatibility DTO, not a browser execution host.

Native visuals use the bounded offline QuickJS evaluator and shared schema/checker.
Publication preserves validation, resource limits, revision checks, immutable storage
and durability. See [native visuals](../../docs/technical/native-visuals.md) and the
[bundled artifact skill](../kernel/skills/pilot-artifacts/SKILL.md).
