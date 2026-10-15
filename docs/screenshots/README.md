# README screenshots

Only the three images embedded in the main README are kept here. Historical feature captures are
generated on demand, not committed alongside current screenshots.

## Update all three

From the repository root on macOS, with an up-to-date installed Pilot app and ImageMagick (`magick`):

```sh
python3 apps/macos/scripts/update-screenshots.py
```

The script launches the installed app with synthetic fixtures and a temporary home, without a live
daemon, personal conversations or a local build. Use `--app /path/to/Pilot.app` (or `PILOT_APP`) to
select another bundle. Rendering requires a Retina display for the high-resolution mission capture.
Launches use `open` because running the bundled executable directly can omit the native toolbar window.

To reuse captures already rendered with `Pilot --snapshot`:

```sh
python3 apps/macos/scripts/update-screenshots.py --captures /tmp/pilot-demo-captures
```

- `readme-build.png`: Build chat, grouped tool activity, compact task progress and Changes.
- `readme-ask.png`: read-only Ask chat and implementation plan, including the sidebar.
- `readme-mission.png`: mission Tasks, cropped from the native Retina window (2100×1200 at 2×).

The chat captures use a stand-in window header. Build omits the sidebar; mission Tasks omits the
sidebar and toolbar to avoid black native compositing artifacts. The script crops, never upscales,
and validates all outputs before replacing files.

Inspect all three images before publishing. These are native view-layout snapshots, not end-to-end
agent or scrolling tests. Never commit live window captures with private projects or credentials.

## Other fixture captures

Keep one-off review captures in a temporary directory or CI artifacts. The native snapshot renderer
supports focused sets such as `--missions-only`, `--delegated-tasks-only`, `--long-messages-only`,
`--branches-only` and `--pr-icons-only`. See [native development notes](../../apps/macos/README.md).

The app-bundle CI job uploads delegation fixtures as `delegated-task-screenshots`, without requiring
a local Swift build.
