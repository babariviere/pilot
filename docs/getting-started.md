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

## Install and update the read-only CLI

From a trusted Pilot checkout, run this with Node 24 or later:

```sh
node scripts/install-pilot-cli.ts
```

This installs `~/.local/bin/pilot` and `~/.agents/skills/pilot-cli/SKILL.md`.
Update your checkout and run the same command to update both together.
The launcher uses Pilot Day's bundled Node if present, otherwise the Node
that ran the installer. Pass a runtime directory to install its bundled CLI,
skill, and Node instead of the checkout's files.
The installer does not update or restart Pilot Day. Reading data requires a
Pilot runtime that supports the CLI and an eligible Pilot agent session.

Add `$HOME/.local/bin` to your shell's `PATH` if needed, then run `pilot --help`.
Use `command -v pilot` to check which command your shell finds. You can also
run `"$HOME/.local/bin/pilot" --help` directly.

Only eligible Pilot agents can read data. In Build, Pilot provides the bundled
`pilot` command on `PATH`. In Ask, the `pilot_cli` tool takes the same arguments
without running a shell. The bundled `pilot-cli` skill shows how to use both.
An agent can read its own chat and attached mission, including the Brief and
tasks. The CLI cannot send messages, edit work, or start agents.

If either destination belongs to another install, the installer refuses to
replace it. To switch from a legacy launcher, inspect it with
`ls -ld "$HOME/.local/bin/pilot"`, then move it to an unused name such as
`pilot.legacy` in the same directory. Move the symlink itself, not its target.
Rerun the installer.

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
