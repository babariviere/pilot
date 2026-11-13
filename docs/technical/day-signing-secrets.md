# Day signing secret setup

This is provisioning and credential readiness, not signed-bundle acceptance.
GPUI's release selection, secrets and signing checks are unchanged.

## Audited configuration

- Repository: `babariviere/pilot`, default branch `main`; administrator access verified.
- Installed fnox: 1.40.0. Configuration: `apps/day/fnox.toml`.
- The age recipient comes from the existing `~/.config/fnox/age.txt` identity
  (mode 0600). No identity was generated, rotated or committed.
- No existing fnox configuration or usable local Apple signing identity was found.
- Current repository signing policy: `private-adhoc`. The assembler uses ad-hoc
  codesigning plus independently signed update metadata. It does not implement
  Apple Developer ID signing/notarization. No Apple secrets are invented here.
- Existing repository secret `PILOT_NEXT_UPDATER_PRIVATE_KEY` cannot be read back
  from GitHub. Its name alone does not prove a usable/matching key.

## Import and provision

The only new Actions secret is `DAY_UPDATER_PRIVATE_KEY`. It must be the
**existing** Ed25519 PEM matching `PILOT_NEXT_UPDATER_PUBLIC_KEY`, not a new key.
The config intentionally has no ciphertext until that material is available.
Use a trusted local terminal or process stdin, never a chat or command argument:

```sh
fnox --no-daemon --non-interactive -c apps/day/fnox.toml set DAY_UPDATER_PRIVATE_KEY --provider age < /secure/existing-updater.pem
python3 apps/day/scripts/provision-signing.py --write
```

fnox writes encrypted ciphertext, not the plaintext PEM, to its configuration.
Review that only age ciphertext was added before committing. The script checks
repository access and the derived public key before sending plaintext directly
to `gh secret set` over stdin. It logs only a successful write acknowledgment.
An interrupted, timed-out or unacknowledged write is **Unknown**. Never retry it
automatically or claim success from a later secret-name listing.

Keep `~/.config/fnox/age.txt` and its recovery copy outside the repository.
Do not encrypt the only recovery identity into this config or upload this
personal identity to GitHub. CI uses the dedicated Day secret directly; it
does not need the age identity or access to other encrypted local secrets.

## Qualification boundary

`.github/workflows/day-signing-readiness.yml` is manual, main-only, read-only,
and uses immutable source with no persisted checkout credentials. No PR,
push, tag or reusable-workflow caller receives this secret through this path.
It verifies the key pair without signing anything. It is not dispatched by
provisioning. Existing unsigned `day-qualification.yml` remains secret-free.

Remaining: obtain the verified existing PEM, import its age ciphertext, get an
acknowledged GitHub write, then separately authorize readiness execution and
actual Day signed-bundle qualification. Native bundle/resource/helper identity,
official update archives, safe lifecycle/update recovery and native acceptance
remain open. Apple Developer ID/notarization requires separately verified
material and supported policy, not extra guessed secret names.

References: [fnox age](https://fnox.jdx.dev/providers/age.html),
[configuration](https://fnox.jdx.dev/reference/configuration.html), and
[Day packaging](day-ci-packaging.md).
