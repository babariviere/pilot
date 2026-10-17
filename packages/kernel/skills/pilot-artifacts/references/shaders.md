# Shader artifacts

Use `kind: "shader"` for animated, Shadertoy-style GLSL. `source` is only the GLSL (at most **512 KiB UTF-8**); `libraries` are not supported. Define `mainImage`, not `main`, and omit `#version`: Pilot compiles GLSL ES 3.00 (WebGL2) with these already declared:

| Uniform | Meaning |
| --- | --- |
| `vec3 iResolution` | Canvas size in device pixels (`z` is 1). |
| `float iTime`, `float iTimeDelta` | Seconds of animation, and since the last frame. |
| `int iFrame` | Frames drawn so far. |
| `vec4 iMouse` | Shadertoy convention: `xy` drag position in pixels; `zw` press position, negative once released. |

```js
await tools.artifact({
  action: "create",
  title: "Soft plasma",
  kind: "shader",
  source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float v = sin(uv.x * 6.0 + iTime) + sin(length(uv) * 9.0 - iTime);
  vec3 color = 0.5 + 0.5 * cos(vec3(0.0, 2.0, 4.0) + v);
  fragColor = vec4(color, smoothstep(0.5, 0.45, length(uv)));
}`,
});
```

- **Publication compiles the shader first.** Errors fail the call with line numbers in your source and nothing is saved; fix them and publish again.
- GLSL ES is strict: write `1.0`, not `1`, for floats, and convert explicitly (`float(iFrame)`). No textures, buffers, `iChannel` inputs or sound.
- The canvas is 16:9, as wide as the chat column (at most 960 px). Alpha is straight, not premultiplied, over a transparent background: output alpha `1.0` for an opaque image.
- It runs at display rate only while visible. With Reduce Motion, it shows a still frame at `iTime` 0, so make that first frame meaningful.
- Keep per-pixel work modest (short loops, few ray-march steps). It runs continuously while visible.

