# Settings parity and ownership

This is an inventory and isolated foundation, **not a reachable Settings UI or full Swift parity**.
Audited source baseline: `5bd2498d2cd71fc3b4f864620c31deff2576c2a3`.
No production preferences, daemon endpoints or real account data were accessed.

## Real Swift surface versus Next

`apps/macos/Sources/Pilot/Settings.swift` defines eight general categories and exact-project
pages (`SettingsTab`, `SettingsView`). The removed-project fallback does not select a different
project. Its reusable page/section/row/save-bar views are Swift views, not GPUI components.
Next has no Settings route at this baseline. `app_shell.rs` only points to Swift for project
settings; `appearance.rs::{init_appearance,follow_appearance}` installs the app palettes and
follows OS appearance without a persisted override.

Status terms: **foundation supported** means typed state/storage exists here but is unwired;
**missing** means no corresponding Next Settings behavior; **separate** means implementation
belongs to another authorized owner, not this preferences slice; **deferred** means deliberately
excluded from the current implementation scope. Separate work does not block core Settings.

| Swift category / actual capability | Next status | Storage and authority owner |
| --- | --- | --- |
| Appearance: System / Light / Dark, automatic system switching | Foundation supported; current app follows System only. No new theme application yet. | Swift `AppSettings.appearance` uses `UserDefaults.standard` key `appearance` and `NSApp.appearance`. Next owns its separate preferences file described below, not Swift defaults. |
| Appearance: chat font family/11–22pt; code/tool mono family/9–20pt; live preview; Restore Defaults resets fonts only | Missing. Do not label the new appearance choice as font parity or duplicate Swift's font reset. | Swift `AppSettings` font keys in UserDefaults; font inventory comes from NSFontManager. A later Next implementation needs its own typed preferences and real renderer adoption. |
| Notifications: optional PR-ready notification; Needs you attention remains visible regardless | Missing preference/OS notification integration, not a fake checkbox. Existing Next attention UI is not notification parity. | Swift `notifyWhenPRReady` default false in UserDefaults; OS notification delivery/application lifecycle is separate. |
| Connections: global pi MCP status, invalid config count, check again, browser sign-in/cancel/re-sign-in | Missing; sensitive operations outside this foundation. No credential import or invented endpoint. | `ConnectionSettings.swift`, `HostMcpActions.swift`: daemon-managed Local MCP observations/actions, pi MCP config/sign-in storage. Not Next-owned preferences. |
| Scoped models: Local global enabledModels selection, baseline/hash conflict review and saved intent | Missing; sensitive pi settings mutation remains separate. | `ScopedModelsSettings/Section/State/Store/Transport.swift`: app-owned `scoped-models.json` intent plus daemon `api/model-scope` updates to pi global settings. Project overrides, credentials/default models/running chats are distinct and untouched. |
| Diagnostics: local operational evidence, 7-day feature usage, optional OTLP reporting/analytics, validated endpoint, informational AI budget and clear local diagnostics | Missing Settings controls; no collection/export changes here. | `TelemetrySettings.swift`, `PilotClient` telemetry API: daemon-owned host settings, evidence/queues; native local diagnostics policy follows the accepted settings. Not a Next file-copy operation. |
| Diagnostics: explicitly configure the verified source checkout used for approved repairs | Missing; no automatic checkout selection/import or repair capability expansion. | `DiagnosticRepairProjectSettings.swift`: daemon host/project/origin/revision-checked binding. Each repair still needs separate approval; not a local appearance preference. |
| Energy: keep awake, conditional closed-lid work, status/availability/error | Missing; OS power/helper/admin authority outside foundation. | `EnergySettings.swift`: daemon `loadPowerStatus`/`updatePowerSettings`; power policy and privileged setup are not GUI preference authority. |
| Terminal: Ghostty config use, family override and optional 8–28pt size | Deferred embedded terminal. No controls added. | Swift UserDefaults terminal keys plus Ghostty config/runtime. Do not create Next terminal preferences without a supported terminal. |
| Updates: check/download/verified install/restart, hourly automatic checks, gh/manual Keychain credential access | Separate authorized macOS implementation, unavailable until genuine capability is integrated. The updater foundation owner and subsequent packaging/updater/Updates UI integration owner deliver this, not core Settings. Do not gate core Settings on updater completion or add fake toggles/check/install success. Linux update verification remains deferred. | `Updater.swift`, `UpdateCredentials.swift`: Swift update keys, Keychain, signed bundle/feed and restart lifecycle. Next updater and packaging owners must supply separate app/feed/artifact identity, verified capability and safe persistence/active-work restart contracts before Updates UI consumes them. Never reuse Swift updater state or credentials silently. No real update/restart/release/feed changes authorized by this foundation. |
| Project General / Workspace: name, default model, isolated chat workspace, require PR | Missing Settings editing; canonical configuration/permission-sensitive behavior outside foundation. | `Settings.swift::{ProjectEditor,ProjectSettings}`, daemon project records/`updateProject`. Explicit project ID and lifecycle generation must fence every result; removing a project must not retarget another. |
| Project Environment: repo-declared toolchains/setup, host overrides, ignored files, built-in database plan | Missing; host setup/execution not local appearance authority. | `EnvironmentSettings.swift`: daemon environment discovery/plan/update; app last-known cache is not canonical configuration. |
| Project integrations: Slack channels/mention/group filters and labels/corrections; Linear team/state mappings/sizing guides | Missing Settings editing; existing read-only surfaces are not configuration parity. | `TrackingSettings.swift`, `LinearStateMappingSettings.swift`: daemon project tracking/triage state and external integration contracts. No side effects or sign-in shortcuts added here. |
| Project Databases: environments and approval policy | Missing; database credentials/grants/approvals outside foundation. | `DatabaseSettings.swift` and PilotCore types: exact host/project daemon settings, never Next appearance state. |
| Project Add / Remove / Show in Finder; unsaved/save/revert/error/updated-elsewhere states | Missing Settings flows. Swift remove preserves chats/folder; this inventory is not authority for removal/setup. | Swift folder picker/Finder plus daemon project creation/deletion. Next must retain project identity, drafts, preedit and reader state through navigation. |
| Retired devboxes / Control | Excluded, not parity backlog. Preserve historical identity/content; never restore remote execution or Control. | Existing retained history stays with its original qualified owner. |

