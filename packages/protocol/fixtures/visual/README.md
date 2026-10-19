# Visual API 1 fixtures

Shared by the kernel's pre-check and the app's visual helper. Both run the same runtime,
[`packages/artifacts/src/visual/runtime.js`](../../../artifacts/src/visual/runtime.js), in QuickJS-NG
(quickjs-wasi in the kernel, the C library in the app), so a visual that passes the pre-check renders the same tree
in the app. Design: [docs/native-visuals.md](../../../../docs/native-visuals.md).

- `api-1.schema.json`: JSON Schema (2020-12) of the tree the runtime returns, `{"api":1,"root":Node}`. Generated
  from `packages/artifacts/src/visual/schema.ts`, the source of truth. Every object is closed
  (`additionalProperties: false`); omitted optional props use the defaults in the descriptions.
- `conformance.json`: cases a host must reproduce, and `engine`, the QuickJS-NG release they were produced with
  (hosts embed the same release). Each case gives `source`, `data`, the artifact `id` (the seed text), `now`
  and an optional saved `state`; `steps` lists the first view, then each event with the state keys
  its handler assigned (`changed`) and the next tree; `finalState` is `state()` at the end. `errors` gives the
  first error of failing visuals as `line N: message` (seed text `""`, now 0).

Regenerate both after an intended change, then review the diff:

```sh
PILOT_UPDATE_VISUAL_FIXTURES=1 node --test packages/artifacts/src/visual/fixtures.test.ts
pnpm fmt
```

## Host contract

1. Create a VM with a 32 MiB heap limit, a 512 KiB stack limit, an interrupt handler, UTC as the time zone and no
   `WeakRef`/`FinalizationRegistry`. Do not run promise jobs: visuals are synchronous.
2. Evaluate `runtime.js` as a global script. Its completion value is the runtime API object; keep it, it defines
   no globals.
3. Evaluate `'"use strict";(' + source + '\n)'` as a script named `visual.js`. The result is the visual function.
   Stack frames `visual.js:N` are lines of the source itself.
4. Call the runtime, under these time limits (interrupt when exceeded):
   - `load(fn, source, dataJson, stateJson | undefined, artifactId, nowMs)`, setup, 250 ms. The runtime seeds
     `Math.random` from the id; `stateJson` is a previous `state()`.
   - `render(nowMs)`, view, 250 ms: returns the tree as JSON.
   - `event(id, valueJson, nowMs)`, handler, 100 ms: returns `{"changed":[keys]}`. Then call `render`.
   - `state()`: the reader state as JSON (at most 64 Ki characters), to persist per artifact revision.
   - `logs()`: console lines since the last call, as a JSON array.
5. Report errors as `line N: message`: N comes from the first `visual.js:N` frame of the exception's stack. For
   `VisualError` exceptions the message is the error's message alone; for others it is `Name: message`.
   Interrupts become "the visual function took longer than 250 ms", "the view took longer than 250 ms" or "the
   handler took longer than 100 ms"; out-of-memory becomes "the visual used more than 32 MiB of memory".

## Events

Controls carry `id`, their path of child indices from the root (`"0"` is the root, `"0.2.1"` the second child of
its third child). Send events to ids from the latest tree:

| Node | Event value |
| --- | --- |
| `tabs` | the chosen option's `value` (string) |
| `toggle` | the new boolean |
| `slider` | a number; the runtime clamps it to `min...max` and snaps it to `step` |
| `button` | `null` (ignored when `disabled`) |

Coalesce slider drags to one event per display frame. A handler only assigns to state; the next `render` reflects it.

## Not yet supported

`ui.canvas` and `ui.shader` throw "canvas nodes are not yet supported" and "shader nodes are not yet supported" until
their phases land. They will arrive with a new API version only if the tree changes incompatibly.
