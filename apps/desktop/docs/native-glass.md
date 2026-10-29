# Native window glass

`enable_glass` requests glass; it does not make tokens translucent by itself.
Every real window calls `follow_appearance`, which asks its native backend for
`supports_background_blur`, then applies **Blurred or Opaque**, never Transparent.
The same hook handles native appearance/capability notifications. Existing page,
sidebar and list tints are unchanged; cards, composer, popovers, buttons and code
remain opaque. Offscreen/headless backends report no capability and stay opaque.

The application root plugin clears Kit's default page fill only while glass is
active. Page and sidebar content own their individual tints; embedded transcript
readers already inherit the main pane's tint. Stacking those fills would turn the approved
translucent colors nearly opaque and hide a working native material.

## macOS

Keep GPUI's `NSVisualEffectView` (`UnderWindowBackground`, `BehindWindow`, Active)
behind the existing Metal/input view. Its width/height autoresizing follows the
content view, including titlebar and resize changes. Native input, window drag,
traffic lights and modal focus stay with GPUI/AppKit.

Do not replace the material with Transparent after a successful
`CGSSetWindowBackgroundBlurRadius` call. That private API's return code did not
prove a rendered backdrop effect, and the replacement removed the real material.
There is no private window-server blur call now.

The read-only public NSWorkspace Reduce Transparency preference disables glass.
A window-owned workspace notification refreshes capability/tokens on the main
executor, even with a manual light/dark preference. Observer teardown belongs to
the native window. No system preference is written.

## Wayland

Desktop names and `HYPRLAND_INSTANCE_SIGNATURE` are not capabilities. Reuse the
existing `wayland-protocols`/Plasma dependencies and the actual connection:

- Prefer `ext_background_effect_manager_v1` and its **live Blur capability**.
  Request a non-null, surface-local region before the next surface commit.
  Null removes the effect; the initial region is empty.
- Older KWin uses its advertised `org_kde_kwin_blur_manager`, with an explicit
  region and blur commit. Refresh regions on resize and release objects on opaque
  fallback or window destruction.
- Global removal/rebinding and ext capability changes refresh the window's native
  request and application tokens. Disabled ext capability never falls through to
  the legacy protocol. With no advertised capability, use opaque surfaces.

This supports protocol-capable KWin/Hyprland, not every version or configuration.
Older Hyprland without an explicit protocol stays opaque instead of assuming that
its automatic blur is enabled. Compositor policy still controls the rendered
algorithm and may override requests. Legacy KDE blur has no capability event;
its advertised global is the available signal. No compositor configuration is
read or changed, no compositor is installed, and no X11 path is added.

## Checks and qualification boundary

- `cargo.sh test --lib appearance::tests`: request/capability fallback, manual
  theme preservation, opaque reading surfaces and contrast.
- `cargo.sh test --features native-probes --test glass`: offscreen production
  root with opaque fallback, resize/layout and readable surfaces.
- `cargo.sh test --features native-probes --test native_glass` (macOS): hidden
  real AppKit windows. Inspect native material/blending/state/autoresizing,
  opaque fallback, native input view, theme and window recreation. Never shows
  or activates a window. **This is native request proof, not visual blur proof.**
- `cargo.sh test -p gpui-pre-linux --lib background_blur_tests` (Linux): socket-pair
  fixture captures actual production KDE/ext request bytes, regions, resize,
  capability loss, fallback and destruction. No display or live compositor.

Visible qualification needs separate approval: a synthetic app window over a
known high-frequency patterned background, compare native blur versus opaque and
plain-transparent controls, inspect the material/protocol request and compositor
pixels together. Repeat light/dark, activation, resize, window recreation and
reduced transparency/disabled compositor blur. Hidden/offscreen captures cannot
prove behind-window sampling. Linux rendering must be checked on the actual
supported compositor, never inferred from AppKit or a mock server. Do not open a
visible probe, connect a historical remote host, or restart/install the real app
without approval.

For an approved macOS comparison, run
`cargo.sh test --features native-probes --test native_glass -- --visible`.
It opens known colored 6pt stripes behind separate native-material, plain
transparent and opaque controls. Each has an untinted upper area and the approved
page tint below. It reports capability, window IDs and native request inspection;
it never runs in CI or connects to Local. Close its windows or use Cmd-Q to quit.
