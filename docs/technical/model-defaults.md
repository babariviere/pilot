# Passive model defaults

`GET /api/models?cwd=…` reads global Pi settings plus exactly `cwd/.pi/settings.json`.
`projectId=…` chooses that project's path instead of `cwd`. It does not read parent settings,
prepare a checkout, or apply the separate `Project.model` override. Clients already receive that
override from `/api/projects`; they must not save resolved values as explicit overrides.

All new fields are optional. Existing `defaultModel` remains the raw configured value and
`ModelOption.thinking` remains the raw scope-pattern pin. Legacy clients can ignore the additions.

| Field | Meaning |
| --- | --- |
| `resolvedDefaultModel` | Core fresh Build Pi selection with no request/project model override, only if present in the returned choices. Uses the pinned SDK `findInitialModel`, including its authenticated default and provider fallback ordering. Missing passive metadata, no model, or an out-of-scope choice means omission, not a guessed first scoped model. |
| `models[].defaultThinking` | Fresh Build chat with that explicit model and omitted thinking: per-model setting, global setting, then the initial SDK model's already-clamped thinking, clamped again to the target model. |
| `models[].modelChangeThinking` | Existing-session `changeModel` with omitted thinking: scope pin, per-model setting, then global setting, clamped to the target. Absent when current session thinking is required. Non-thinking targets always report `off`. |
| `models[].taskDefaultThinking` | Only with `purpose=task-start`: the actual task selector's scope pin, per-model setting, global setting, then `medium`, clamped. |

With `purpose=task-start`, `resolvedDefaultModel` instead describes the task selector's admitted
default: raw configured default or first allowed model when unconfigured. A configured default
outside scope or above the price cap is rejected by task admission and omitted here. It does not
fall back through the SDK's provider policy. Explicit task/project overrides are still separate.

## Existing runtime differences

The SDK Build factory calls `findInitialModel` with **no scoped models**. Scope order and thinking
pins do not choose its initial model/thinking. Fresh SDK thinking uses per-model, global, then
the SDK default (`medium` in the pinned SDK), clamped to the initial model.

`NativeAdapter.open` then applies an explicit model with SDK `setModel`. If the target has no
per-model/global thinking, this retains that initial thinking, not necessarily `medium`. For
example, a non-thinking initial model leaves an unconfigured reasoning target at `off`.
`changeModel` also uses `setModel`, but then applies a scope pin if present. Its unconfigured
fallback is the live session's current thinking. The task selector has its own scope-first
precedence. These differences are preserved, not unified by the catalogue.

This is a snapshot of existing core resolution, not a prediction of restored/continued sessions,
Ask/specialist roles, model-select extension hooks, or settings in a subsequently prepared workspace.
Use the actual session's reported model/thinking once created. No metadata grants model access.

## Read boundary

The projection reuses the catalogue's existing settings/availability read. It invokes only passive
runtime `getModel`, `hasConfiguredAuth`, and `getAvailableSnapshot` for SDK startup resolution.
It does not call `checkAuth`/`getAuth`, resolve a virtual model, construct a session, execute
extensions, request a provider completion, or write settings. Missing/failed passive metadata
omits dependent fields; independently known configured thinking and non-thinking `off` remain.
The existing catalogue runtime creation and availability policy are unchanged.

Synthetic coverage: `model-defaults.test.ts`, `models.test.ts`, `server-model-scope.test.ts`.
