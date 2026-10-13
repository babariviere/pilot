# Image artifacts

Use `kind: "image"` with PNG, JPEG, GIF or WebP bytes, at most **16 MiB** decoded. `libraries` are not supported, and remote URLs are never accepted. The tool embeds the bytes, so the source file need not remain. `get` returns the saved data URL; do not print image base64.

```js
// Ask or Build: an inline base64 data URL.
await tools.artifact({ action: "create", title: "Image", kind: "image", source: dataUrl });

// Build only: a local image path.
await tools.artifact({ action: "create", title: "Generated image", kind: "image", source: "/tmp/generated.png" });
```
