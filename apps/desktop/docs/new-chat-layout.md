# Focused new chat

The screen's job is to choose an explicit project and Ask/Build mode, then write
and create a chat. It is not an empty conversation or a technical setup form.

## Composition

`new_chat_view.rs` composes the app-owned heading, the visible project list
(`chat_projects.rs`, a searchable Kit List) and the quiet Add project action. LocalViewer
centers this existing editor in a bounded 760pt column, with overflow available
for long drafts or recovery. Existing conversations retain their layout.

- Subtract the conversation toolbar, contradictory “Choose a chat” empty state,
  permanent Details footer, repeated project label and routine saved notices.
- Retain the same ChatEditor, textarea, native selection, draft key/revision,
  project identity, delivery operation, autosave and guarded submit path.
- Projects are visible rows (name, then folder), so one click chooses one and
  the chosen row is checked; there is no dropdown to open first. About five rows
  show, the rest scroll, and the search field filters by name, folder or ID.
  Duplicate names add the ID. Missing/changed projects, loading, catalog failures and
  delivery recovery stay visible. Loading, failed and empty catalogs, and sent
  drafts, show their notice or destination caption instead of rows.
  Error/Unknown and recovery actions remain above the tray.

The editor stays white on gray (card/tray in dark mode), with its existing
76pt empty tray and 34pt input. Project and mode controls live outside it.
Model/thinking controls retain their existing scope and native Select behavior.
A new chat has no reported context; the existing-chat gauge remains unchanged.

Tab reaches the project search, Add project and composer controls. In the
search field, arrows move the highlight and Return chooses it (then clears the
filter); arrows alone never change the project. Escape clears the search and
returns to the composer without changing the project. Metadata captures marked
input before sibling blur, so a click during composition changes nothing;
project callbacks retain their preedit and pending/immutable-draft fences.
Choosing is local to the draft: it never creates, sends or sets anything up.

## Synthetic verification

`new_chat_view` paints the real LocalViewer at680/1100 in light/dark, captures
before/chosen/after, and checks centering, alignment,76/34 geometry, single
pointer clicks (separate move/press/release events with frames between),
keyboard search/arrows/Return/Escape, project changes with zero writes,
model/thinking, mode, Unicode/preedit, focus, retained new/existing navigation,
explicit send and pending/Unknown/error controls. Its model reads are against an
owned faux loopback service; all writes go to a recorder, not Local data.
`project_creation` separately exercises actual admission/private-store contracts
with an owned faux daemon, including empty/unavailable catalogs and lost ACK.
`composer_controls` protects existing-chat Send, queue, Stop and geometry.

These checks are not OS IME, visible smoothness, performance, Linux, installed-app
or user acceptance proof. No animation policy, backend or storage contract changes.
