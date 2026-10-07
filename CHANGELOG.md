# Changelog

## [0.2.0](https://github.com/babariviere/pilot/compare/v0.1.0...v0.2.0) (2026-10-07)


### Features

* add pilotd, durable pi kernel and native macOS app ([0a0177f](https://github.com/babariviere/pilot/commit/0a0177f5d2a4c0157b5020e66f5e6453e079ea79))
* **app:** add changes inspector, colored diffs and session search ([66be3f3](https://github.com/babariviere/pilot/commit/66be3f3b570e60cfc6cc944dc07d9eda9f5a5214))
* **app:** display context and Claude/Codex usage ([71ce158](https://github.com/babariviere/pilot/commit/71ce158bcdc7e96f452b026628eafa89ba297c93))
* **app:** display context and Claude/Codex usage ([02052dd](https://github.com/babariviere/pilot/commit/02052dda2c148af43820562af3b6c2796a8b0ea0))
* **app:** highlight codemode JavaScript blocks ([8adceef](https://github.com/babariviere/pilot/commit/8adceef69f07d6f87591352b2e5b77df1df7c19b))
* **app:** highlight codemode JavaScript blocks ([1d18f5c](https://github.com/babariviere/pilot/commit/1d18f5c27a5c302040d609a93978877bd7ba422b))
* **chat:** edit queued messages inline with keyboard navigation ([e357481](https://github.com/babariviere/pilot/commit/e35748170e3bd3a8e8c3790e85b0134b21242ceb))
* **chat:** edit queued messages without resubmitting ([f9dc45a](https://github.com/babariviere/pilot/commit/f9dc45a123ed28a69d3d569f631fa51cbac24b5d))
* **macos:** add liquid glass plane app icon ([6e513da](https://github.com/babariviere/pilot/commit/6e513da36722297bd14d098d3f7f0940dabaed18))
* **macos:** add plane app icon ([6442c63](https://github.com/babariviere/pilot/commit/6442c63f62ed5aca155ba177a8ee1bef3f197c8b))
* **macos:** airliner with contrails on a plain sky app icon ([b311683](https://github.com/babariviere/pilot/commit/b31168305adeea759b61df8a025b35f0dd9fed1f))
* **macos:** fluffier, fully rounded icon clouds ([aeb8b46](https://github.com/babariviere/pilot/commit/aeb8b464c26f207c0eed013bef0627b9e4b9cdc8))
* **macos:** navy contrail icon, plane menu bar glyph and dev Dock icon ([6ad649f](https://github.com/babariviere/pilot/commit/6ad649f0b95c8f0f76afb0216bb2a56facf11a02))
* **macos:** plane emerging from a shaded cloud in the app icon ([caabd47](https://github.com/babariviere/pilot/commit/caabd47fd74075e13b8fa59c1e85f55e56b388ea))
* **macos:** redraw app icon as a white plane with contrails ([5071ab6](https://github.com/babariviere/pilot/commit/5071ab64b64e174341f270e00294195f39698e70))
* **macos:** simplify app icon to a minimal plane silhouette ([46fb853](https://github.com/babariviere/pilot/commit/46fb85349a37a4c8e7836ba575f640a3d0d438b9))
* **macos:** sky gradient and clouds for the app icon ([f7c0d1a](https://github.com/babariviere/pilot/commit/f7c0d1a0797d9368b664b91fa2cd6b0e9ecfd049))
* **releases:** add stable versions, dev prereleases and DMG installers ([2ed3bbb](https://github.com/babariviere/pilot/commit/2ed3bbb252118f926bd02e3284c7a7eab4394566))
* run project sessions in private clones and forbid GitHub posting ([5537724](https://github.com/babariviere/pilot/commit/553772444a24c11f73921094038f78ae5a34485d))
* run terminals in pilotd and list pi-scoped models ([4549907](https://github.com/babariviere/pilot/commit/4549907b1aaa3c0b8cd99b5467f9de985a6c4473))
* **updates:** automate private macOS builds and app updates ([c9381e2](https://github.com/babariviere/pilot/commit/c9381e2bf54a3faf632f0a0c79a699b4c38aa55f))
* **updates:** automate private macOS builds and app updates ([b04fe45](https://github.com/babariviere/pilot/commit/b04fe45f0a797c11502f52476f91634647a81ff7))


### Bug Fixes

* **app:** render thought blocks as Markdown ([ae19031](https://github.com/babariviere/pilot/commit/ae1903166c31f0bdd1cbf58d2274595cfc09ecdf))
* **app:** render thought blocks as Markdown ([07a8ff4](https://github.com/babariviere/pilot/commit/07a8ff4bcfc0915ff5c3c9ad356d523a2f515b42))
* **app:** show branch name in session toolbar ([444e8b1](https://github.com/babariviere/pilot/commit/444e8b15735aa6789ca1379fd8802906a9f80840))
* **chat:** display queued messages above the composer ([cda27e5](https://github.com/babariviere/pilot/commit/cda27e556567d911cca4a2cfd9c973dd316f5529))
* **chat:** display queued messages above the composer ([8c89abc](https://github.com/babariviere/pilot/commit/8c89abc9a171262ccc5f40cbac806a541f9711d8))
* **chat:** display steering before queued follow-ups ([1d46c02](https://github.com/babariviere/pilot/commit/1d46c02549f83ee6b5fb8aae9d42a1676610d7a7))
* **ci:** correct lipo runtime verification argument order ([583bcf1](https://github.com/babariviere/pilot/commit/583bcf12e41654db2e0cfde11502303338e2ef8a))
* **ci:** look up draft release assets by numeric release ID ([48c5b64](https://github.com/babariviere/pilot/commit/48c5b649115c50749c25ae8e642d2e99d9df4dae))
* **daemon:** normalize diff prefixes for code review ([35cae4d](https://github.com/babariviere/pilot/commit/35cae4dbf26ebf37c0c0a10a3c9f6b6b3d9bc821))
* **daemon:** show code diffs with custom Git prefixes ([62ba361](https://github.com/babariviere/pilot/commit/62ba361a2c7334e933e3cdac9a1ef4674f499c25))
* **workspaces:** copy ignored mise local configuration ([a614223](https://github.com/babariviere/pilot/commit/a6142237bf6ca9852e6a9637afd9c97aee0d3e58))
* **workspaces:** copy ignored mise local configuration ([f558c40](https://github.com/babariviere/pilot/commit/f558c4025ed783766a02e6ab45cac979c6ef88d2))


### Performance Improvements

* make task startup and conversation loading non-blocking ([1b0fe00](https://github.com/babariviere/pilot/commit/1b0fe009c02116cae4ad6f69145a4d9a59044269))
* make task startup and conversation loading non-blocking ([74d6a57](https://github.com/babariviere/pilot/commit/74d6a572544d30bb57363bf0b493d22c43947663))
