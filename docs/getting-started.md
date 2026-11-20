# Installation and setup

## Private install

Pilot Day is the only desktop app in this repository. It runs on Apple Silicon
macOS. The private install is `~/Applications/Pilot.app`. Follow the
[private build and install procedure](../.agents/skills/update-pilot/SKILL.md)
from an authorized checkout. There is no new public Day release. Linux desktop
is deferred. Old Pilot Next downloads are not Day installers.

Removing Pilot Next source does not remove an installed app, stop a service, or
change profiles, history, workspaces, or drafts. Day can use the existing
profile, but does not import Pilot Next's private window drafts. Keep those
files.

## Connect your tools

1. Set up a provider in [pi](https://github.com/earendil-works/pi).
   Pilot uses its existing agent configuration, normally `~/.pi/agent`.
2. For GitHub pull requests, install the [GitHub CLI](https://cli.github.com/) and
   authenticate with `gh auth login`. Git fetches also need working host credentials.
3. For shared jj workspaces, use [the workspace requirements](workspaces.md#add-a-local-project-in-day).

## Start working

1. Open Pilot. Today shows work across projects you can access.
2. In **Settings → Local projects**, [add your repository](workspaces.md#add-a-local-project-in-day)
   if it is not listed.
3. Open **New**, choose a project and describe the task. Plan a mission or start
   one chat. Planning does not start its tasks. Review the plan before choosing
   **Start work**.
4. Return to Today to check progress and results. You decide what to merge.

Next: [Using Pilot](README.md) · [Workspaces](workspaces.md) · [Troubleshooting](troubleshooting.md).
