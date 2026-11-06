# Pilot sidebar and chat in Native Shell

A standalone **Rust-only, native AppKit prototype** of Pilot's sidebar and chat.
It uses synthetic data, not a live daemon or account. It does not change the
production app, install anything, or replace the existing NSH baseline study.

## Run

```sh
bash experiments/nsh-pilot/run.sh
# Optional: --dark or --width 680
```

The prototype uses **unmodified NSH 0.4.0**, pinned to upstream commit
`3e302abf0cbba712896fc938ca48360fc08c14bb` (the latest upstream HEAD observed
during implementation). There are no Cargo patches, generated patched sources,
forks, or edits to Cargo's source cache. Its lockfile keeps runs reproducible.
Update all four NSH dependencies and the test dependency together when updating
the upstream pin. No globally installed `nsh` CLI is needed.

## Try

- Select a chat and write a Unicode or multiline draft. Switch away and back.
- Choose a project or find a chat by title. Filtering does not change the open chat.
- Create a new chat using the compose button beside Home.
- Send with Return or the arrow button. A local scripted reply streams into
  native Markdown. Stop ends only that chat's reply, keeping its partial text.
- Switch chats while a reply grows. The replay belongs to the app's chat,
  not a recycled transcript cell or the currently mounted conversation.
- Select text in the transcript. NSH's native selection rules apply.

Home, Inbox, Review, Missions, Automations and Settings show the familiar sidebar
structure but are disabled and named as outside this prototype for accessibility.
This is a chat/sidebar reproduction, not an implementation of those pages.
Drafts and chats are process-local and disappear on exit. New chats are limited
to 32 per process. Nothing sends a model request or claims to save durably.

## Presentation

Colors, Inter and JetBrains Mono fonts, neutral selection, state words and the
white/card composer over a gray tray follow
[`apps/desktop/docs/design-system.md`](../../apps/desktop/docs/design-system.md).
NSH's unstyled Button owns press, disabled and selected behavior. NSH owns native
input, Markdown, scrolling and list recycling. The app owns chat identity, drafts,
navigation, replay tasks and Stop. Lucide assets use the existing
[`LUCIDE.txt`](../../apps/desktop/licenses/LUCIDE.txt) license.

## Verify

```sh
cd experiments/nsh-pilot
cargo fmt --check
cargo test --locked -j 4 -- --test-threads=1
cargo clippy --locked --all-targets -j 4 -- -D warnings
cargo build --locked -j 4

# Hidden real AppKit views, native insertion and synthetic sidebar clicks.
# These do not activate a window or run a benchmark.
target/debug/pilot-nsh-workbench --capture output/light-1180.png
target/debug/pilot-nsh-workbench --dark --capture output/dark-1180.png
target/debug/pilot-nsh-workbench --width 680 --capture output/light-680.png
target/debug/pilot-nsh-workbench --dark --width 680 --capture output/dark-680.png
```

The capture checks exact native editor text after insertion and after clicking
away and back, then clicks Send and Stop and checks their native UI outcomes.
It also writes a `*-reply.png` capture of the stopped partial reply.
It exits nonzero if a check fails. Captures show actual native
views with mock data, not the production views. Headless tests exercise the same
Rust UI, but do not qualify hardware IME, active-app menus, accessibility with a
screen reader, visible animation, large-history performance, or durability.

NSH currently documents selection over **mounted** virtual-list rows only;
recycled rows leave the selection. No workaround or upstream patch is added.
This prototype does not establish whole-history Select All or selection across
recycling. See [NSH's selection contract](https://nsh.dev/elements/text-selection).
