# Updater checkpoint evidence

Scope: only new `apps/desktop/updater/` files, based on published
`5bd2498d2cd71fc3b4f864620c31deff2576c2a3`. Shared desktop/Settings/CI/packaging
seams remain untouched. This checkpoint is not integration or updater acceptance.

## Verification record

Focused Rust and linked Objective-C synthetic checks are pending resource admission.
Formatting and `bash -n tests/native.sh` have passed; no compile/test pass is claimed yet.
Final results will identify exact frozen source and command logs.

## Explicit gaps

- No real feed, token, Keychain, network release, production bundle/daemon mutation,
  install, restart, signing operation, Swift build/test or Linux gate was exercised.
- Native implementation is probe-only, using genuine public Sparkle APIs, not a
  mocked native updater. `Available` remains unverified metadata.
- Synthetic install/restart/failure transitions cover the Rust safety protocol only.
  Cryptographic archive verification, signed/wrong-app archives, download/extraction,
  prepared-helper ordinary quit, crash recovery, durable gating and native install
  remain unimplemented/unverified, not test passes.
- Native installation is hard-disabled. See README transport and ordinary-quit
  blockers, credential/identity contract and packaging/integration prerequisites.
