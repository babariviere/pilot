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

The only new Actions secret is `DAY_UPDATER_PRIVATE_KEY`. It matches the
dedicated `DAY_UPDATER_PUBLIC_KEY` repository variable. After the local-material
audit, the user confirmed no existing PEM exists and explicitly authorized a
new key. This does not rotate or overwrite GPUI's updater keys or variables.
The Day private PEM is age-encrypted in `apps/day/fnox.toml`.
Provisioning is already complete. For a separately authorized future reprovision,
use a trusted terminal, stdin and the explicit repository. Do not regenerate or
overwrite keys just to run these commands:

```sh
set -euo pipefail
test "$(gh repo view babariviere/pilot --json nameWithOwner --jq .nameWithOwner)" = babariviere/pilot
key=$(fnox --no-daemon --non-interactive -c apps/day/fnox.toml get DAY_UPDATER_PRIVATE_KEY)
test -n "$key"
printf '%s' "$key" | gh secret set DAY_UPDATER_PRIVATE_KEY --repo babariviere/pilot
unset key
```

fnox writes encrypted ciphertext, not the plaintext PEM, to its configuration.
Use `fnox set --provider age` over stdin only when an authorized import is needed.
Review that only age ciphertext was added before committing. Before writing,
verify the locally derived public key matches `DAY_UPDATER_PUBLIC_KEY`, using
the direct OpenSSL check in the readiness workflow. The pipeline sends plaintext
directly to `gh secret set` over stdin, without a custom provisioning wrapper.
The non-exported shell variable prevents a failed decryption from starting an
empty-key write. Keep shell tracing off; unset the variable when finished.
An interrupted, timed-out or unacknowledged write is **Unknown**. Never retry it
automatically or claim success from a later secret-name listing.

Keep `~/.config/fnox/age.txt` and its recovery copy outside the repository.
Do not encrypt the only recovery identity into this config or upload this
personal identity to GitHub. CI uses the dedicated Day secret directly; it
does not need the age identity or access to other encrypted local secrets.

## Qualification boundary

`.github/workflows/day-signing-readiness.yml` is manual, main-only, read-only,
and runs only direct OpenSSL commands, without checkout or repository code. No PR,
push, tag or reusable-workflow caller receives this secret through this path.
It verifies the key pair without signing anything. It is not dispatched by
provisioning. Existing unsigned `day-qualification.yml` remains secret-free.

Provisioning verifies the generated key pair locally and records acknowledged
GitHub secret and public-variable writes, without printing private material.
Separately authorize readiness execution and actual Day signed-bundle
qualification. Native bundle/resource/helper identity,
official update archives, safe lifecycle/update recovery and native acceptance
remain open. Apple Developer ID/notarization requires separately verified
material and supported policy, not extra guessed secret names.

References: [fnox age](https://fnox.jdx.dev/providers/age.html),
[configuration](https://fnox.jdx.dev/reference/configuration.html), and
[Day packaging](day-ci-packaging.md).
