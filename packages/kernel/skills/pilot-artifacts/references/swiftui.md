# SwiftUI artifacts

Use `kind: "swiftui"` with self-contained Swift defining `struct ArtifactView: View` with a zero-argument initializer. SwiftUI, AppKit and Foundation are imported for you. No project imports, package dependencies, `@main` or `#Preview`. Avoid **`@State`**, because Command Line Tools lack its macro plugin; use `@StateObject` if you need state. Source is at most **512 KiB UTF-8**; `libraries` are not supported.

Rendering needs macOS 14+ and the Swift Command Line Tools, independently of Chromium. It compiles in a disposable sandbox without network or workspace/credential access. A cold SDK compile can take minutes, so do not set short codemode deadlines.

`create` and `update` save the Swift source and a **content-sized PNG at 2× resolution**. Layout is bounded to 760 points wide and 1600 tall by default, and smaller content hugs its natural size. Preview `width` and `height` set maximum layout dimensions, not a fixed canvas. Screenshot dimensions are physical pixels; `contentHeight` is logical points.

The result is a **static screenshot**, not an interactive app or a check of the real project views. Say so when presenting a prototype. Offscreen ImageRenderer does not capture embedded AppKit/WebKit views, so prefer SwiftUI layout primitives and look at the screenshot for unsupported controls. Give charts and other flexible content an explicit height. Compiler and render errors are reported, and publishing also renders, so fix them before publishing.

Content sits at the top left of a transparent canvas; add a background inside `ArtifactView` when it is part of the design. Resizing a saved bitmap scales it; reflowing needs a new render at the new width.

```js
await tools.artifact({
  action: "create",
  title: "Native card",
  kind: "swiftui",
  source: `struct ArtifactView: View {
  var body: some View {
    VStack(alignment: .leading) {
      Text("Preview").font(.title)
      Text("Native SwiftUI layout")
    }.padding(24)
  }
}`,
});
```
