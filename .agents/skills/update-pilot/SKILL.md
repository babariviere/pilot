---
name: update-pilot
description: Build Pilot Day from this checkout and install it as the user's own ~/Applications/Pilot.app. Use when asked to build, install, update or restart the user's Pilot, or to ship working-copy changes to it.
---

# Update Pilot

Builds a production Pilot Day bundle from one commit, swaps it into `~/Applications/Pilot.app`, restarts the
`com.babariviere.pilot.daemon` launch agent and reopens the GUI. Scripts are in `scripts/` beside this file.
Asking for an update authorizes the quit, daemon restart and swap. Nothing is committed with jj.

## 1. Choose the source commit

- Default: the whole jj working copy. `build.sh` with no source uses `jj log -r @`, which snapshots it.
- When another agent still has unfinished edits, build a commit of chosen files only, outside the working copy:

```bash
export GIT_INDEX_FILE=/tmp/pilot-build-index
git read-tree <base-commit>          # e.g. the previous build's source
git update-index --add --cacheinfo "100644,$(git hash-object -w <file>),<file>"   # each chosen file
git commit-tree "$(git write-tree)" -p <base-commit> -m "build: <what>"           # prints the source commit
```

Done when you have a 40-character commit id that contains every change the user expects to see.

## 2. Check

Run the checks that cover the changed code (repo `AGENTS.md`, `apps/day/README.md`). Done when they pass.

## 3. Build

Run as a job, never inline: a build takes 10 to 20 minutes.

```bash
bash .agents/skills/update-pilot/scripts/build.sh [<source-commit>] [<build>]
```

The build number defaults to today's next `YYYYMMDD.N` after the installed one. Output goes to
`${PILOT_BUILD_ROOT:-/tmp/day-build}/<build>/app/Pilot.app`. The pinned QuickJS-NG archive is cached in
`~/.cache/pilot-build` and downloaded once, checked against `apps/desktop/scripts/prepare-visual-worker.py`.
Done when the log ends with `BUILT <build>`.

## 4. Install

```bash
bash .agents/skills/update-pilot/scripts/install.sh <build>
```

It refuses while any chat is working, because the restart would interrupt it. Then wait for the chats to go
idle and retry; ask the user before you stop a chat. Quitting the GUI may print `User canceled (-128)`;
the script still checks that the GUI quit. Done when it prints `INSTALLED <build>` and the GUI is open again.

The previous app is kept in `~/Applications/Pilot-install-<build>/retained/Pilot.app` for a manual rollback.

## 5. Wake idle planners

A Pilot Day planning mission whose planner was idle before the update may need an explicit continue:

```bash
node .agents/skills/update-pilot/scripts/wake-planner.mjs <mission-id>
```

It sends `plan-continue` only when the daemon offers it (`continuePlanning.available`), and exits 1 otherwise.

## Report

The build number, its source commit and what it contains, the install result, and which planners you woke.
Check the GUI by its window state or the daemon API, not by synthetic clicks: clicks can land in the user's app.
