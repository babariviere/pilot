# Native macOS menus

Pilot Next installs the platform menu bar using GPUI `App::set_menus`, after
Kit and application bindings are registered. There is no drawn menu-bar substitute.

- **Pilot Next:** About, Settings (⌘,), Services, Hide (⌘H), Hide Others
  (⌥⌘H), Show All and Quit (⌘Q).
- **File:** New Chat (⌘N), opening the existing local draft flow, not sending it.
- **Edit:** Undo, Redo, Cut, Copy, Paste and Select All with standard shortcuts.
- **Go:** Back/Forward (⌘[/⌘]), Home, Chats, Missions and Jump (⌘K).
  ⌘← and ⌘→ also go Back/Forward when no text field has focus. In the composer,
  search, dialogs and Settings they keep moving to the start/end of the line, and
  marked IME text keeps them. The menu shows only ⌘[/⌘]. Linux has no ⌘ aliases.
- **Window:** Minimize (⌘M) and Zoom, plus system-managed window entries.
- **Help:** Keyboard Shortcuts… opens a passive native reference; Ask about Pilot…
  retains the existing diagnostic-chat path.

The shortcuts window reads combinations from the installed keymap, using Kit's
current-platform labels (the same platform resolution as `ui::shortcut`). It
curates common commands, not an exhaustive command catalogue or customization
surface. Main-window commands, sidebar-list keys, Settings, forms and focused
text editing are separate groups. History-arrow aliases explicitly exclude text
fields; availability notes do not promise that a disabled command will execute.
The window has literal selectable text and Copy reference. Escape, the Close
button or platform close-window shortcut closes it and restores the originating
main-window focus. Opening follows existing navigation/composition guards.
No production open hotkey, dispatch precedence or editing binding was added.

Application commands reuse the existing guarded handlers. Commands without an
applicable focused handler are disabled by GPUI's native validation. Navigation
is unavailable during protected composition/dialogs or pending restart; history
commands require a restorable destination. A synthetic fixture cannot create a
Local chat or open Local Settings. Deferred operations are not listed.

Edit items use Kit's own actions and GPUI `OsAction`, without new global editing
bindings or clipboard handlers. The focused input, transcript or artifact reader
keeps editing/selection ownership. Kit still owns undo history, read-only rules
and composition. Send and Stop are deliberately absent, so this menu adds no
second submit path.

Quit reuses the settings-close and private draft-close flow. Quit from a separate
Settings/Usage window is routed back to the main Local owner, rather than the
fixture fallback. Dirty settings, marked composer text and restart work can refuse
Quit. The application waits for the existing draft worker's flushed event before
exiting. It never stops or replaces the daemon.

## Focused verification

From `apps/desktop`, after `scripts/bootstrap.sh`:

```sh
python3 scripts/check-scoped.py --unit app_menu --test native_menus --lint
python3 scripts/check-scoped.py --unit local_view::menu_routing::tests
python3 scripts/check-scoped.py --unit local_view::shortcuts_view::tests --test shortcuts --lint
```

The native target creates no window and activates no app. It inspects the actual
AppKit NSMenu hierarchy and key equivalents, then invokes a native menu delegate
against a synthetic receiver to verify single dispatch. Synthetic view tests use
recording writers, never real profiles or daemon actions. These checks do not
qualify genuine OS IME input, visible menu appearance or platform-wide lifecycle
acceptance. Linux still builds without the macOS menu module; no Linux native-menu
behavior is claimed.

The shortcuts target uses an isolated hidden GPUI owner without a client/writer.
At 680/1100pt in light/dark it uses a fixture-only F1 binding to exercise the
same Help action through keyboard dispatch, then checks scrolling, close/reopen, exact focus
restoration, simulated marked-text refusal and literal selection/Unicode copy.
This does not qualify physical keyboard navigation of AppKit's Help menu or OS
IME/clipboard interoperability. No live app is launched or focused.
