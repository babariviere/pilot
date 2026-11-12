# Local Pilot Preview

Pilot Preview is a separate native macOS development app. It uses the actual
`apps/day` screens and **demo data**, not your missions or accounts. It does not
connect to, register, update or start a daemon. Keep using your current Pilot app
for real work.

## Launch

After a developer installs a checked build, double-click:

```text
~/Applications/Pilot Preview.command
```

Or run:

```sh
open "$HOME/Applications/Pilot Preview.command"
```

The launcher opens a native window, not a browser. A Terminal window also opens
for the small launcher. The banner says **Demo data, not your missions** and
shows the exact source commit. Today, mission detail, New, the saved interview,
Changes and rituals use the existing mock feeds. Buttons change the demo only.
No real agent starts, provider request, Linear write, registration or update
takes place. Chat windows and live mission work are not connected in this preview.
New's project list shows two invented demo projects; starting a chat there only
counts a demo chat.
Today's To check shows three demo results. Mark done, Send back and Reopen
change only the demo; nothing reaches an agent.
New's "Your Linear issues" opens a read-only page of demo Linear issues and a
demo cycle. It reads nothing from Linear.

New's goal, Today text drafts and interview text/picks are kept separately in:

```text
~/Library/Application Support/dev.pilot.preview/storage.json
```

Demo actions, submissions and navigation reset when you reopen. Restored
interview drafts still need an explicit save or submission. Draft storage uses
NSH's background writes; this is not production crash-durability qualification.
If stored drafts cannot be read, the preview leaves their saved copy unchanged
and warns that new text will not be saved. Do not put secrets in demo fields.

## Refresh during development

The developer builds a **committed, immutable source version**, runs checks and
stages the official NSH macOS package. Installation never changes `Pilot.app`,
its identities, profiles, data or working chats. The preview uses its own
`dev.pilot.preview` identity and an NSH-generated ad hoc development signature.
It is not Developer ID signed, notarized, a production update or cutover.
Do not disable Gatekeeper or production bootstrap checks to launch it; report
any macOS refusal instead.

Each checked version lives under:

```text
~/Library/Application Support/Pilot Preview/versions/<source>/Pilot Preview.app
```

The developer refreshes with:

```sh
python3 apps/day/scripts/preview.py build --source FULL_COMMIT
```

This requires the installed, verified NSH 0.4.0, the existing Day mbx/Cargo
environment and private exact-source Node dependencies. It never installs
dependencies, builds the NSH CLI, changes runtime sources or generates keys.
The build runs the portable installer checks, NSH type/bundle checks and
Preview, Plan and App headless suites before packaging and signature validation.

A successful build selects itself automatically **only while the preview is
closed**. If the preview is running, it stays on its old version with its open
drafts. Quit it normally when ready; the next launcher invocation selects the
checked pending version. No automatic quit, hot reload or relaunch occurs.
Failed checks, packaging, signature validation or process inspection leave the
previous working version selected. Old versions and saved drafts are not deleted.

There is no background source watcher or new updater service. Developers must
run the build command after source changes; merely pushing code does not rebuild
this local app. Applying an already staged build on the next launch is automatic.

## Evidence

Builds and headless tests are not real-window acceptance. The developer must
request permission before opening a visible window for tests or screenshots.
The user launching the preview is not permission for autonomous interaction or
benchmarks. Screenshots, when permitted, must name the preview's source and demo
data, not claim live behavior or production acceptance.
