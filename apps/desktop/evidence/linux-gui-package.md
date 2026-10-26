# Linux GUI package qualification, 2026-10-26

## Exact source and native host

- Payload source: `0fa7fd0940414f24401198757fa97cca901117b1`.
- Source tree: `5aa8fcd274b11fed7c1d7b7aef71e77d0907e1f4`.
- Native x86_64 Linux, Fedora44-derived kernel `7.2.9-ogc3.1.fc44.x86_64`.
- Pinned rustc/cargo1.98.1; private target, mbx CPU2/4GiB wrapper.
- Source cloned separately and supplied through an immutable Git bundle. The
  user's checkout, installed GUI, live daemon and profiles were not changed.
- No system packages installed. Existing native runtime libraries and compiler
  tools only. Private fixture HOME/config/data/cache/runtime directories.

## Actual native observations

`cargo.sh build --locked --workspace --bins` completed successfully in4m05s.
This is a recorded duration, not a cache/build-speed claim. Cache bypass
warnings were retained, including the private versioned-system-library symlinks.
The tracked source remained clean after the build.

| Executable | Bytes | SHA256 |
| --- | ---: | --- |
| pilot-desktop | 207389768 | b4040776969863aa21e0b9446fe85824517a20a7f562488dd46671a3903a8a99 |
| pilot-visual-worker | 2900312 | c2b78b0023e5dbd1dd3b45d05b1918aa24527a8211c5f427a650e94191019fb6 |

The externally staged qualification probe hash was
`0f36511ad2227af0a5486380ac1e298d4d257a9c6c6699267a7465ddd6b3f800`.
Its package-validator hash was
`b89d20f978f02c322fd572a48516966fc8a5e78a4e8c30c467ad6663ea0de882`.
These identify the actual probe tools, not another compiled GUI source revision.

The native probe successfully:

1. Copied both real executables, renamed their parent to a path with spaces and
   ran relocated help successfully.
2. Required both inputs to be ELF64 x86_64 and audited every ELF dependency,
   RPATH/RUNPATH and GLIBC/GLIBCXX symbol requirements with readelf/ldd.
3. Confirmed missing Wayland fails closed even with `DISPLAY=:99`.
4. Launched an explicit synthetic fenced-message fixture with isolated state on
   the authorized existing Wayland socket, since Weston was not installed.
5. Observed actual `get_toplevel` and `wl_surface.attach` requests while the GUI
   remained alive, then terminated/reaped only that exact fixture child. The
   existing compositor was neither signalled nor reconfigured.

The receipt reports `compositor=existing-wayland-explicit`,
`relocation=true`, `no_wayland_refused=true`,
`wayland_toplevel_and_buffer=true`. Software Mesa was requested. This is not
visible GPU, IME, interaction, frame-pacing or performance acceptance.

On this build the GUI's maximum recorded GLIBC requirement is **2.43**, and the
helper's is **2.38**. They resolved on this host. These binaries are not evidence
of compatibility with older distributions or Ubuntu CI's separately built bytes.
The GUI links libxcb/xkbcommon-x11 transitively, but the runtime backend remains
Wayland-only; no X server or fallback was used.

Original package tests passed9/9 natively; later package/archive/compositor
synthetic checks passed12/12 natively with externally staged tools.

## Runtime staging failures and remaining limits

The first full-runtime staging attempt verified pinned Node24.21.0 and jj0.46.0
downloads and installed frozen production dependencies into a fresh private
tree. Node-PTY source compilation failed because the default system GCC lacked
`libstdc++.a` required by the existing static-link policy. The owned failed
staging tree was removed; nothing was published or installed. The already
installed Homebrew GCC16 static archive was then located for an explicit retry.
No static-link or ABI limit was relaxed.

That retry compiled Node-PTY but was rejected by the existing relocation audit
because the Homebrew compiler embedded absolute Homebrew RUNPATH entries. The
compiler-selection workaround was not retained in the final producer.

