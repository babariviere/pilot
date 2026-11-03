# Installation and setup

## Install

Download the matching archive from [Releases](https://github.com/babariviere/pilot/releases):

- **macOS:** `Pilot-Next-macos-arm64.zip`, Apple Silicon, macOS 15 or later.
  Extract it and move `Pilot Next.app` to `/Applications`.
- **Linux:** `Pilot-Next-linux-x64.zip`, x86-64 with Wayland. Follow the
  [Linux installer instructions](../apps/desktop/docs/linux-install.md).
  Linux support has separate platform limitations; macOS behavior is not guaranteed.

The packaged app includes its Node runtime and daemon. A source checkout is not required.
The old Swift app is no longer built or published by CI.

## Connect your tools

1. Set up a provider in [pi](https://github.com/earendil-works/pi).
   Pilot uses its existing agent configuration, normally `~/.pi/agent`.
2. For GitHub pull requests, install [GitHub CLI](https://cli.github.com/) and run
   `gh auth login`. Git fetches also need working host credentials.
3. For shared jj workspaces, install Jujutsu 0.46+ and Git 2.42+.
   Git-only projects use private clones.
4. If prompted, explicitly register or start the bundled Local service.
   Connecting to an existing daemon does not install or replace it.

## Start working

1. Open the project selector and choose **Add project…**.
2. Select an existing local repository and confirm. Then select that project for your chat.
3. Choose **Ask** to explore without repository writes, or **Build** to implement.
4. Select a model, describe your task, and send.
5. Review the reply, artifacts, and changes. You decide what to merge.

The daemon manages agents independently of the window. Sleep, connectivity, and
[usage limits](usage.md) can still pause work.

Next: [Chats](chats.md) · [Workspaces](workspaces.md) · [Troubleshooting](troubleshooting.md).
