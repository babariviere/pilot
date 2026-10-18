# Private builds and automatic updates

GitHub Actions verifies changes on `main`. Release Please maintains a version/changelog PR;
merging it builds a stable **Apple Silicon (arm64) macOS 14+** release tagged `vX.Y.Z`.
CI publishes only when Release Please creates a stable release or an existing stable draft is
explicitly retried. Ordinary main pushes do not publish dev prereleases.
Pilot checks the private repository every hour while the app is running, first reuses local `gh`
authentication (with a manual Keychain-token fallback), and uses Sparkle 2.8.1 to verify and install updates. Released apps bundle
Node 24, pilotd, the kernel and their production dependencies. Your checkout is not needed at runtime.

No Apple account or developer membership is required. These are **ad-hoc signed, not notarized**
personal builds. macOS may block the first downloaded app. Only after verifying that it came from your own
repository, run `xattr -d com.apple.quarantine /Applications/Pilot.app` (or use System Settings > Privacy &
Security > Open Anyway). Sparkle updates do not need this again. Keychain may request approval
again after an ad-hoc signed update when using a manually saved token. GitHub macOS runner usage counts toward private-repository Actions
minutes and may incur charges. No App Store or Developer ID distribution is configured here.

## One-time repository setup

1. Enable GitHub Actions in the private repository. Install GitHub CLI on your Mac and authenticate with
   an account allowed to manage this repository's Actions secrets and variables (`gh auth login`).
2. From a checkout containing these changes, run:

   ```sh
   apps/macos/scripts/setup-updates.sh owner/repo
   ```

   This asks for confirmation, downloads checksum-pinned Sparkle tools, creates or reuses a
   repository-specific Ed25519 signing key in your macOS Keychain, and uploads:

   - **Actions secret:** `SPARKLE_PRIVATE_KEY` (Sparkle's exported base64 private key).
   - **Actions repository variable:** `SPARKLE_PUBLIC_KEY` (base64 public key).

   The private key is never embedded in the app or printed. A temporary export is removed on exit.
   Keep a secure backup of the Keychain key. **Do not regenerate or replace it after distributing an
   app**, because installed versions trust the original public key. The helper refuses to overwrite
   a different configured public key. Secret setup is intentionally not run by the coding agent.
3. In Settings > Actions > General, enable **Allow GitHub Actions to create and approve pull requests**.
   Release Please uses the default `GITHUB_TOKEN` with Contents, Issues and Pull requests write
   permissions, scoped in its job.
4. Merge the workflow changes, then merge the Release Please PR when ready to release.

CI has three entry points. `.github/workflows/pr.yaml` and `.github/workflows/main.yaml` run the shared
tests (`tests.yaml`) on PRs and after merging. `.github/workflows/release.yaml` runs Release Please on every
main push and publishes releases. **Tests never block a release**: Release Please and publishing do not wait
for any test job, so a red `main` can still ship. Release Please PRs (and PRs that only touch
`package.json`, `CHANGELOG.md` or `.release-please-manifest.json`) start no PR run, because GitHub would hold
runs from its bot-created PRs for manual approval. Release commits also skip the main tests.

When Release Please creates a stable draft, `release.yaml` resolves its tag and commit, then builds from that
tag, never from a newer `main`. It selects an arm64 macOS runner with Xcode 26.2 (Swift 6.2). `macos-app`
builds the self-contained app once, without private keys, and verifies its extracted production ZIP. In
parallel, the Linux production package is built and validated from the same tag. `macos-publish` downloads
that ZIP, checks its source commit, version, checksum and embedded public keys, then signs and uploads it
without recompiling or repackaging. Linux publishing likewise signs the verified runtime artifact after
checking its tag and commit. Artifacts come only from the current workflow run, never a PR run or a mutable
build cache. Missing, corrupt or unexpected artifacts fail closed. Only publishing jobs receive private keys,
and missing configuration fails with a setup message. PRs never receive release secrets or write permissions;
they smoke-test an app bundled from the Swift debug test build. The optimized build runs only at release, so
release-only compiler problems surface there.
Release Please creates only a draft. A final publishing job releases it after the Mac ZIP/appcast
and all three Linux assets are uploaded, so incomplete releases are not offered to the app.
An explicit `release_tag` retry builds the requested tag once in each package job, even if `main`
has advanced or old artifacts expired. Current release metadata, runtime-check and publisher helpers
are overlaid for old drafts. Application code, dependencies and vendor pins remain tagged.
App versions come from root `package.json`; Release Please
updates it, `.release-please-manifest.json` and `CHANGELOG.md` in the release PR.
The existing source plist is only a template; bundling writes the package version into the app.
Before signing, isolated runtime staging removes source maps and TypeScript declarations while
preserving executable code, resources, licenses and SDK documentation. This reduces archive size
without pruning the checkout's dependencies; bundled dependency stack traces no longer use those maps.
Existing dev releases are left untouched and are not offered through automatic updates.

`fix:` commits bump the patch version, `feat:` commits bump the minor version, and breaking-change
commits (`feat!:` or `BREAKING CHANGE:`) use Release Please's semantic-version rules (including its
pre-1.0 rules). Release notes are generated from conventional commits. The manifest starts at `0.1.0`;
versions without prerelease suffixes are stable releases, even before `1.0.0`.

