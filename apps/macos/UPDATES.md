# Private builds and automatic updates

GitHub Actions builds **Apple Silicon (arm64) macOS 14+** releases after changes land on `main`.
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
3. Merge the workflow and app changes, or use the workflow's **Run workflow** action on `main` after
   configuring the key. PRs run verification only, without release secrets or publishing permissions.
   The release job fails with a configuration message if keys are missing.

The workflow is `.github/workflows/macos-release.yml`. It selects an arm64 macOS runner with Xcode
26.2 (Swift 6.2), runs TypeScript and Swift checks, builds the app, stages a production runtime, and
publishes `Pilot-arm64.zip` and `appcast.xml` together in a GitHub Release. Incomplete uploads remain
drafts and are not offered to the app. Build versions use the workflow run number and attempt. Keep
the workflow identity and signing key stable so versions continue increasing.

## One-time app setup

1. Download `Pilot-arm64.zip` from the first complete release, extract it and move **Pilot.app** to
   `/Applications` or `~/Applications` before opening. Do not run it from a transient download folder.
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

Do not distribute a local build with a version higher than CI's next release, or it will not be offered
that older CI build. Publishing is deliberately a separate CI-only script, not part of local bundling.