The next build used native, rootless Podman with Python3.13.6/GCC10.2.1 on
Debian11, image
`dfac0f6e0824af83e0737e300092e12fde83f1a9e5be0514a19faed124ad92fa`.
Only the private fixture workspace was mounted. It used the invoking nonroot
UID, CPU2/4GiB/pids512, no capabilities and no-new-privileges. The unchanged
runtime ABI audit passed: minimum GLIBC2.28 and GLIBCXX3.4.21 across Node, jj,
Node-PTY, SDK native addon and esbuild. Offline production smoke passed both
before and after the builder's relocation, reporting Node24.21.0/modules137 on
glibc2.31. This exercises SQLite, SDK/faux-provider kernel loading, generated
usage-worker validation, bundled resources and a real owned PTY.

Final extraction then exposed pnpm-generated hardlinks. The producer now
materializes their archive bytes into separate regular files, including every
copy in the expanded-byte budget. It does not relax the final inventory's
single-link requirement. This regression and real owned-builder success/timeout
cleanup have focused tests. Container staging path/UID issues were corrected
without adding privileges. The final full-package evidence is recorded below
only after successful assembly; these intermediate passes alone are not that
claim.

## Complete relocated package fixture, passed

The immutable runtime producer completed successfully. Its full receipt contains
24,431 runtime entries. The assembled GUI package contains24,439 payload entries
and eight ELF files, including the GUI/helper, Node/jj, SDK addon, both esbuild
entries and Node-PTY.

The package was assembled from matching source receipts, renamed to a path with
spaces, and the original runtime staging path was removed by renaming it to a
retained evidence directory. Only then did the following checks run successfully
on the native Fedora workstation:

- Full package inventory/receipt verification before and after execution.
- Relocated `bin/pilot-next --help`, using the package's real shell launcher.
- Every shipped ELF dependency/search-path/symbol-version audit, with no missing
  dependency and no Homebrew/checkout RUNPATH escape.
- The packaged Node's offline production-runtime smoke from the relocated tree,
  reporting Node24.21.0/modules137/glibc2.43 on the workstation. SQLite,
  generated resources, faux-provider SDK/kernel adapter and owned PTY passed.
- The packaged GUI's actual Wayland toplevel and attached rendered buffer, with
  the same isolated existing-compositor fixture procedure described above.
- Final15/15 focused packaging tests natively, including real builder-process
  success/timeout cleanup and separate-file hardlink materialization.

Exact receipts:

| Receipt | SHA256 |
| --- | --- |
| Package inventory (`linux-gui-package.json`) | 5a8847bc6e36389155e67463109929cee6c9a26bec4663d483cc188075471f73 |
| Immutable runtime input inventory | 6e422c83c7a5f7a0c44aa37b525e26329bdb75d81d51036b303e04e0cc883a9b |
| Actual production-run producer | baca9e5f7d73eec4ba2f2543e28efb3c7af66ddb844a7987ab829fae504298f5 |
| Final simplified producer,15 native tests | 6f1cdf01e59f8281f918c7d46b0b1ec9aec9d80d9546cc6f8fe225db8868d6b4 |
| Assembly/relocation qualification driver | 3ac8766fe63e9cffb39128c24e5b108c5e04ee560ff72987bbc57cad0267f599 |

The production-run producer still contained the unused compiler-selection
options. Those options were removed afterward per the simpler-implementation
direction; final native tests cover the resulting producer. Payload source and
GUI/helper bytes did not change. This distinguishes actual tool hashes instead
of relabeling the earlier run as another source revision.

The development directory is retained on the authorized workstation under
`~/.cache/linux-gui-qualify.hms889/relocated GUI candidate`, with runtime/build,
dependency and Wayland qualification receipts beside it. It was not installed,
uploaded as a production release, or set as the default app.

This qualifies that exact package's **native fixture closure and relocation**,
not general Linux support, a new GUI source revision, live daemon compatibility,
bundled Linux daemon launch/retention, native visual confinement, Linux installer
or updater. These capabilities stay disabled. There was no live Local connection,
automatic replay, profile migration, existing daemon adoption/stop/replacement
or production release/feed/signing action.

The source-only shared CI registration still uses owned headless Weston and
software Mesa. This workstation receipt does not claim that CI ran or passed.
See [the package contract](../docs/linux-gui-package.md) for the remaining gates.
