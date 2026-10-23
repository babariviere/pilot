# Calm shell hierarchy

This is a narrow Home/sidebar styling and reachability slice, not a full app
redesign, feature-parity or user-acceptance claim. Swift stays operational.
App-wide icon coverage and finishing remain separate unfinished work.

## Scope

- App-owned spacing/type roles and physical-pixel hairlines in `appearance.rs`.
  Kit's global type sizes, Markdown, editor metrics, radii and palette are not
  reset. The measured76/34 composer and shared Bayer clock are unchanged.
- Global Home/Inbox above an exact-project browse selector. The existing bounded
  project list opens inline, with explicit Overview, All chats, history, archive
  visibility, search and new-chat access retained. Selecting scope grants no
  folder, creation, model or permission authority.
- Home leads with Projects, Working now and Recent chats. Loaded-Local coverage
  is explicit; quiet zero activity counts are omitted. Flat title/metadata rows
  replace nested emphasis, without inventing unread or authoritative totals.
- The new chooser refuses existing composer/sidebar/active Inbox preedit before
  moving focus. Empty/loading/error choices keep a mounted keyboard owner and
  Escape closes them. Status-only catalog errors do not reset the keyboard
  cursor; queued hidden or palette-covered choices cannot navigate.

Transport, worker/store, canonical reader/transcript, composer, work disclosures,
artifact/slider/helper, jump controller, lockfile and patch specs are identical
to the corrected parent. No new clock, background parsing, endpoint or service.

## Verification and provenance

Frozen final production/test source:
`adb5e161cae127b89caf98bf2ffcf3d80989daa3`.

The before harness is
`938fe02454c6676888904b5b65b682c9293c1ffa`, with production UI identical to
`cf5eb2d9c4efbb1ff118123f9b9cf70008ed41cb`. Its four baseline native scenes
passed before production styling. The private work was later updated once onto
corrected parent `a24a86752299729740cef1eb77650efabd339d58`; that parent's
explicit Select preedit seam changes no default rendering or styling.

Final after captures use the same Rust/test inputs as the frozen source; only
README documentation was added after that focused run. The same fixed
`workbench-v1` data, viewport760pt, routes and long labels are captured at680/1100pt
in light/dark. Chat, Home, scope choices, removed-project/error, loading and
empty frames are saved before the extra interaction checks. Those later checks
do not alter the paired capture content. Bayer phase can differ; static images
do not verify motion.

Focused strict all-target/native checks and all four final workbench scenes
passed. The preceding functional pass also covered four Shell, eight navigation/
canonical-reader, four Inbox and four palette scenes. New tests verify actual
mounted label bounds, chooser pointer/keyboard reachability, exact marked text/
range/focus, draft and reader preservation, status-only cursor retention,
hidden/palette event fences, zero implicit reads and zero canonical writes.
Synthetic preedit is committed through the real insertText handler before
asserting saved drafts; unmarking alone is not a Change event.

The complete macOS gate passed on the frozen pre-rebase source: **149 library
tests passed,2 ignored**, strict all-target/native/app/helper checks, the entire
native matrix including all four workbench scenes, four mocked Python tests,
locked builds and engine-symbol isolation. The new workbench target runs with
the optional baseline environment flag removed, so normal verification cannot
silently skip its new layout/interaction assertions. A subsequent user-requested
rebase onto current main requires its own integration check; this result is not
claimed for changed main inputs.

```sh
cd apps/desktop
bash scripts/cargo.sh clippy --locked --all-targets --features native-probes -- -D warnings
PILOT_NEXT_WORKBENCH_DIR=evidence/local/workbench-after \
  bash scripts/cargo.sh test --locked --features native-probes --test workbench
bash scripts/check.sh
python3 scripts/test_measure_scaling.py
bash scripts/cargo.sh build --locked
bash scripts/cargo.sh build --locked -p pilot-visual-worker
```

## Actual synthetic image evidence

These are real production-root GPUI offscreen pixels, not SwiftUI mocks or real
Local/private captures. The approved static proposal remains a separate design
reference, not evidence of these views. Raw captures/logs stay ignored.

| Image | SHA-256 |
| --- | --- |
| Before680 light Home | `7e5b0aa02ea7e2f544c9dde54213b8bd8b70e8c07a1fef2fd19cb817e066b025` |
| After680 light Home | `b8f9f818b207de4c690f081daf53e0aecd60965374f41a304eb4197b4f1788be` |
| After1100 dark Home | `89e14c3e4e6f860cc7392463dc35f33ae61f8af5b4e13fc9e56137585ff33d17` |

Rendered Home, chat, scope and removed/error states were inspected in narrow/
wide and light/dark. An initial centered navigation-label defect was corrected
by styling Button's inner content, not only its Base wrapper; mounted left-edge
assertions now cover it. Header/long-label bounds and existing no-write route
checks remain enforced. Scrollable Home content below the fold is not clipped
navigation.

## Frontend-design skill review

The repository's Anthropic `frontend-design` skill is used for a fresh review
of these actual captures. It was added after this source freeze; this is an
explicit critique of the current implementation, not a claim that the upstream
skill guided earlier code. The approved brief remains the constraint.

Plan: a native workbench for people supervising background agents, not a SaaS
metric dashboard. Six existing roles anchor the palette: page `#FFFFFF/#262626`,
sidebar `#FAFAFA/#202020`, ink `#262626/#D4D4D4`, metadata `#6B6B6B/#9A9A9A`,
neutral selection (black6%/white8%) and semantic working ink `#4F46E5/#A5B4FC`.
The system sans is an intentional native-platform choice, with26/22/15/13/11pt
display/title/heading/body/caption roles; monospace is for source, not decoration.

```text
Global Home / Inbox | Home: configured projects
Browse-only scope   | Working now
Search / chat list  | Recent chats
```

Review against the brief: one quiet reading column, left-aligned navigation and
rows, sentence-case labels, no KPI-card grid, decorative numbering, added hero
gradient or new clock. The existing Bayer state corner is the single distinctive
signature. Hairlines separate real rows; the browse-scope label explains a real
authority boundary. Existing dot-separated metadata is an intentional shared
product convention, not newly introduced ornament.

Earlier rendered critique caught inner Button alignment; this pass confirms the
correction and mounted label-bound coverage. Typography remains scoped instead
of shrinking editor/Markdown globally. Errors retain actual context/data, and
empty choices retain keyboard access rather than inventing unsupported actions.
Remaining app-wide icon and finishing gaps are explicit, not declared solved by
this hierarchy pass. No extra UI churn, font download, web library or motion is
introduced merely to imitate a website.

No visible launch, real actions, OS IME, macOS15 hardware, CPU/RSS/smoothness,
Linux/Wayland, release/default switch, updater or Swift-removal acceptance was
performed or implied. Existing full-app and feature deferrals remain.
