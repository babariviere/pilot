# Day Native Shell release qualification

## Current release migration

Day pins the official [v0.6.1 release](https://github.com/longbridge/nsh/releases/tag/v0.6.1)
across its CLI, native, fixture and runner locks. The release commit is
`2f51d8611677c8a6bbad937b39756e8d0cc45350`. See
[package inputs](day-package-inputs.md) for the build-time checks.
The official macOS arm64 archive hashes to
`ee1aed2a4d111fe90e6cceca4b9d5f834c9e11cfda525f8be984261a329c06de`.
The extracted binary reports `nsh 0.6.1 (2f51d86)` and hashes to
`96066fadf2a578216cf5d2692be56b1db1af7523c2ddeab6e1bf951b352b75d5`,
the same as the Homebrew distribution's binary.

The package validator pins the crates.io archive hashes for the native closure.
All 13 cached archives matched those hashes and name the release commit in
their `.cargo_vcs_info.json`. The official CLI emitted the same exact
capability manifest for a fixture with Day's scoped window and host grants.
These checks do not qualify a signed package or native launch.
