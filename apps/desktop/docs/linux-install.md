# Install Pilot Next on Linux

Pilot Next for Linux is a self-contained folder (GUI, bundled daemon runtime and
update helper) published on each stable GitHub release as
`Pilot-Next-linux-x64.zip`. There is no distro package, installer or sudo step.

## Requirements

- x86_64 (no ARM build is published).
- A **Wayland** desktop session (GNOME, KDE Plasma, sway, …). X11 sessions are
  not supported.
- glibc 2.39 or newer (for example Fedora 40+, Ubuntu 24.04+, Debian 13+).
- A working Vulkan driver (Mesa is enough), `libxkbcommon` and `libxcb`; normal
  desktops already have them.
- Optional, for mission coordinators only: a root-owned `bubblewrap` from the
  distro package manager (see the main README).

Immutable Fedora desktops such as Bazzite (KDE Plasma, Wayland) already meet
these requirements: the shipped binaries resolve every library from the base
image, and `curl` and `unzip` are included. Install directly on the host as
below. No `rpm-ostree` layering, distrobox or toolbox is needed. Home there is
`/var/home/USER`; `~` and `$HOME` already point to it. No Flatpak or AppImage
is published.

The old `Pilot-linux-x64.tar.gz` asset (v1.70.0 and earlier) is a headless
daemon, not the desktop app. It cannot run the GUI or update to it; download the
zip instead.

## First install

Install into a folder you own, such as `~/.local/opt`. Do not install under
`/opt` or `/usr`: updates replace the folder in place without sudo.

```sh
mkdir -p ~/.local/opt && cd ~/.local/opt
curl -LO https://github.com/babariviere/pilot/releases/latest/download/Pilot-Next-linux-x64.zip
unzip -q Pilot-Next-linux-x64.zip        # creates ~/.local/opt/Pilot Next
rm Pilot-Next-linux-x64.zip
"$HOME/.local/opt/Pilot Next/bin/pilot-next"
```

Use `unzip` (or another extractor that keeps executable permissions). Do not
add, edit or remove files inside the folder: the app verifies its signed file
list before updating. Start it through `bin/pilot-next` by its full path; a
symlink to that script does not work, so use a wrapper script or the menu
entry below.

Chats, drafts and settings live outside the app folder (`~/.local/state/pilot-next`,
`~/.local/share/pilot-next` and the Pilot profile), so replacing or moving the
folder does not touch them.

### Menu entry

From the release after v1.77.0, the first launch adds **Pilot Next** with its icon
to your applications menu (`~/.local/share/applications/com.babariviere.pilot-next.desktop`
and a matching icon under `~/.local/share/icons`). Each launch points it at the
folder the app runs from, so moving or renaming the folder is picked up. To keep
your own version, edit that file and remove the `X-Pilot-Next-Managed=true`
line; the app then leaves it alone.

For v1.77.0 and earlier, add the entry yourself:

```sh
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/pilot-next.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Pilot Next
Exec="$HOME/.local/opt/Pilot Next/bin/pilot-next"
Terminal=false
Categories=Development;
EOF
```

Updates replace the folder under the same path, so the entry keeps working.

## Updates

Open **Settings → Updates** and choose **Check for updates**, or turn on
automatic checks. Checks read the public release; a GitHub token is only needed
if GitHub rate-limits the request. Downloading never installs: choose
**Install and restart…** when ready. The running daemon and its work are left
untouched.

v1.77.0 and earlier need two workarounds: keep the folder named exactly
`Pilot Next` (a renamed folder disables the Updates panel), and paste a GitHub
token in the Updates panel for each check. Later releases accept any folder name
and check anonymously.

### Changing versions and the background daemon

The Pilot daemon keeps running after you close the window. When a newer app
finds a daemon from an earlier version, it connects to it first (each Linux
release accepts the runtimes of the few releases before it), then updates it:
it waits for running tools to pause, stops that daemon and starts its own.
Chats continue on the new daemon; the window reconnects by itself. While tools
keep running, it retries every few minutes. v1.78.0 and earlier leave the daemon
on its old version until it stops, for example after a reboot.

v1.77.0 and earlier accept no earlier runtime. If one of them refuses to start
because another version's daemon is running ("The running daemon has no exact
supported retained runtime…"), install a newer release instead.

Technical details: [Linux updates](linux-updates.md) and
[Linux GUI package](linux-gui-package.md).