## Next-owned state paths and integration contract

Existing `src/delivery_store.rs::Store::default_path` selects macOS
`~/Library/Application Support/Pilot Next` (Linux eventual
`${XDG_STATE_HOME:-~/.local/state}/pilot-next`). Its `state-v1.json` and `owner.lock` belong to
draft/delivery durability. Do not modify or reuse that lock for Settings. Existing `appearance.rs`
owns theme application/OS observation, and the shared `ui` components own presentation contracts.
This module does not import either, create a second component layer, or register in `lib.rs`.

`SettingsStore::new(explicit_root)` only stores a path. Future integration should supply a
dedicated **`settings` subdirectory** of the Next-owned state root above, after resolving an
absolute nonsymlink path on its background owner. The immediate parent must already exist;
the store intentionally does not recursively create arbitrary ancestors. No production path is
resolved or opened by these tests or constructors. No Swift defaults import/migration exists.

Files within that root:

- `preferences-v1.json`, private 0600, maximum 1024 bytes, strict JSON:
  `{"version":1,"preferences":{"appearance":"system"}}`.
- `settings-owner.lock`, private zero-length 0600, per-save nonblocking advisory lock.
  Never unlink this inode. All writers must use this API, not raw file replacement.
- `.preferences-v1.pending`, one exclusive-create 0600 staging file. Normal completion and
  owned pre-rename failure remove it. A pre-existing interrupted staging file is preserved and
  blocks writes with `RecoveryRequired`, rather than being silently discarded; manual recovery
  is not supplied here.

New directories are 0700. Existing nonprivate, foreign-owned, symlink, nonregular or multiply
linked state is refused without chmod/repair. Snapshot reads take at most 1025 bytes and reject
unknown/duplicate fields, malformed/unknown values and unsupported versions; these never become
empty defaults. Missing state alone loads System without writing. Every save must follow a
successful load, then re-read/compare the exact baseline under lock. A deletion/change/invalid
snapshot or replaced loaded directory is a conflict/error, not consent to overwrite it.

The adapter uses the existing draft store's nofollow/nonblocking/private-mode/atomic-replace
and file+directory fsync patterns, with fixed-name `openat`/`renameat` confinement to an opened
directory. It does not promise a filesystem sandbox against a hostile process with the same UID
mutating ancestor paths, or cross-machine/network-filesystem lock semantics. Use local app-owned
storage only. No directory scan or unbounded retry queue is created.

## Pure state and nonblocking handoff

`Preferences { appearance: AppearancePreference::{System,Light,Dark} }` is the entire supported
schema. No theme changes occur while constructing, loading, editing or saving it.

1. Own one `SettingsState` on the UI side, one `SettingsStore` on a background worker. Both have
   side-effect-free construction. `begin_load()` marks loading; send `store.load()` off-thread,
   then `finish_load(result)`. Failed load keeps writes/editing disabled and can be retried.
2. On a successful missing load, `loaded=true`, `current=System`, `committed=None`, `dirty=false`,
   `persisted=false`. Loaded existing data has a real committed baseline. `set_appearance` is a
   pure edit. Apply System/Light/Dark through the existing appearance owner later, not inside
   components/storage; keep OS following conditional on System. That wiring is still missing.
3. Explicit Save calls `begin_save()`. It returns at most one opaque `SaveRequest`, with a
   captured `preferences()` payload. Run `store.save(payload)` off-thread, then pass the same
   receipt/result to `finish_save`. Duplicate/stale receipts in that state are ignored; newer
   edits are never replaced by an older completion. Caller must also fence the component/window
   lifetime: receipts must never be routed to another state instance, path or reopened window.
4. `saving`, `dirty`, `persisted`, `committed`, `error`, `unconfirmed` and `loading` expose distinct
   UI states. A failure keeps the last acknowledged committed value and unsaved selection.
   `SettingsError::message()` is stable/content-free, not a raw path or OS error. Retry uses
   `begin_save()` again. Clean saves are not scheduled. Revert only resets to the last baseline
   (System for missing state), never to imported Swift values; it cannot hide an in-flight or
   unconfirmed write.
5. A failure **after rename** returns `DurabilityUnknown`, not success or a claim the old disk
   bytes survived. State keeps the old acknowledged baseline and exact unconfirmed payload.
   Retry confirms/fsyncs those bytes before acknowledging, even when a newer edit is queued;
   only then can a separate save commit the newer selection. External changes block recovery.
   A fresh process can read the actually visible valid snapshot normally. No autosave/service,
   automatic recovery overwrite or updater restart policy is introduced.

## Next UI acceptance, still outstanding

The future UI must consume the shared design system, not copy Swift widgets or add another
component layer. It needs a discoverable native Settings route/Cmd-comma, category/focus state,
coherent detail widths, real supported controls and readable explicit gaps. Test 680/1100
light/dark, long labels, loading/saving/error/disabled states, pointer/keyboard/IME, preedit/draft
preservation, reader anchoring and exact removed-project identity. Ground before/after in actual
GPUI renders; static captures do not prove motion. This foundation supplies none of that route,
theme wiring, UI evidence or acceptance, and it must not be presented as full Settings parity.
