# Linux Wayland run, 2026-10-23

Pilot Next is an experimental Rust desktop app kept beside the production
Swift app. This note records the first verified Linux build and launch, and
the exact link problem that previously stopped it. It is not a support,
parity or packaging claim.

## Host

```text
Host: Bazzite 44.20261012.0 (Kinoite), x86_64, Wayland session (KDE Plasma)
Kernel: Linux 6.x, XDG_SESSION_TYPE=wayland, WAYLAND_DISPLAY=wayland-0
rustc 1.98.1 (pinned by apps/desktop/rust-toolchain.toml, local .tools/rustup)
cargo 1.98.1
mbx 1.26.0 (SHA-verified Linux GNU archive)
node v26.7.0 (existing Local daemon, already listening on 127.0.0.1:4319)
```

The host has the 64-bit runtime objects for X11 and xkbcommon but not their
development symlinks:

```text
/usr/lib64/libxcb.so.1              present
/usr/lib64/libxcb.so                missing
/usr/lib64/libxkbcommon.so.0        present
/usr/lib64/libxkbcommon.so          missing
/usr/lib64/libxkbcommon-x11.so.0    present
/usr/lib64/libxkbcommon-x11.so      missing
```

Installing the distribution development packages needs root, which was not
available in this environment. The fallback described below was exercised
instead. The development-package path was therefore **not** verified here.

## The failure

The final link of `pilot-desktop` failed with:

```text
rust-lld: error: unable to find library -lxcb
rust-lld: error: unable to find library -lxkbcommon
rust-lld: error: unable to find library -lxkbcommon-x11
```

The library compile itself succeeded; only the binary link failed, so the
symptom was "the desktop app cannot be built on Linux" even though every
library was present at runtime.

## The fix

`apps/desktop/build.rs` runs only for Linux targets. For each library that
GPUI links by its unversioned development name (`xcb`, `xkbcommon`,
`xkbcommon-x11`) it:

1. looks for the unversioned object in the library search path and does
   nothing when it exists;
2. otherwise looks for a versioned runtime object (`libxcb.so.1`) that matches
   the target architecture, reading the ELF header so a 32-bit object in
   `/usr/lib` is never selected on a 64-bit host;
3. creates a symlink to that object inside Cargo's own `OUT_DIR/native-libs`
   and adds the directory to the link search path.

The symlinked objects keep their original `SONAME`, so the runtime still
loads the real system libraries:

```text
$ ldd target/dev/debug/pilot-desktop | grep -E 'xcb|xkbcommon'
libxcb.so.1 => /usr/lib64/libxcb.so.1
libxkbcommon.so.0 => /usr/lib64/libxkbcommon.so.0
libxkbcommon-x11.so.0 => /usr/lib64/libxkbcommon-x11.so.0
```

The build script never writes outside Cargo's build directory, never installs
anything and never changes a system path. It prints the missing library names
and the distribution package hints when it has to fall back. Font and
font-config libraries are deliberately not shimmed: they come from
`pkg-config` through their own build scripts, which fail with a clearer
message when the development files are absent.

## Verified entrypoints

From `apps/desktop`:

```sh
bash scripts/cargo.sh build --locked            # links the pilot-desktop binary
bash scripts/cargo.sh clippy --all-targets --locked -- -D warnings
bash scripts/check.sh                                # the full desktop gate
bash scripts/cargo.sh test --lib --locked -- --test-threads=1
bash scripts/cargo.sh test --test rendering --locked
./target/dev/debug/pilot-desktop                 # synthetic fixture, visible window
./target/dev/debug/pilot-desktop --local-check   # read-only Local check
./target/dev/debug/pilot-desktop --local         # Local viewer, visible window
```

Results:

- Build: the `pilot-desktop` binary links and runs on Linux.
- Clippy: `--all-targets` with `-D warnings` is clean, including the new
  build script.
- Library tests: 157 passed, 0 failed, 2 ignored.
- `scripts/check.sh`: exit 0, including rustfmt, strict Clippy and every native
  probe (disclosure, style, icons, motion, controls, history, shell, navigation,
  inbox, jump, workbench, catalog).
- Native offscreen rendering test: passed. It renders 1920x1520 offscreen and
  states that it does not validate visible interaction, IME, accessibility or
  smoothness.
- Fixture launch: the process opens a real Wayland toplevel
  (`xdg_wm_base.get_xdg_surface` followed by `get_toplevel`) and renders
  through the Mesa EGL path.
- Local launch: the same window opens in `--local` mode against the running
  daemon.
- `--local-check`: `Local identity verified; 0 summaries; no active chat
  opened.`

## Limits

- The daemon was already running on this host; this note does not verify
  daemon startup, supervision or session execution on Linux.
- X11 and XWayland are not supported at runtime. Only the Wayland backend is
  selected, and only after a real compositor socket connection succeeds.
- The mbx build cache cannot store a native link search path, so the build
  script re-runs on every build. That costs a few seconds of recompiling the
  app crate and is not a correctness problem.
- The Wayland session, compositor and GPU stack of other distributions are
  unverified. Only this host is a source of evidence.
- Keyboard layouts, IME input, accessibility and visible frame pacing were
  not exercised.
- The distribution development packages remain the supported path; the
  fallback exists for hosts without root.
