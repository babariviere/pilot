# Linux bundled Local lifecycle

The Linux GUI layout remains `bin/pilot-next`, `libexec/` and `runtime/`.
Bundled startup validates the entire `linux-gui-package.json` inventory, the
runtime build tuple and Rust source receipt before executing bundled Node. It
does not look up Node on PATH or fall back to synthetic content on failure.
These integrity hashes are not publisher authentication. Production updates
separately require the updater's compiled Ed25519 trust and signed inventory.

## Retained-runtime interface

Before activation, the app copies the complete validated payload into:

```
$XDG_DATA_HOME/pilot-next/runtimes/<inventory-sha256>/payload
```

The default data root is `$HOME/.local/share`. The identity is SHA256 of the
**exact bytes** of `linux-gui-package.json`, not source SHA or a hash of parsed
JSON. The store and capsule parent are private, same-user directories. The
permanent `.store.lock` inode serializes publishers. Publication validates the
copy, persists it and renames its private stage into place. Existing corrupt,
redirected or unknown roots refuse, never repair or overwrite. There is no GC.
Linux uses one `syncfs` barrier before publication, then syncs the publication
directory after rename. The first barrier flushes the containing filesystem,
avoiding serialized per-file journal barriers without weakening persistence.
The launcher's module cwd and daemon owner `runtimeRoot` are `payload/runtime`.
GUI replacement therefore cannot remove the daemon's Node/import/resource tree.

The updater owns candidate signature verification, exact accepted-capsule policy,
idle reservation, post-parent-exit revalidation and startup receipt validation.
It derives the payload from the proven `runtimeRoot` parent, checks this store
shape and inventory digest, and never adopts a legacy replaceable app root.
An unsigned development install does not acquire update authority by retention.
The base startup exports receipt storage for the updater integration, but refuses
a Linux update receipt before any profile access until the verified handoff hooks
are composed. It never silently treats a relaunch receipt as ordinary startup.

## Daemon ownership and lifetime

The existing source-owned Node launcher and daemon lease/proof contract remain
unchanged. Fresh profiles acquire the exclusive SQLite lease and TCP listener
before graph import/migration. A compatible live owner is reused only after its
exact build/profile/boot challenge succeeds. Legacy/unknown profiles, incompatible
source and occupied listeners refuse without enrolling, migrating or signaling
an existing process. No second daemon is launched on that profile.
The packaged launcher additionally pins its actual canonical module root in both
the private owner record and HMAC-bound live proof. A same-build daemon running from
a replaceable GUI path is not a retained-runtime match. This optional predicate
does not change existing external callers or prevent an idle managed profile
from acquiring a new owner after process death.

The GUI owns a launcher lifetime pipe. Cancellation before activation reaps only
that launcher's actual child. Once activation may have arrived, timeout/lost ACK
is unconfirmed and preserves the daemon. GUI exit after activation leaves work
running. A later launch checks the same owner instead of replacing it. Daemon
proof PIDs never authorize a signal.

## Native fixture qualification

`scripts/linux_local_native.py` requires an explicit disposable package copy and
same-user Wayland socket. It uses a private HOME/config/data/cache/profile, actual
bundled startup, source-owned live proof, retained path and rendered Wayland
buffer checks. It renames only that supplied disposable package, checks exact
owner reuse and history marker preservation, and cleans up only its actual GUI
handle and Linux subreaper-adopted descendants through pidfds. It never discovers
or signals a daemon from a profile PID. Run it only on authorized fixture hosts.

The focused daemon owner/launcher suites additionally cover lease contention,
identity mismatch, unknown profiles, preactivation EOF cleanup and postactivation
lost-ACK preservation using synthetic owned children. They are not evidence of
GPU/distro coverage or native visual confinement. Native visual confinement
remains a separate required qualification; it is not disabled by bundled Local.
