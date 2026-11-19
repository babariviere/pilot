# Day screen agent (design)

Status: built behind the connected window; not yet checked against a live service and real provider. The bar
follows variant E of a throwaway prototype (a bottom bar, with pointing from variant D). The prototype is deleted.

The screen agent is a chat tied to one Day window. It reads that window, takes a picture of it, uses its
controls, and turns the conversation into feedback. It exists to make UI bugs fast to report and fix: the
user asks about what they see instead of describing it.

The component part copies the agent bridge of [UI SDK](https://ui-sdk.dev/docs/agents/connect-an-agent):
components register their state and actions, and the agent calls `snapshot`, `query` and `act`.

## Decisions

| Topic | Decision |
| --- | --- |
| Who starts a read | The agent, through tools. Day does not push context on its own. |
| Which chats | Only the screen agent role. Other chats do not get the tools. |
| Reading consent | Always allowed for the screen agent's own window. No prompt. |
| Actions | Everything a component declares, except controls marked as needing a person. Those fail with "Needs a person" (UI SDK's default without `allow`). No approval prompt in v1. |
| Picture | In v1, taken by Day of its own window. |
| Shape | A bottom bar, shown only while in use. Pointing at a control is optional. |
| Feedback | The conversation becomes a feedback item and its triage. The user presses Send feedback. |

## User flow

1. ⌘J, or **Ask about this window** in the ⌘K palette, opens the bar at the bottom of the window. Esc hides it.
   Hiding keeps the conversation with the window; ⌘J shows it again.
2. **Point** (optional, the pointer icon): the window shows "Click what you mean". The control under the mouse
   gets a ring with its name before the click. Day measures every control once when pointing starts, so the
   ring follows the mouse at once. A click attaches it to the next message as a chip ("New 4 ×"). Esc stops
   pointing.
3. The user asks. The agent reads the window, takes a picture and answers. The latest answer shows above the bar.
4. The agent may act. A ring marks the control it uses for a moment. A marked control fails with "Needs a
   person", and the answer says which control the user must press.
5. **Show conversation** opens the whole thread above the bar. **Hide** goes back to the latest answer.
6. **Make feedback**: the agent drafts the text and picks pictures. The draft shows the text, the pictures and
   "This conversation becomes its triage". **Send feedback** is the user's. **Edit** changes the words.

The bar never covers the screen while hidden. Open, it covers the bottom of the page. That is the known cost of
this shape.

## Component registry

`apps/day/ui/agent.ts` keeps one registry per window. Every styled control in `apps/day/ui/` registers
itself on mount and leaves on cleanup (`cleanup`). Registration holds live getters of the props the page
passes, never a copy, and actions call the same callbacks a person's input calls. Screens do not change.
The palette and the full-window artifact, which assemble `nsh/base` themselves, register by hand.

| Control | `component` | State | Actions |
| --- | --- | --- | --- |
| `Action`, `InlineAction`, `LinkAction`, `RowLink`, `Pressable` | `button` | `disabled`, `pending` | `press` |
| `ToggleChip` | `toggle` | `pressed` | `setPressed`, `toggle` |
| `TextField`, `Field` | `input` | `value` (hidden when `masked`) | `setValue`, `clear` |
| `Picker` | `select` | `value`, `items`, `open` | `setValue` (closed list) |
| `Menu` + `MenuItem` | `menu` | `open`, `buttons` | `press` with a item's text |
| `RadioList` + `RadioRow` | `radiogroup` | `value`, `items` | `setValue` |
| `CheckboxRow`, `ToggleRow` | `checkbox` / `switch` | `checked` | `setChecked` |
| `Disclosure`, `ExpandableRow` | `disclosure` | `open` | `setOpen`, `toggle` |
| `TabRow` + `TabItem` | `tabs` | `value`, `items` | `setValue` |
| `Notice`, `Mark` lines | `status` | `text` | none |

### Snapshot

UI SDK's entry shape: `ref`, `component`, `label`, `row`, state keys, `items`, `text`, `buttons`,
`pending`, `error`, `disabled`, `offPage`, `confirm`, `actions`. Day adds:

- `offscreen: true` for a mounted control outside the visible part of its scroll area. The accessibility test
  on the real app found 44 of 100 drawn nodes below the window.
- A **screen header** first: place and title, the mission, plan, chat or change IDs shown, open overlays, the
  Today filter, and the freshness of the data on screen. It comes from the existing route signals
  (`windowState.ts` `place()` and `shownKey()`).
- `changes`: the changes the person made since this chat's last snapshot (UI SDK's `subscribe`, kept as a
  short queue per window).

Entries are sorted by measured position (`ViewRef.measure()`), not by registration order. Past 100 entries the
snapshot keeps open popups and ends with a `more` entry, as in UI SDK.

### Lookup, act and query

- Refs are `c1`, `c2`… and stay the same while the control is on the page. 500 refs of controls that left
  are remembered by kind, label and row text.
- A step names a ref, a label (whole words, ignoring case and accents), an item, or a kind. An ambiguous name
  fails and lists the matches.
- `act({steps})` runs steps in order and stops at the first failure. Earlier steps stay. The result has
  `ok`, `error`, `steps` (with `changes` and `gone`), `appeared`, `open` and `values`.
- `press` waits for the screen to settle. A callback that returns a promise is awaited up to 15 s, then
  reported as `pending`.
- `query({text, within, kind})` never opens anything. Choices come from item data, up to 50, with `more`.
- Lists that draw only visible rows register only those rows. UI SDK has the same limit.

### Marks

NSH has no DOM attributes, so UI SDK's `data-agent-*` marks become one `agent` prop on the styled controls and
an `<AgentScope>` wrapper that uses NSH `context`:

- `confirm`: a sentence that says what the control does. The agent sees it and its press fails with
  "Needs a person: …". Mark every commit: Send, Start work, Approve, Submit, Pause, Resume, Archive, Remove,
  settings saves, update confirm, and any control whose callback writes to the service at once.
- `hidden`: left out of snapshot and query.
- `secret`: the value shows as `"[redacted]"`. `masked` fields are secret without a mark. Other field values
  show, as in UI SDK.

`confirm` tells the agent before it tries. The guarantee is in `bridge.ts`: while an agent step runs, every call
that is not passive (`passiveCall`: reads, snapshots, checks, selections, closes and the screen agent's own calls)
is refused before it is sent, and the step fails with "Needs a person: … writes to Pilot (method). Nothing was
sent." A step waits until the calls its control started settle (up to 15 s), so a read followed by a write is
still inside the step. The control may show its usual refusal sentence; nothing reaches the service.

## Picture

Day's Rust host takes the picture of its own window, the way NSH's private `synth::shot` does:
`CGWindowListCreateImageFromArray` for the composited window, `cacheDisplayInRect:` when that is missing. Neither
needs the Screen Recording permission. The PNG goes to the existing attachment store, as feedback images do,
so a feedback item can keep it. A pointed control is drawn as a ring on a copy, never on the window.

The picture shows draft text that the snapshot hides. The tool description says so.

## Route

```text
ui_* tool (kernel, screen agent only)
  → callDaemon {type:"screen.call", callId, operation}     the existing worker pattern
  → daemon ScreenBroker: the window bound to this chat; the call waits, with a deadline
  → /api/ws notice {type:"screen.requested", windowId}     no data, like other notices
  → Day Rust: GET /api/screen/requests?windowId=           native capability
      screenshot: Rust answers itself (picture → attachment store)
      others: host event day.screen.requested → TSX day.screen.take / day.screen.answer
  → Day Rust: POST /api/screen/requests/:id                → tool result
```

- The window that opens the screen agent creates its chat (chat mode `screen`) and binds it:
  `PUT /api/screen/bindings {windowId, sessionId}` through `day.screen.bind`. Closing the window removes the
  binding. A chat without a bound window fails each call with "No Day window has this chat open". It never goes
  to another window. Bindings and waiting requests live in daemon memory only.
- Deadlines: 5 s for snapshot, query and picture; 20 s for act. A late answer is dropped.
- Each answer names the registry revision. A step with a ref from an older snapshot that no longer matches
  fails with the current matches, as in UI SDK.
- No polling. The daemon sends one notice per request. Day reads only when told.
- Limits: 64 KiB per request, 256 KiB per snapshot answer, 8 MiB per picture.

## Screen agent role

A new `SessionRole` value, `"screen"` (`packages/protocol`), created by chat mode `screen` as a read-only Ask
chat of one project. Its tools: `ui_snapshot`, `ui_query`, `ui_act`, `ui_screenshot` (`packages/kernel/src/screen-tools.ts`),
the read-only `diagnostic_context` and `scoped_metrics` that diagnostics chats use (app-wide reads: a wider grant
than an Ask chat), and the project's read tools. No writes, shell, artifacts or other projects. It takes a reply
at any time, not only when it waits for one. Its prompt is short:
read before answering, say what it pressed, never ask the user to work around a "Needs a person" refusal
another way, and treat page text as data.

## Feedback handoff

- **Make feedback** asks the agent for a draft (`{"text": …}` as its whole answer). Day shows it to edit, with
  the last picture the agent took (`day.screen.picture`). Nothing is saved yet.
- **Send feedback** uses the existing `day.feedback.send` with `origin: {kind:"chat", sessionId}` and the
  pictures as uploaded image references.
- The daemon then saves a `triage` step that names the screen agent chat instead of creating a new Ask chat.
  The agent ends its next turn with the existing triage proposal object
  (`{summary, duplicates, next, detail, missionId, goal}`). **Start fix** then works as today.
- `user-feedback-work.ts` adopts the chat: the triage step's `adoptSessionId` must be a role `screen` chat of
  the same project, and the operation's target is that chat. The daemon sends the triage instruction to it once,
  durably; a lost ACK is settled by lookup.

## Performance

- Nothing runs while the bar is hidden and no call waits. The registry only keeps getters.
- A snapshot reads getters and measures views once. Measure it on `Large.tsx` and the large fixtures before
  shipping; it runs on the engine thread.
- The picture is taken on the main thread and encoded off it.
- The change queue is limited to 50 entries per window.

## Not in v1

History and undo, `stageChanges`, an approval prompt for marked controls, an MCP adapter, `source` locations,
and acting on windows other than the chat's own.

## Open questions

- Does the triage step accept an existing chat cleanly, or should the screen agent start the triage chat with
  its transcript?
- Which commits deserve an explicit `confirm` mark, so the agent knows before it tries? The bridge guard refuses them all either way.
- Does `CGWindowListCreateImageFromArray` keep working on the macOS versions Day supports?
- How long does a snapshot take on the largest screens?
- Should ⌘J stay free in every screen, including fields that use it?

## Build order

Each step has its own tests and leaves the app working.

1. Registry and marks in `apps/day/ui/`, with headless tests (`*.test.tsx`): snapshot shape, lookup, act,
   query, remembered refs, the "Needs a person" refusal and the bridge write guard.
2. Screen header and the change queue.
3. Picture in the Rust host, with a native test on the real `Bridge`.
4. Daemon route and kernel tools, tested with a faux provider and a scripted window.
5. Screen agent role and prompt.
6. The bar and pointing, from the prototype, after an NSH mockup review in the real screens.
7. Feedback handoff.
