# Focused new chat

The screen's job is to choose an explicit project and Ask/Build mode, then write
and create a chat. It is not an empty conversation or a technical setup form.

## Composition

`new_chat_view.rs` composes the app-owned heading, native project Select,
quiet Add project action and Kit single-selection ButtonGroup. LocalViewer
centers this existing editor in a bounded 760pt column, with overflow available
for long drafts or recovery. Existing conversations retain their layout.

- Subtract the conversation toolbar, contradictory “Choose a chat” empty state,
  permanent Details footer, repeated project label and routine saved notices.
- Retain the same ChatEditor, textarea, native selection, draft key/revision,
  project identity, delivery operation, autosave and guarded submit path.
- Reveal directory and exact project ID in the searchable project chooser rather
  than a permanent technical paragraph. Search still accepts names, paths and IDs.
  Missing/changed projects, loading, catalog failures and delivery recovery stay
  visible. Error/Unknown and recovery actions remain above the tray.

The editor stays white on gray (card/tray in dark mode), with its existing
76pt empty tray and 34pt input. Project and mode controls live outside it.
Model/thinking controls retain their existing scope and native Select behavior.
A new chat has no reported context; the existing-chat gauge remains unchanged.

Tab reaches the project chooser, Add project, Ask/Build and composer controls.
Native Select search/arrow/Return/Escape work as before. Return on a mode button
selects a mode, not Send. Metadata captures marked input before sibling blur;
mode/project callbacks retain their preedit and pending/immutable-draft fences.
Browsing never supplies project authority, and no new action runs on opening.

## Synthetic verification

`new_chat_view` paints the real LocalViewer at680/1100 in light/dark, captures
before/after, and checks centering, alignment,76/34 geometry, project picker,
model/thinking, mode, Unicode/preedit, focus, retained new/existing navigation,
explicit send and pending/Unknown/error controls. Its model reads are against an
owned faux loopback service; all writes go to a recorder, not Local data.
`project_creation` separately exercises actual admission/private-store contracts
with an owned faux daemon, including empty/unavailable catalogs and lost ACK.
`composer_controls` protects existing-chat Send, queue, Stop and geometry.

These checks are not OS IME, visible smoothness, performance, Linux, installed-app
or user acceptance proof. No animation policy, backend or storage contract changes.
