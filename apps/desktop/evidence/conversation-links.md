# Loaded links inspector verification

2026-10-26, macOS arm64. Synthetic data only, hidden native windows. No live
Local actions, app installation/restart, URL opening or new backend capability.

## Scope and audit

See [the contract and Swift/Next source audit](../docs/conversation-links.md).
The feature uses a captured loaded window, explicit Refresh, conservative web URL
parsing, dedup with canonical source identities, explicit clipboard copy and
loaded-source navigation. There are no automatic stream scans or history reads.
One adjacent inspector is shown at a time. Existing composer/reader owners stay
mounted; no delivery or transcript handlers are replaced.

## Checks

Passed through the shared serial slot and existing Cargo/mbx wrapper, CPU2/4GiB,
with private worktree outputs and unchanged profiles/toolchain:

```
python3 apps/desktop/scripts/check-scoped.py --unit conversation_links \
  --test conversation_links --test usage_overview --native-probes --lint
python3 scripts/verification-slot.py swift -- bash -c \
  'cd apps/desktop && bash scripts/cargo.sh build --locked --bin pilot-desktop'
```

Rationale: four pure/actual-reader tests cover parser rejection, UTF-8/caps,
dedup/provenance and actual reducer entry/model/block text. The mounted Links
probe covers the header, keyboard Copy, exact clipboard text, source disclosure
and navigation, stale/missing canonical sources despite presentation-ID reuse,
composition guards, retained draft/selection/reader anchor through a current
publication, explicit refresh, focus restoration and conversation/generation
fences. Usage overview is the affected composition check after reconciling the
concurrent shared shell/registry change. Clippy used `-D warnings`; the ordinary
production binary also built. `git diff --check` passed.

All four 680/1100 light/dark layouts ran. Native screenshots were inspected and
published as image artifacts, not SwiftUI/web mocks. Header/coverage and each
link are visibly separated; sources remain secondary disclosure. No motion was
added. Existing dependency `block` emits a future-compatibility warning.

After the shared task-model registry landed, the owned feature was rebased again.
Links plus the task-model mounted target, matching Clippy and ordinary binary
build were rerun on that composition. Foreign task-model and usage code was
preserved; the registry keeps all three feature scopes. Full CI, OS-level IME, dedicated accessibility, Wayland and runtime
performance acceptance are not claimed by the offscreen probes.
