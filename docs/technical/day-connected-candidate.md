# Connected native candidate

This is a local acceptance candidate, not a demo, release, update payload or
default-app switch. It uses the actual `Connected.tsx`, production native
bootstrap, sole `NativeHost` and deferred close owner. NSH stays at unmodified
0.4.0. It connects to an explicitly selected existing daemon; it never starts one.

## Prepare without assembly or signing

Use current main, the existing installed NSH/Rust tools, global MBX defaults and
the frozen pnpm dependency tree. The input builder also needs the existing pinned
QuickJS archive. The environment/tool paths are described in
[Day package inputs](day-package-inputs.md#entry-points).

```sh
candidate_dir="$(mktemp -d "${TMPDIR:-/tmp}/pilot-connected.XXXXXX")"
python3 apps/day/scripts/candidate.py prepare \
  --source FULL_COMMIT \
  --trust-from '/absolute/existing/verified/Pilot Next.app' \
  --output "$candidate_dir/inputs"
```

The explicit trust source supplies the existing **public** updater configuration.
The script checks its real code seal, bundle inventory, app ID and build. It does
not generate keys, reuse a private key, change policy or select a profile/model.
It builds configured source-matched native inputs and the exact connected NSH
resource closure. It prints the one separate assembly/signing command.

## Local development assembly

A request for a locally launchable development candidate covers routine assembly
and ad-hoc code sealing in a fresh task-owned temporary directory, using the
unchanged existing trust policy. Preparation and assembly are separate build
stages, not a second approval hold. They do not authorize installation,
replacement, registration, live updates/restarts or provider/domain writes.

```sh
python3 apps/day/scripts/candidate.py assemble \
  --inputs "$candidate_dir/inputs" \
  --output "$candidate_dir/Pilot Next.app"
```

This creates a fresh temporary bundle with the existing app identity and an
ad-hoc code seal under the existing private-distribution policy. It verifies
architecture, native dependencies, compiled source/trust and the exact NSH
resources before returning. It neither installs nor launches it, registers URL
schemes, replaces an app, stops a chat, updates a daemon or writes a live profile.
No existing output can be overwritten. Verify again with:

```sh
python3 apps/day/scripts/candidate.py verify "$candidate_dir/Pilot Next.app"
```

If genuine platform or trust verification refuses the candidate, report the
precise error. Do not weaken verification or create a new trusted key.

Ordinary connected bootstrap requires its genuine native executable, compiled
trust, correct bundle layout/code seal and trusted NSH resources. It does **not**
require bundling a second daemon. This minimal candidate therefore contains no
daemon runtime, legacy helper or update target and is not accepted by the full
update-distribution assembler. Future daemon runtime packaging belongs under the
verified NSH app's `Contents/Resources/runtime`, not GPUI capsule discovery. That
future update work must implement the agreed global pause-first protocol and is
not activated here.

## Authorized launch and read-only integration

The preserved executable path is
`Pilot Next.app/Contents/MacOS/pilot-desktop`. Use the explicit native launch
selection in [Connected launch](day-package-inputs.md#connected-launch), keeping
its private journal across reopen. Reading existing work needs no planning model;
new work needs an explicit model and its separate permissions/confirmation.

`native/examples/connected_readonly.rs` checks the actual host and connected TSX
without a signed app or visible native window. It accepts only an explicit native
`Source` JSON (profile, port, home daemon/lineage IDs, project ID/path) and exact
mission ID. The source contains **no credentials**; Rust reads the private native
capability itself. Its VM grant permits reads and its own local form-flush ACK,
but denies creation, submission, Start, human replies and verification writes.
It checks real Today/mission navigation, ordinary cold reopen and exact unsent
New draft bytes in its own temporary journal. It starts no daemon/provider work.

```sh
apps/day/scripts/cargo run --locked --manifest-path apps/day/native/Cargo.toml \
  --example connected_readonly -- --source /absolute/native-source.json \
  --mission EXACT_MISSION_ID
```

This is real-host integration evidence, **not native visual/input acceptance**.
Its headless capture is not AppKit preedit proof. Actual signed-window keyboard,
focus, selection, scroll, close/reopen and IME checks remain separate. A connected
mission journey that submits answers or starts providers needs explicit execution
approval. Reports are not human acceptance. Unavailable intake/Linear routes,
continuation or budget capabilities remain visible, never mock substitutes.
