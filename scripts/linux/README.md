# Linux headless runtime

The standalone daemon can run on Linux x86-64 for development. This is not a remote execution
feature in the macOS app. SSH setup, cross-host sharing/Control, automatic remote updates and
their workflow fixtures have been removed. See [retained devbox data](../../docs/devboxes.md).

## Package

`Pilot-linux-x64.tar.gz` contains one `runtime/` directory with private Node 24.21.0, jj 0.46.0,
production dependencies, built artifact libraries and `bin/pilot-runtime`. Native dependencies
build against bundled Node headers in a pinned older-libc toolchain. CI audits every ELF's
architecture, GLIBC/GLIBCXX requirements and library resolution, then runs the extracted tree's
`check-runtime.mjs` with its bundled Node. The separate Linux headless/isolation lane remains.
Packaging no longer provisions a disposable SSH service or exercises a remote updater.

Release assets remain independently signed: `runtime-manifest.json` binds the exact version,
tag, commit, archive size/SHA256, protocol range and measured ABI requirements;
`runtime-manifest.json.sig` signs the exact manifest bytes. `runtime-abi.json` is inside the archive.
Configure `LINUX_RUNTIME_PRIVATE_KEY` as an Actions secret and its raw 32-byte base64 public key as
the `LINUX_RUNTIME_PUBLIC_KEY` repository variable. The Mac app no longer embeds or consumes this key.
An unsigned checksum beside an archive is not an authentication authority.

Release publication still waits for verified macOS and Linux assets from the matching source commit.
PR packaging never signs, publishes or accesses release secrets. No source or package verification
here proves deployment on a user's machine.

## Same-machine service

On Linux, `bin/pilot-runtime probe` reports local prerequisites without changing the machine.
The explicit `install`, `start`, `status` and `stop` actions manage that user's `pilotd.service`.
Installation refuses a different existing unit; switching runtime paths is an independent manual
operation, not an automatic update flow. The helper does not install OS packages, grant linger,
change system security or copy provider credentials. Set up authentication independently on that
machine. The unauthenticated daemon API remains bound to loopback.

Previously stored update journals are not deleted or resumed. An unresolved or unreadable journal
keeps admission fenced on restart rather than inventing a successful switch or releasing ownership.
Manage that original installation independently if needed.