Sparkle's separate build version is the `release.yaml` run number plus `BUNDLE_VERSION_OFFSET` (20000), then
the attempt. Renaming or recreating the workflow restarts its run numbers, so raise the offset above the
latest published build when that happens, and keep the signing key stable. The offset moved from 10000 to
20000 when `release.yml` became `release.yaml`, so new builds (20001 and up) stay above the last
`release.yml` builds (about 10900). Publication checks both
semantic and Sparkle build ordering. Old `pilot-N.M` releases are supported as a one-way migration;
the first stable release can replace them without changing the installed app's signing trust.

If publication fails after draft creation, rerun the failed publishing job to reuse its verified
artifact, or use **Run workflow** for **Release** on
`main` with **`release_tag`** set to the existing stable draft (for example `v0.2.0`). A new dispatch
also rebuilds expired artifacts and fixes a draft whose Sparkle build version is older than the latest release. Retrying replaces
only draft assets; published releases and prereleases cannot be overwritten. Leave `release_tag`
empty to run Release Please normally, without publishing unless it creates a stable release.
Obsolete incomplete `pilot-N.M` drafts may be deleted manually,
but do not publish them. No workflow deletes existing releases.

## One-time app setup

1. Download **`Pilot-arm64.zip`**, extract it, and move **Pilot.app** to `/Applications` (or
   `~/Applications` for a per-user install). The ZIP is the first-time installer and is also
   used by Sparkle updates. If macOS refuses to open it, run
   `xattr -d com.apple.quarantine /Applications/Pilot.app` once. Open the installed app, not a copy in a
   transient download folder.
2. When migrating from a checkout-based Pilot, wait for agents to finish, then choose **pilotd > Restart pilotd**
   in the new app's menu bar. This switches the launch agent to the bundled runtime. Terminal shells
   close on that initial restart. Your projects, sessions and pi configuration stay in their existing
   locations. Foreground/unmanaged daemons must be stopped manually before using the app-managed daemon.
3. If GitHub CLI is installed and signed in with access to this repository (`gh auth login`), no token
   entry is necessary. Pilot resolves `gh` using your login-shell PATH and common install locations,
   then runs `gh auth token --hostname github.com`. It refreshes this credential on each check and
   keeps it only in memory, without printing it or saving another copy. The existing `gh` credential
   may have broader access than a repository-limited token. Pilot does not alter your `gh` login.
4. If `gh` is missing, signed out, or cannot access the private releases, Pilot asks for a token.
   Create a **fine-grained personal access token** limited to this repository with **Contents: Read-only**
   permission (and any required organization SSO approval). Enter it in the prompt or open
   **Settings > Updates**, paste it into the secure field, and choose **Save Access**.
   Only this manual fallback is verified against the releases API and saved in your macOS Keychain,
   never UserDefaults, logs, source files, URLs or the release archive. Renew it there if it expires.
   You can dismiss the prompt and run `gh auth login`, then choose **Check for Updates…** to retry.
   Update access is separate from the CI signing key and CI's automatically provided `GITHUB_TOKEN`.

Leave **Check automatically every hour** enabled. **Pilot > Check for Updates…** performs a manual
check. Remove Saved Token deletes the manual Keychain credential when no update is in progress;
it does not sign out of `gh` or disable automatic checks.

## Installation safety

- Downloads and appcasts use authenticated GitHub API asset URLs, not unauthenticated private browser
  URLs. Pilot resolves the appcast API redirect before handing its short-lived signed CDN URL to Sparkle,
  which otherwise overrides GitHub's required Accept header and receives JSON instead of XML. The signed
  URL stays in memory; GitHub tokens are never sent to the CDN. The app restricts archive downloads to the
  selected release's API asset and disables external release notes.
- Sparkle validates the archive against the public signing key **before extraction**. CI also verifies
  the archive signature against the public key actually embedded in the app before publishing.
- A downloaded update freezes new admissions and pauses agents, including subagents, after active tool
  calls finish and their results are saved. Chats and queued work do not need to finish. The app verifies
  the paused daemon process, unloads its launch agent, installs both app and runtime, and relaunches.
  Unfinished work resumes from durable state, without replaying completed tool effects.
- Preparation uses a renewable 30-second lease. If installation is abandoned or preparation fails,
  the lease expires and agents resume rather than remaining frozen.
- **Terminal shells close on installation.** Background subprocesses close too. Durable sessions and history remain. A waiting
  update can delay quitting Pilot until active tool calls finish, not until chats finish.
- A failed download or invalid signature does not replace the installed app. A missing/unreachable or
  older daemon cannot grant the lease, so installation waits and Settings shows the problem.
- If an error happens after installer preparation, Pilot conservatively keeps the quit safety gate,
  because Sparkle's helper may still install on termination. Retry from Settings; if pilotd was already
  stopped for installation, it stays stopped until the update is resumed or you restart it explicitly.
- An ordinary quit with no pending update still leaves pilotd and agents running.
- The launch agent uses the user's home as its working directory and an absolute daemon entry point.
  Removing an old app bundle must not invalidate the daemon's or warm workers' current directory.

## Local development

`pnpm app:macos` still creates a development app using your source checkout and system Node.
It embeds Sparkle but leaves private updates disabled unless configured explicitly. The unbundled
`swift run Pilot` path remains supported. Snapshot mode never starts the updater or accesses Keychain.

To reproduce a self-contained bundle locally without publishing:

```sh
BUNDLE_RUNTIME=1 BUNDLE_VERSION=100.1 \
PILOT_UPDATE_REPOSITORY=owner/repo SPARKLE_PUBLIC_KEY='<your public key>' \
apps/macos/scripts/bundle.sh
```

Do not distribute a local build with a version higher than CI's next release, or it will not be offered
that older CI build. Publishing is deliberately a separate CI-only script, not part of local bundling.
