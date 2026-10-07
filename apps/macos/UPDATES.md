# Private builds and automatic updates

GitHub Actions verifies changes on `main`. Release Please maintains a version/changelog PR;
merging it builds a stable **Apple Silicon (arm64) macOS 14+** release tagged `vX.Y.Z`.
Other verified main commits publish GitHub prereleases tagged `dev-<12-character commit SHA>`.
Pilot checks the private repository every hour while the app is running, first reuses local `gh`
authentication (with a manual Keychain-token fallback), and uses Sparkle 2.8.1 to verify and install updates. Released apps bundle
Node 24, pilotd, the kernel and their production dependencies. Your checkout is not needed at runtime.

No Apple account or developer membership is required. These are **ad-hoc signed, not notarized**
personal builds. macOS may block the first downloaded app; use System Settings > Privacy & Security >
Open Anyway only after verifying that it came from your own repository. Keychain may request approval
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
   Release Please needs Contents, Issues and Pull requests write permissions, scoped in its job.
   Optionally configure **Actions secret `RELEASE_PLEASE_TOKEN`** with a GitHub App token or a
   fine-grained personal access token limited to this repository with those permissions. This is
   required if CI checks must automatically run on bot-created release PRs: the default `GITHUB_TOKEN`
   can create PRs, but GitHub suppresses workflows triggered by its changes. Do not give this token
   access to other repositories. The macOS publishing job still uses only `GITHUB_TOKEN`.
4. Merge the workflow changes, then merge the Release Please PR when ready to release. PRs run
   verification only, without release secrets or publishing permissions. The release job fails with
   a configuration message if signing keys are missing. Ordinary main commits publish dev prereleases,
   not stable releases.

The workflow is `.github/workflows/macos-release.yml`. It selects an arm64 macOS runner with Xcode
26.2 (Swift 6.2), runs TypeScript and Swift checks, builds the app, stages a production runtime, and
publishes `Pilot-arm64.dmg`, `Pilot-arm64.zip` and `appcast.xml` together in a GitHub Release. Release Please creates
only a draft, so incomplete uploads are not offered to the app. The tagged release commit is built
and tested even if `main` has advanced. App versions come from root `package.json`; Release Please
updates it, `package-lock.json`, `.release-please-manifest.json` and `CHANGELOG.md` in the release PR.
The existing source plist is only a template; bundling writes the package version into the app.
Dev builds display `X.Y.Z-dev.<short SHA>` instead of a workflow number. Published dev SHAs are
immutable; rerunning an already complete dev release is a no-op. Dev prereleases never become
GitHub's stable latest release and are never offered through automatic updates. To install one,
download its DMG manually. Installing a dev build does not enable a dev update channel.

`fix:` commits bump the patch version, `feat:` commits bump the minor version, and breaking-change
commits (`feat!:` or `BREAKING CHANGE:`) use Release Please's semantic-version rules (including its
pre-1.0 rules). Release notes are generated from conventional commits. The manifest starts at `0.1.0`;
versions without prerelease suffixes are stable releases, even before `1.0.0`.

Sparkle's separate build version still uses the workflow run number and attempt. Keep the workflow
identity and signing key stable so build versions continue increasing. Publication checks both
semantic and Sparkle build ordering. Old `pilot-N.M` releases are supported as a one-way migration;
the first stable release can replace them without changing the installed app's signing trust.

If publication fails after draft creation, rerun the failed release job, or use **Run workflow** on
`main` with **`release_tag`** set to the existing stable draft (for example `v0.2.0`). A new dispatch
also fixes a draft whose Sparkle build version is older than the latest release. Retrying replaces
only draft assets; published releases and prereleases cannot be overwritten. A failed dev draft can
also be recovered by rerunning its failed release job. Leave `release_tag` empty to run Release Please
normally (publishing the current dev SHA if no stable release is created). Obsolete incomplete `pilot-N.M` drafts may be deleted manually,
but do not publish them. No workflow deletes existing releases.

## One-time app setup

1. Download **`Pilot-arm64.dmg`**, open it and drag **Pilot.app** onto the **Applications** shortcut.
   Eject the disk image, then open the installed app from `/Applications`. For a per-user install,
   drag it to `~/Applications` instead. The ZIP is still available for manual extraction and is used
   by Sparkle updates. Do not run the app directly from the disk image or a transient download folder.
2. When migrating from a checkout-based Pilot, wait for agents to finish, then choose **Restart pilotd**
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
  URLs. The app restricts downloads to the selected release's archive and disables external release notes.
- Sparkle validates the archive against the public signing key **before extraction**. CI also verifies
  the archive signature against the public key actually embedded in the app before publishing.
- A downloaded update waits for agents and queued work to finish. The daemon grants a short quiescence
  lease that pauses new admissions, then the app unloads the launch agent, installs and relaunches.
- **Terminal shells close on installation.** Durable sessions and history remain. A waiting update can
  delay quitting Pilot until agents finish; stopping an agent manually is still your choice.
- A failed download or invalid signature does not replace the installed app. A missing/unreachable or
  older daemon cannot grant the lease, so installation waits and Settings shows the problem.
- If an error happens after installer preparation, Pilot conservatively keeps the quit safety gate,
  because Sparkle's helper may still install on termination. Retry from Settings; if pilotd was already
  stopped for installation, it stays stopped until the update is resumed or you restart it explicitly.
- An ordinary quit with no pending update still leaves pilotd and agents running.

## Local development

`npm run app:macos` still creates a development app using your source checkout and system Node.
It embeds Sparkle but leaves private updates disabled unless configured explicitly. The unbundled
`swift run Pilot` path remains supported. Snapshot mode never starts the updater or accesses Keychain.

To reproduce a self-contained bundle locally without publishing:

```sh
BUNDLE_RUNTIME=1 BUNDLE_VERSION=100.1 \
PILOT_UPDATE_REPOSITORY=owner/repo SPARKLE_PUBLIC_KEY='<your public key>' \
apps/macos/scripts/bundle.sh
```

To create a drag-and-drop installer from a built app:

```sh
apps/macos/scripts/create-dmg.sh apps/macos/build/Pilot.app apps/macos/build/Pilot-arm64.dmg
```

Do not distribute a local build with a version higher than CI's next release, or it will not be offered
that older CI build. Publishing is deliberately a separate CI-only script, not part of local bundling.
