# Changelog

## [1.35.1](https://github.com/babariviere/pilot/compare/v1.35.0...v1.35.1) (2026-10-15)


### Bug Fixes

* **macos:** read guardian replies without waiting for EOF ([3b181f9](https://github.com/babariviere/pilot/commit/3b181f9d13d1b007e3eee2e8eab99d052073f601))
* **memory:** ensure oversized summaries make compaction progress ([a02c0e0](https://github.com/babariviere/pilot/commit/a02c0e08ba970cd4e123ebb0617175d12d060f04))

## [1.35.0](https://github.com/babariviere/pilot/compare/v1.34.0...v1.35.0) (2026-10-15)


### Features

* **macos:** new app icon and menu bar glyph ([40492bb](https://github.com/babariviere/pilot/commit/40492bbde197549e938dec77ba9dd4a2a0e39351))
* **macos:** share page headers, sheets, pane headers, empty states and inline problems ([65cf640](https://github.com/babariviere/pilot/commit/65cf6405ca4e847306aadaad18ed999b62a9234e))
* **macos:** show automatic messages as one-line events and tray rows as single lines ([16dc9ed](https://github.com/babariviere/pilot/commit/16dc9edd042a9e23856afbef3620218ef1fd5415))
* **macos:** simplify the menu bar plane and drop its working state ([9c22164](https://github.com/babariviere/pilot/commit/9c221642fe10e9e6b69bdbfa8d003c73a996d355))


### Bug Fixes

* **daemon:** bound concurrent worker startups ([cc83f1b](https://github.com/babariviere/pilot/commit/cc83f1bb833290810a96b921fc44023d861aef3e))
* **daemon:** leave absent migration metadata untouched ([7c7288b](https://github.com/babariviere/pilot/commit/7c7288b1491ed4fb19c4921d8cb6d6c3a5300a58))
* **daemon:** refresh idle workspaces only before new input ([88f717f](https://github.com/babariviere/pilot/commit/88f717fb2b611b1caaf49b625021597a44babdbc))
* **kernel:** avoid coordinator policy false positives in prose ([87ae28e](https://github.com/babariviere/pilot/commit/87ae28ec93190e0c536003f359aaa515670477df))

## [1.34.0](https://github.com/babariviere/pilot/compare/v1.33.0...v1.34.0) (2026-10-15)


### Features

* **changes:** attach pull requests by number ([854c9bd](https://github.com/babariviere/pilot/commit/854c9bd64e7b074e965abe3c9bec2a32cb3183ee))
* **inbox:** global Inbox with Ready to merge and a project filter ([47219c5](https://github.com/babariviere/pilot/commit/47219c5292392f6674ea18c954f91dcf87aebcde))
* **jobs:** show running jobs in the chat working line, with Stop per job ([be77bf2](https://github.com/babariviere/pilot/commit/be77bf261c5c2e9ae670991b2126d92974f4d87c))
* **jobs:** surface hour-long jobs as user attention ([b2c2a47](https://github.com/babariviere/pilot/commit/b2c2a472dbbc2c9a81dd464bbb6149cb7d192646))
* **macos:** fold each turn's work into one line, with calmer bubbles and scheduled messages in place ([70c798e](https://github.com/babariviere/pilot/commit/70c798e2e8cef0d808fc36184210c594821a5e62))
* **macos:** group focused sidebar chats by urgency with Ready to merge ([5d5dab7](https://github.com/babariviere/pilot/commit/5d5dab74d8554267c2428ac079fbb8988da54ab4))
* **macos:** group the Tasks tab by phase ([f595c78](https://github.com/babariviere/pilot/commit/f595c78a3a71a3bc44697247e25f4de02d1c54cf))
* **macos:** recede row corners on hover and fade row second lines ([4261e8a](https://github.com/babariviere/pilot/commit/4261e8ae2de7f636917e4084397d5a8044ec4d59))
* **macos:** redesign Home as a project status overview ([33715e5](https://github.com/babariviere/pilot/commit/33715e5a833446c818890c6a9b7c4540cde4483d))
* **macos:** show a keyboard focus ring on rows ([1ff408f](https://github.com/babariviere/pilot/commit/1ff408f5082defc0fa56e599cc5723b3bb41c4a0))
* **macos:** show subscription usage only when it matters ([0267d0d](https://github.com/babariviere/pilot/commit/0267d0d3887484ffd8821735349d0482726889c3))
* **overview:** lead the project page with Up next ([7caf1d5](https://github.com/babariviere/pilot/commit/7caf1d58e701996cb1084c9c6c24e4bbabd70ac0))
* **sidebar:** regroup read results when leaving the chat and add a Pinned group ([2ac670e](https://github.com/babariviere/pilot/commit/2ac670e5a48886f7a1ed7383bae582049bc0e759))
* **tasks:** start one chat on multiple ordered tasks ([2cc1ead](https://github.com/babariviere/pilot/commit/2cc1eadfbb104175e2a0f4b93697043b2e142ab6))
* **workspaces:** add shared read-only source roles ([bd92aa1](https://github.com/babariviere/pilot/commit/bd92aa1c05cdc03238e7dcbd594e8453d9d2733b))


### Bug Fixes

* **daemon:** defer member completion notices through job follow-up ([3029f3b](https://github.com/babariviere/pilot/commit/3029f3b4becf5f357f2f717a48408d08084ce6ee))
* **deps:** update dependency motion to v14.2.0 ([d063612](https://github.com/babariviere/pilot/commit/d063612edca57d512090e612399c6cf647ff54a4))
* disambiguate PR links in multi-task chats ([74b588f](https://github.com/babariviere/pilot/commit/74b588f3c512dd3e738387d6f4710353aacd3291))
* **jobs:** keep live attention hashable and cover badge counts ([d5dedbf](https://github.com/babariviere/pilot/commit/d5dedbf62e500a1568e13c7f9f164c5af0b7e06f))
* **jobs:** resolve live metadata when attention becomes due ([4cc44c1](https://github.com/babariviere/pilot/commit/4cc44c175b30880718844bbd96281867aafd44d7))
* **kernel:** tolerate starvation and resume interrupted runs ([3e4d77e](https://github.com/babariviere/pilot/commit/3e4d77e18ac6fc0a66e102f2b557191623bed6ea))
* **macos:** correct icon tokens after rebasing ([94281aa](https://github.com/babariviere/pilot/commit/94281aaa85700c1d92914ee691778b8f228e5a60))
* **macos:** use a compatible chat folder symbol ([757d2e0](https://github.com/babariviere/pilot/commit/757d2e0467cba335dbf2cdd72dc82f523a506a03))
* **memory:** retry invalid compaction summaries ([18d1b52](https://github.com/babariviere/pilot/commit/18d1b525aee09e98e0a4b71495a87066186621c5))
* **readers:** separate module readiness from snapshot delivery ([50f8893](https://github.com/babariviere/pilot/commit/50f8893c366d34524164a0df10b28a18a3d95daf))
* **session:** keep interrupted recovery behind idle guards ([3a8ed2b](https://github.com/babariviere/pilot/commit/3a8ed2bd089ba89462845187724ec13555f1f4dc))
* **tasks:** serialize concurrent chat starts ([45e0f4c](https://github.com/babariviere/pilot/commit/45e0f4c32acb7f7c0fe77e3a678328c98fc3fd7b))
* **titles:** synchronize planning chat names ([a12561b](https://github.com/babariviere/pilot/commit/a12561b2056a550fca33d07100ae081d9b2f8b3c))
* **workspaces:** harden source-role startup and scratch ([42d8f71](https://github.com/babariviere/pilot/commit/42d8f7197ba3d81935b733e67a1e87479acd659a))

## [1.33.0](https://github.com/babariviere/pilot/compare/v1.32.0...v1.33.0) (2026-10-14)


### Features

* **attention:** add shared reasons to Needs you rows ([bde5f0c](https://github.com/babariviere/pilot/commit/bde5f0c37e85bbde9d1ab0130f28779e45ae81d2))
* **chat:** render automatic updates as inline timeline events ([a00e043](https://github.com/babariviere/pilot/commit/a00e043958b814674327de40df482994c60f8c19))
* **macos:** put Home and Inbox above the project selector in the sidebar ([68484b9](https://github.com/babariviere/pilot/commit/68484b9b806b7f45403fec2733966f07cb3de5c1))
* **macos:** sidebar mission rows open their page, chat rows name mission and coordinator ([c45538c](https://github.com/babariviere/pilot/commit/c45538cc9532bf9183aff99232f67797d275f0b0))
* **power:** manage Mac sleep around durable agent work ([2adfdd5](https://github.com/babariviere/pilot/commit/2adfdd5dab4b8eed1418ec376dffc5df93204413))
* **updates:** pause agents at safe tool boundaries ([77f1994](https://github.com/babariviere/pilot/commit/77f1994626404dc1fd02c9cb0544448aa3b11bd1))


### Bug Fixes

* **chat:** simplify event byte accounting for Swift 6.2 ([eb0a48b](https://github.com/babariviere/pilot/commit/eb0a48b191bb4fff09de3e7b02d5cbbdbc36fd4d))
* **daemon:** reduce activity reads and timestamp diagnostics ([61d1fb7](https://github.com/babariviere/pilot/commit/61d1fb7ef4740d8a61b3efcd309b9aa49006dccb))
* **deps:** update dependency mermaid to v12.2.0 ([5c7debe](https://github.com/babariviere/pilot/commit/5c7debea53e8b628afd8ecee5e290945e33de0d8))
* **macos:** handle paused mission coordinators after rebase ([39820bf](https://github.com/babariviere/pilot/commit/39820bf93dc9976a2fb006a53436025e1226808c))
* **macos:** offer forget only on memory summaries, not single notes ([55f111d](https://github.com/babariviere/pilot/commit/55f111dc46c6670a959f147c5451b7b39550de27))
* **sessions:** count background jobs as working ([b7a8446](https://github.com/babariviere/pilot/commit/b7a8446251f63ede5b0bbcc639936283a4e79886))
* **sidebar:** open mission from chat row icon and keep hover marks legible on dither ([9b71dfb](https://github.com/babariviere/pilot/commit/9b71dfbd7ab1d1fc65edab2e4659d9eb045facfc))
* **workspaces:** refresh idle chats when main advances ([7fa19eb](https://github.com/babariviere/pilot/commit/7fa19ebc9a986c2196b68c7dbeabb645b7bd8fd0))

## [1.32.0](https://github.com/babariviere/pilot/compare/v1.31.0...v1.32.0) (2026-10-14)


### Features

* add targeted task detail and paged activity reads ([0cb82d3](https://github.com/babariviere/pilot/commit/0cb82d3e57e097deb2cc6d93d6507844eac8a289))
* **decisions:** number decisions and add user-approved proposals ([44a3cd8](https://github.com/babariviere/pilot/commit/44a3cd8280a4ad30f81e1c2f31a0f43f2bdc65b2))
* expose cached subscription windows in orchestration results ([1f4a0c9](https://github.com/babariviere/pilot/commit/1f4a0c91a2b2ca224275792e9c52921d6771e6ee))
* **inbox:** add a cross-project Inbox sidebar tab ([4e2dd0b](https://github.com/babariviere/pilot/commit/4e2dd0bf0d3f8dc5cad27a85435adac9845a203f))
* **inbox:** open Slack triage for each project from the Inbox ([af4dc2e](https://github.com/babariviere/pilot/commit/af4dc2e848c3de39b9713327c54c1c6987ae1176))
* **inbox:** show a dithered coast when the Inbox is empty ([4335a04](https://github.com/babariviere/pilot/commit/4335a0436e86a2fc03229d9d9302aa20f28d1d3b))
* **inbox:** show dithered status corners and a calm sky ([fa73aeb](https://github.com/babariviere/pilot/commit/fa73aeb0ebf58a6b3dcbef6ed4c503dbebffca71))
* **kernel:** bundle shared extensions and required Anthropic auth ([019daaf](https://github.com/babariviere/pilot/commit/019daafa1f026810c0eed0127f254bae3f5d640c))
* let agents ask the user a question with suggested answers ([886b832](https://github.com/babariviere/pilot/commit/886b832823934bfee3fea0271ff407e93c3a89ad))
* **macos:** add decision audience picker ([12a7a0f](https://github.com/babariviere/pilot/commit/12a7a0faa70a845c181fda750038a8b95ea2c55c))
* **macos:** enlarge the question tray dither corner ([ce3c605](https://github.com/babariviere/pilot/commit/ce3c605c550beb51131f24494d04fe2d6e33f200))
* **macos:** give agent questions the dithered needs-you state ([6444349](https://github.com/babariviere/pilot/commit/64443498ba15e0fc6955aad9c7f9c8e80b93dddd))
* **macos:** open Slack and Linear links in desktop apps ([3e2fa55](https://github.com/babariviere/pilot/commit/3e2fa5548f8b59a43b5a9d0d22391a84ef6b0665))
* **macos:** show replaced notes and emptied summaries in the memory browser ([8321246](https://github.com/babariviere/pilot/commit/8321246c3d40d1dbcdb50fa2a2c7be4ba528af5a))
* **memory:** let notes replace outdated ones and refuse duplicates ([9b4bdc7](https://github.com/babariviere/pilot/commit/9b4bdc77dade8750798fc04596f9fc8e92b7ec1f))
* show chats waiting on an agent question as needing you ([89187d4](https://github.com/babariviere/pilot/commit/89187d4290f2f56c5704a34179c32e832880ad45))
* show waiting system messages above the composer ([a59969e](https://github.com/babariviere/pilot/commit/a59969efdbd9ba55eee33fc586a7b174649b1ea4))
* **status:** flag unpublished chat results and expose member detail ([eb050c4](https://github.com/babariviere/pilot/commit/eb050c4f6aeb00b5ff4ee6ee1b2a5e10f3f87abc))
* **tracking:** quote the Slack message in the triage inspector ([e876cee](https://github.com/babariviere/pilot/commit/e876cee8dead3cf26ad61f1e96856206b1aead4f))


### Bug Fixes

* **chat:** hold system messages when stopping a run ([17d088b](https://github.com/babariviere/pilot/commit/17d088b2335813f8ace21494a91eed779f312122))
* **ci:** refresh restored extension pin after main lockfile update ([48edb56](https://github.com/babariviere/pilot/commit/48edb56bde063c6d177275fe0d9a32489b8fd233))
* **ci:** repair source assertions and verify every dependency PR ([a253374](https://github.com/babariviere/pilot/commit/a253374f86c52a4ba5e0003e922f4896985badc3))
* **ci:** restore compatible extensions and native lockfile updates ([a747b59](https://github.com/babariviere/pilot/commit/a747b59b5e676c7a75a61ae395e8e716456c93df))
* **daemon:** baseline historical pull request states ([461b6ac](https://github.com/babariviere/pilot/commit/461b6ac7edcc20a3d30281b02335cca76d988ae7))
* **daemon:** keep ignored paths from blocking workspace cleanup ([1874934](https://github.com/babariviere/pilot/commit/1874934bd3b6948bbd6bb73b67268e1be871cd53))
* **kernel:** reserve admission before serializing input ([f0d5c0b](https://github.com/babariviere/pilot/commit/f0d5c0b89845a1af73e64b5b0f771884775fe0c6))
* **kernel:** support durable jobs recovery with Pi 1.1 ([4aae50a](https://github.com/babariviere/pilot/commit/4aae50ad4552989aba0fa39456936ad7ea622692))
* **macos:** assign held-action failures to composer state ([2d4bc7e](https://github.com/babariviere/pilot/commit/2d4bc7eb74989ab64dc0b8bd43538e164e8ce89b))
* **macos:** keep viewed chats under Needs you until answered ([6758814](https://github.com/babariviere/pilot/commit/6758814bd41a150b9349dd68cb41340edcef9a40))
* **macos:** name Linear and Slack instead of "Tracked" in the UI ([8db9f19](https://github.com/babariviere/pilot/commit/8db9f195d53b5afa070c06ecd94996766c439cfb))
* **macos:** retain unsaved brief drafts across tab switches ([c49c56b](https://github.com/babariviere/pilot/commit/c49c56b7b5798f52f3c24f0a10246907109c3ed9))
* **macos:** split question byte count so CI type-checks it in time ([b2233a4](https://github.com/babariviere/pilot/commit/b2233a4c9b4660d2bdec1ac0d7aac8a3b817fff8))
* **sessions:** allow archiving terminal startup failures ([6cf5aa0](https://github.com/babariviere/pilot/commit/6cf5aa052c40a04266c6e09fc62ad2ccfc0e39d5))
* **sessions:** allow retrying failed worker startup ([87810ab](https://github.com/babariviere/pilot/commit/87810ab275d0717c1e239d701bdfc596e40c5f10))

## [1.31.0](https://github.com/babariviere/pilot/compare/v1.30.0...v1.31.0) (2026-10-14)


### Features

* **chat:** attribute GitHub writes to chat activity ([636253d](https://github.com/babariviere/pilot/commit/636253de5bca0c5ca7730695e376d4e4f7d92124))
* **kernel:** record bounded local request timings ([286160b](https://github.com/babariviere/pilot/commit/286160b41cc066de74ef2f16901ee24c7fe2dfcf))
* **macos:** add hover-only sidebar chat shortcut ([e969966](https://github.com/babariviere/pilot/commit/e9699666d18e82e874032d6df52c5c34ff6de898))
* **macos:** add Slack triage view and project labels ([dbdc7c2](https://github.com/babariviere/pilot/commit/dbdc7c272f1385a1d84b168b21353ac93d5c528b))
* **macos:** declutter sidebar with dithered status corners ([30e97a6](https://github.com/babariviere/pilot/commit/30e97a6870c19dfa64ee62b4d9686d9f521c2dfe))
* **macos:** list links mentioned in a chat in the inspector ([ffaa0f7](https://github.com/babariviere/pilot/commit/ffaa0f76a851f02aa721e3a7e0d97c9ead80bb3d))
* **macos:** polish Linear rows and show failed In progress moves ([498cbb2](https://github.com/babariviere/pilot/commit/498cbb2aa255f2436648156074b694ad38cb50a8))


### Bug Fixes

* **daemon:** queue durable PR transition notices ([727cecb](https://github.com/babariviere/pilot/commit/727cecbf0e58642ba307cef5656f7184f397b8f2))
* **jobs:** keep background work active until completion ([e68bba5](https://github.com/babariviere/pilot/commit/e68bba503e05ed260bcb522cb81b980fb93bdcec))
* **macos:** use shared compass mark on all role labels ([b986693](https://github.com/babariviere/pilot/commit/b986693b57236d6a6a9e5a4ccaed3732288b7f6c))
* **memory:** keep tools visible and guide lasting notes ([3e4fb88](https://github.com/babariviere/pilot/commit/3e4fb88702497563c708b8716b0bde504eed9ba7))

## [1.30.0](https://github.com/babariviere/pilot/compare/v1.29.0...v1.30.0) (2026-10-14)


### Features

* **chat:** add a compact running jobs command ([877e40b](https://github.com/babariviere/pilot/commit/877e40ba47a6563d292eb178c748d19672a12f0b))


### Bug Fixes

* **chats:** preserve redacted failure causes and steps ([47e7166](https://github.com/babariviere/pilot/commit/47e7166e586325c1864a99ebf04ca5d477742883))
* **kernel:** use codemode-only tools in Ask chats ([2391e0e](https://github.com/babariviere/pilot/commit/2391e0e7900e4effa733830ce7ac9f365a9fa434))
* **macos:** keep active sidebar chats unfolded ([d9a4549](https://github.com/babariviere/pilot/commit/d9a45491700b811c68dfeae873047b5f1a3f15f4))
* **macos:** reuse existing Helium pull request tabs ([bb3ca5f](https://github.com/babariviere/pilot/commit/bb3ca5ffccf0d2e701f2cd718c8d178849aa8324))

## [1.29.0](https://github.com/babariviere/pilot/compare/v1.28.1...v1.29.0) (2026-10-14)


### Features

* **daemon:** auto-rebase diverged stacked PRs ([7b9bd43](https://github.com/babariviere/pilot/commit/7b9bd432b7a868595c5d56f12bddeeecf9d7b421))
* **macos:** attach and detach pull requests from the Changes pane ([f6f2106](https://github.com/babariviere/pilot/commit/f6f2106d1e1de7911fefabf53ccec4a1af8b2bcc))
* **slack:** add project-local classification and triage state ([d0adf2b](https://github.com/babariviere/pilot/commit/d0adf2b44b83d7af791ccec7ce313d32ad747ea5))
* **tracking:** advance Linear state after confirmed starts ([4918c41](https://github.com/babariviere/pilot/commit/4918c411cab2be23250ba88c42938051e1755995))


### Bug Fixes

* **chats:** report follow-up delivery outcomes ([9777e54](https://github.com/babariviere/pilot/commit/9777e5468840131215709d87bb40be641aec88fd))
* **daemon:** expose PR owners and preserve reference links ([06c4701](https://github.com/babariviere/pilot/commit/06c4701c75915203c923e97c75a01a6fedec1b52))
* **daemon:** reclaim mixed build-output directories safely ([301a027](https://github.com/babariviere/pilot/commit/301a0278e17240314382f73d517fa5fea0d12a6b))
* **macos:** expose mission deletion in row menus ([9cc51b6](https://github.com/babariviere/pilot/commit/9cc51b63ba268ad81920230b399dc9ecb3ba709f))
* **schedules:** require sleep before a full wake ([cde48ca](https://github.com/babariviere/pilot/commit/cde48ca7ac959819588c375af3445984564643c4))
* **tasks:** allow releasing held claims ([b2531bd](https://github.com/babariviere/pilot/commit/b2531bde6a068b19f6c4ad9a652501c222e1106f))


### Performance Improvements

* **agents:** trim mission context and add decision audiences ([0a073fc](https://github.com/babariviere/pilot/commit/0a073fc0a20981baac630c8bcd1e6b893c1d4df3))

## [1.28.1](https://github.com/babariviere/pilot/compare/v1.28.0...v1.28.1) (2026-10-14)


### Bug Fixes

* **macos:** use shared message selection for native copy ([1266770](https://github.com/babariviere/pilot/commit/126677024e88ad88a894f2631aefac5f6e291c10))


### Performance Improvements

* **macos:** make mission tab switches fast ([a861054](https://github.com/babariviere/pilot/commit/a86105425f1bde10a7ea7f14286d225b165e6ba2))

## [1.28.0](https://github.com/babariviere/pilot/compare/v1.27.0...v1.28.0) (2026-10-14)


### Features

* **daemon:** support explicit pull request ownership ([b1117fe](https://github.com/babariviere/pilot/commit/b1117fe994fdc54276ea1eae8cf6bf0529c58cd8))
* **macos:** list attention agents and missions on Home ([3637252](https://github.com/babariviere/pilot/commit/3637252bc42e67ef6d10fbbdd83e5679cdefe2d7))
* rename chats from the context menu ([fe7c8a3](https://github.com/babariviere/pilot/commit/fe7c8a3322f7dd28c6d9181055d2749ba6a689bd))
* **schedules:** add Wi-Fi join and leave options to Send later ([5451ccc](https://github.com/babariviere/pilot/commit/5451ccc6af46a5bfe5f1692290b105256c8a9cb6))
* **tracking:** sign in to Linear and Slack from the app ([cdbd4b2](https://github.com/babariviere/pilot/commit/cdbd4b21fff2682bc27880254399736a91a8a7e2))


### Bug Fixes

* **daemon:** reclaim generated Ghostty workspaces safely ([d0e619e](https://github.com/babariviere/pilot/commit/d0e619e7ea4be3fd1852ce7105fdc4e13f88e18a))
* **macos:** keep Command-A in the focused composer ([4748f3b](https://github.com/babariviere/pilot/commit/4748f3be638e3fb33ad409d97253049ddfb67618))
* **macos:** keep the working indicator visible for the whole run ([bac8a0e](https://github.com/babariviere/pilot/commit/bac8a0ecdf10d8859bd9f0069f82630d02029c98))
* **macos:** make settings resizable and move it to a sidebar layout ([68b05a4](https://github.com/babariviere/pilot/commit/68b05a483cd1908dd63f25413f995de3ba255fee))
* preserve session activity and back off cleanup retries ([1cb9e1e](https://github.com/babariviere/pilot/commit/1cb9e1eba94355570d333ad49051ba87d37a6029))
* **tracking:** parse Linear estimate objects and Slack message metadata ([19164ca](https://github.com/babariviere/pilot/commit/19164ca64c6cc23b004048f2ba2e32d3863fdc06))

## [1.27.0](https://github.com/babariviere/pilot/compare/v1.26.0...v1.27.0) (2026-10-14)


### Features

* **schedules:** add Wi-Fi join and leave triggers ([3e026af](https://github.com/babariviere/pilot/commit/3e026afbed9be57fe691d0ceeba6f0a5b6431d44))


### Bug Fixes

* **ci:** quote closed PR cancel step command ([ce6c89c](https://github.com/babariviere/pilot/commit/ce6c89c1a7871d5aa851311de6e12accd5c0c801))
* **schedules:** activate helper for Location authorization ([74d99aa](https://github.com/babariviere/pilot/commit/74d99aaede11d0a6d239906389c3ed4dc7a0939e))

## [1.26.0](https://github.com/babariviere/pilot/compare/v1.25.2...v1.26.0) (2026-10-14)


### Features

* **macos:** add Send later and scheduled item lists ([a9c0cb3](https://github.com/babariviere/pilot/commit/a9c0cb359696cf55c628489037ef57d1f3b77ce1))
* **macos:** show time, copy and edit on message hover ([febff73](https://github.com/babariviere/pilot/commit/febff736378cc058607079100201bb8b82d44a16))
* **project-page:** add Current cycle and Tracked sections ([dc570ec](https://github.com/babariviere/pilot/commit/dc570ec38cb9c152620632c6c2acd77b040d93dd))
* **tracking:** add tracked items inbox, ticket actions and tracking pickers ([b878bd7](https://github.com/babariviere/pilot/commit/b878bd7d257bda496b2997d1f41ff79e968a5539))


### Bug Fixes

* **macos:** compact PR badges and use GitHub state icons ([1ef8889](https://github.com/babariviere/pilot/commit/1ef88894854a0f1f9914ee702106fc671e010494))
* **macos:** unify message selection highlight and stop streaming reflow ([76671c4](https://github.com/babariviere/pilot/commit/76671c4d35237e3d3beb5c06bfbe4859172082b4))
* **test:** disable git auto maintenance in test seeds ([f2648f5](https://github.com/babariviere/pilot/commit/f2648f50ebbc4e3581b386f7564107d205bf7d74))
* **tracking:** retain ticket links in scheduled chats and drafts ([50ed5b3](https://github.com/babariviere/pilot/commit/50ed5b3bd808c6f16dfe428578baee5493f3895a))


### Performance Improvements

* resumable chat streams, tail-first snapshots and dedicated terminal and subagent sockets ([e2cb72c](https://github.com/babariviere/pilot/commit/e2cb72c896dfb48b693fd043d188a0b8e53a59ab))
* stream each open chat on its own WebSocket ([1c6ed81](https://github.com/babariviere/pilot/commit/1c6ed81485bf1cea32884e4ea68cd51283f29c36))
* **test:** speed up offline feedback and full-suite execution ([a00a301](https://github.com/babariviere/pilot/commit/a00a301cb31a100afc98930ebb99811d67a7c900))

## [1.25.2](https://github.com/babariviere/pilot/compare/v1.25.1...v1.25.2) (2026-10-13)


### Bug Fixes

* **daemon:** remove assignments from expressions ([04b6337](https://github.com/babariviere/pilot/commit/04b63373245d6329340470efa15613ae81fde5d6))

## [1.25.1](https://github.com/babariviere/pilot/compare/v1.25.0...v1.25.1) (2026-10-13)


### Bug Fixes

* **daemon:** avoid blocking stop during startup ([d79ddf8](https://github.com/babariviere/pilot/commit/d79ddf805a3066fe44d063450e7e98b7fd0ffda3))
* **daemon:** drain queued abort before stop settles ([a72d31b](https://github.com/babariviere/pilot/commit/a72d31b93f4711ca71dd299f6c28bfd21ad8449b))
* report submodules before untracked-path cleanup errors and update edit button test ([f83009d](https://github.com/babariviere/pilot/commit/f83009d28c48a76d3eb4dc78a0dc8b69e9bc47a8))

## [1.25.0](https://github.com/babariviere/pilot/compare/v1.24.0...v1.25.0) (2026-10-13)


### Features

* **daemon:** detect wake and reachability for scheduled work ([75fb0ca](https://github.com/babariviere/pilot/commit/75fb0ca8d2f6396e58cf48eaea5b2ded9ae9d01f))
* **macos:** show pull request merge readiness ([b64fbbe](https://github.com/babariviere/pilot/commit/b64fbbed34d7634b5a4c2fe5f2b4053ce56f8c4d))
* **macos:** show task dependencies in the Tasks tab ([2b84035](https://github.com/babariviere/pilot/commit/2b84035d752e28dd5777fd1285f87a06b4ab79b4))
* **tracking:** classify Slack bug reports with cached Luna results ([006b45f](https://github.com/babariviere/pilot/commit/006b45f8cf140ebb0680006987c885b2952336f3))
* **tracking:** sync personal Linear cycles and ticket prefill ([2a88ba6](https://github.com/babariviere/pilot/commit/2a88ba6fb61c087b36be27a8a0ca96df9a266fd2))


### Bug Fixes

* **chat:** restore queued messages to the composer on stop ([5b78615](https://github.com/babariviere/pilot/commit/5b786159c8ae5ec87c1c90631f6c9b7edfb511f1))
* **ci:** keep native UI tests alive until completion ([8c2dc0a](https://github.com/babariviere/pilot/commit/8c2dc0af66dc848f07ec4a61f75752014a196ffd))
* **daemon:** detect Git submodules before workspace cleanup ([9eabaa5](https://github.com/babariviere/pilot/commit/9eabaa58e87cd2af551aabd5dbb9688746f76076))
* **daemon:** update stale workspaces before reclaiming them ([7225519](https://github.com/babariviere/pilot/commit/7225519250c8b5e965bfae6c1f763103b1f3af42))
* **macos:** align readiness groups with page rows ([402bba8](https://github.com/babariviere/pilot/commit/402bba88f5555dc5c480f31cc0ab6e5ce2061e56))
* **macos:** allow throwing folded-message test ([0cb2ba2](https://github.com/babariviere/pilot/commit/0cb2ba23fa137bae7b74f9480c2eb915ac8c4478))
* **macos:** bound timestamp hit tests to the content viewport ([0d8f372](https://github.com/babariviere/pilot/commit/0d8f372034f25e92ded4f8350e9410c1ca217295))
* **macos:** cap artifact viewer default width on ultrawide displays ([be6bdd8](https://github.com/babariviere/pilot/commit/be6bdd8e0d3d955aac69162a60660c3b59b5868c))
* **macos:** keep user message edit button in the margin ([4eb47dd](https://github.com/babariviere/pilot/commit/4eb47dd4b72193418a83c387dd43b86f333ada67))
* **macos:** label ready pull request badges ([b48d02d](https://github.com/babariviere/pilot/commit/b48d02dcd79773c609aa8b1cb6692a81523796ab))
* **macos:** let Return insert a newline in mission sheet text fields ([b27d49c](https://github.com/babariviere/pilot/commit/b27d49c452e3a5e86179fcf2242dec97773c4b13))
* **macos:** reject incomplete native test runners ([b3bb27b](https://github.com/babariviere/pilot/commit/b3bb27b6d64277e90b4cb3fadd74f8cf7e6b21c0))
* **test:** evaluate native hit-test probes before expectations ([bd0bd74](https://github.com/babariviere/pilot/commit/bd0bd74a7df28f231bf8929c7656111ce2639317))


### Performance Improvements

* **io:** reduce repository and streaming I/O amplification ([3966a3d](https://github.com/babariviere/pilot/commit/3966a3dc0966a281c44e4eb0f9ef01a0e37d3fc5))

## [1.24.0](https://github.com/babariviere/pilot/compare/v1.23.0...v1.24.0) (2026-10-13)


### Features

* **daemon:** add durable scheduled chat dispatch ([846fe01](https://github.com/babariviere/pilot/commit/846fe01e9a256d49a6e0b3c6f70d4aa391fa858c))
* **daemon:** add tracked items and source framework ([44224c2](https://github.com/babariviere/pilot/commit/44224c293c25afb20d271bfe9ebb81ee4a03a689))
* **daemon:** expose cached PR merge readiness ([df9df31](https://github.com/babariviere/pilot/commit/df9df31219712bc517e7625a51308d8a75cc1da1))
* **macos:** add a hover pencil for message editing ([70f8e18](https://github.com/babariviere/pilot/commit/70f8e18e2e268942aa1b24c2dacfda17ddb5826a))
* **macos:** browse project memory ([914b66f](https://github.com/babariviere/pilot/commit/914b66ffcc67c5853031b4cb4b03eb3776b63427))
* **macos:** group overview links by provider ([875f6f6](https://github.com/babariviere/pilot/commit/875f6f62a8611d349ddbb7bff19f563082b34ec4))
* **macos:** open full project dashboard lists ([2dc3326](https://github.com/babariviere/pilot/commit/2dc33262892223495fb36aade3a2c826b464f033))
* **macos:** show idle chats with open or no PR on home ([45f7d4b](https://github.com/babariviere/pilot/commit/45f7d4b9c3bd93fe48fef4edcd66fad18002f07a))


### Bug Fixes

* **daemon:** await MCP shutdown before completing calls ([4fc9554](https://github.com/babariviere/pilot/commit/4fc95543444bafc0c6dec78078ec0ec4ec1eaeb9))
* **macos:** allow selecting complete agent messages ([8cf3dec](https://github.com/babariviere/pilot/commit/8cf3decf9af37cabbda3b25e2e355d87cfbc7d65))
* **macos:** capture the full artifact in screenshots ([e1e1e66](https://github.com/babariviere/pilot/commit/e1e1e669ea19c039bd7807755ad9e75e43221a5c))
* **macos:** put the message pencil in the right margin ([d3627a7](https://github.com/babariviere/pilot/commit/d3627a71493c9f75413c529c67b2a723ffd59609))
* **macos:** sync reviewed chat outcomes with daemon ([a548f36](https://github.com/babariviere/pilot/commit/a548f36291bb1c02489a597ae8b5f4c0c31588b8))
* **tracking:** require dedicated MCP servers ([7969d15](https://github.com/babariviere/pilot/commit/7969d15ce96a725f8209caf5cc413287d373a8d8))

## [1.23.0](https://github.com/babariviere/pilot/compare/v1.22.0...v1.23.0) (2026-10-13)


### Features

* **daemon:** add durable project memory ([7dbf550](https://github.com/babariviere/pilot/commit/7dbf5506a6f82bd85edcc1aef8787531b6e035eb))
* **kernel:** add project memory tools and wake context ([2f2384f](https://github.com/babariviere/pilot/commit/2f2384f0ebb5e46256a2a3d3370ee22e95c571e7))


### Bug Fixes

* **daemon:** flag stacked PRs that diverged from their base ([eea319e](https://github.com/babariviere/pilot/commit/eea319e393363f03f133ee3ada79a459d940b286))

## [1.22.0](https://github.com/babariviere/pilot/compare/v1.21.0...v1.22.0) (2026-10-13)


### Features

* **macos:** show GitHub, Linear and Slack marks for links ([4a641b8](https://github.com/babariviere/pilot/commit/4a641b8b658c4a327187aaa89561a4041832235b))
* **macos:** sidebar scope switcher, Home row and project focus ([f47cce5](https://github.com/babariviere/pilot/commit/f47cce5ce87922de0c54291d8cfe50385380f232))

## [1.21.0](https://github.com/babariviere/pilot/compare/v1.20.0...v1.21.0) (2026-10-13)


### Features

* **daemon:** project dashboard aggregate endpoint ([32e99c7](https://github.com/babariviere/pilot/commit/32e99c738732907edd07a7fd98c8d36d64c6a7e2))
* **macos:** project page ([59b39cb](https://github.com/babariviere/pilot/commit/59b39cbac24d63b6299dc4056813a82af5f034c7))

## [1.20.0](https://github.com/babariviere/pilot/compare/v1.19.0...v1.20.0) (2026-10-13)


### Features

* **macos:** redesign mission pages as calm status views ([2c87f20](https://github.com/babariviere/pilot/commit/2c87f20ed226e966e0a4fc1200557dafe1ce036b))


### Bug Fixes

* **workspaces:** handle trial warnings and rollback writes ([6e3c05c](https://github.com/babariviere/pilot/commit/6e3c05cf0f3ecb1d63366d543933e45ee3be1580))
* **workspaces:** refresh bases safely between turns ([cf1ed3f](https://github.com/babariviere/pilot/commit/cf1ed3f94e58f599d34c9ca59321bdd8f0fac96d))

## [1.19.0](https://github.com/babariviere/pilot/compare/v1.18.0...v1.19.0) (2026-10-13)


### Features

* **artifacts:** read authorized linked cross-chat sources ([279dc00](https://github.com/babariviere/pilot/commit/279dc0043ac83c6b8ae7bee4b7908b97be2462a0))
* **chats:** start a planning chat from creation forms ([d290f27](https://github.com/babariviere/pilot/commit/d290f27247983198fa220b283b15d75db89ce003))


### Bug Fixes

* bound test concurrency by default ([7bf464c](https://github.com/babariviere/pilot/commit/7bf464c54ad73d58092b21809059a854854cb27f))
* **daemon:** omit self-originated and stale settle updates ([bb4afcf](https://github.com/babariviere/pilot/commit/bb4afcfc6f36fe14b48179fb0c1d95e82d104043))
* **macos:** reject failed native test target summaries ([9906c1e](https://github.com/babariviere/pilot/commit/9906c1ea80829e1eda7bed7be606774f36215865))
* **macos:** support explicit test jobs on Bash 3.2 ([6013c13](https://github.com/babariviere/pilot/commit/6013c13280a75dd02993510c3dc8786141330a1b))
* **models:** preserve scope when settings reads contend ([63c771e](https://github.com/babariviere/pilot/commit/63c771e4d1680392afc5dce85df27eef730dc07b))

## [1.18.0](https://github.com/babariviere/pilot/compare/v1.17.0...v1.18.0) (2026-10-12)


### Features

* **macos:** fade inline artifacts clipped at the height limit ([da3d062](https://github.com/babariviere/pilot/commit/da3d062b6a200f0d898e19af308f16db59f82124))


### Bug Fixes

* **macos:** stop live-scroll anchor compensation from re-entering ([af6d8c1](https://github.com/babariviere/pilot/commit/af6d8c18b8ca83078924f97a05f3c8cd9b89d389))

## [1.17.0](https://github.com/babariviere/pilot/compare/v1.16.0...v1.17.0) (2026-10-12)


### Features

* **daemon:** keep chats with unpublished changes active ([93cc1d7](https://github.com/babariviere/pilot/commit/93cc1d73aca9ad734567160a36548b55e8cc85a7))
* retry, edit and restore chats into conversation attempts ([d7646ee](https://github.com/babariviere/pilot/commit/d7646eed6365805f5d0e7be076e9beb8aa9fc6a4))


### Bug Fixes

* **artifacts:** fit previews to content at Retina resolution ([0415157](https://github.com/babariviere/pilot/commit/0415157f87efb60e2516f4f8c88264eb4002cbcf))
* **daemon:** keep PR branch when only the base bookmark remains ([9edf617](https://github.com/babariviere/pilot/commit/9edf6176a3ec06e9a32cbee531b9223064bc6ba9))
* **kernel:** detach compaction snapshots before IPC ([8a02714](https://github.com/babariviere/pilot/commit/8a02714ef22f65c5db67d1a61e2081fce254ce70))
* **macos:** remove queued messages when submitting empty edits ([9ed3939](https://github.com/babariviere/pilot/commit/9ed3939bc7069796e4dff3654a9fadab2065b068))
* **macos:** split attempt expressions that time out the Swift type checker ([3c4867d](https://github.com/babariviere/pilot/commit/3c4867db222b58ec281067afb0758ffb0b9e146e))
* **macos:** stabilize scroll anchoring and Xcode SwiftUI previews ([c6ef015](https://github.com/babariviere/pilot/commit/c6ef0156779c1df372869c09e74b1f5c0f6e0ebd))


### Performance Improvements

* **macos:** stop redrawing the transcript on every scroll frame ([80b184d](https://github.com/babariviere/pilot/commit/80b184d5b86bcf56274429e89c1f6f837664fe9c))

## [1.16.0](https://github.com/babariviere/pilot/compare/v1.15.0...v1.16.0) (2026-10-12)


### Features

* **chats:** persist reference materials across starts ([dcc8f53](https://github.com/babariviere/pilot/commit/dcc8f53fe28e21765c1fadbac67f152bb4e0e801))
* **daemon:** gate grouped notices on aggregate idle state ([8f14363](https://github.com/babariviere/pilot/commit/8f14363fee4419b82f703ab0c942ce0ca887f143))
* **macos:** add scoped archive filters ([8c04b82](https://github.com/babariviere/pilot/commit/8c04b82a5e89c44e36dc0fb8f6ad4aaeef09419e))


### Bug Fixes

* **chats:** reject starts under inactive goals ([c3f3412](https://github.com/babariviere/pilot/commit/c3f34120fb0a1042ff7e3d63a4098c115853f058))
* **daemon:** stabilize task reference ordering ([1765e24](https://github.com/babariviere/pilot/commit/1765e24baec6008af86c107ce7c192843943077a))
* **daemon:** suppress repeated event notice states ([2ee03ed](https://github.com/babariviere/pilot/commit/2ee03edc08ff959a8bdcde61ad39fd128c3fa316))
* keep automatic input out of the queue and label it in the transcript ([13d507c](https://github.com/babariviere/pilot/commit/13d507c9b916676e1994f511affece5b17bb8cd0))
* **kernel:** group job notices after Harness settlement ([1c1dd19](https://github.com/babariviere/pilot/commit/1c1dd1988f899d8e89b9a340d3ba4837210b4992))
* **macos:** auto-dismiss queued message removal warnings ([88882d2](https://github.com/babariviere/pilot/commit/88882d206dc9e2777a26c94e2e96eb0749e4aec1))
* **macos:** prevent model picker flicker when switching chats ([2daebc7](https://github.com/babariviere/pilot/commit/2daebc76f28fa4468d56fe2cc9a0e1564b803e06))
* **macos:** skip animations when restoring a chat's state ([1df7eb6](https://github.com/babariviere/pilot/commit/1df7eb63dd624525480f9f76f70546e10999288d))
* **workspaces:** isolate base imports from shared agent refs ([dfc044b](https://github.com/babariviere/pilot/commit/dfc044befe4a70605a1480950ec460854cbf6ea9))

## [1.15.0](https://github.com/babariviere/pilot/compare/v1.14.0...v1.15.0) (2026-10-12)


### Features

* compact idle lead chats before their next wake-up ([3c6c2fa](https://github.com/babariviere/pilot/commit/3c6c2fa43a8a1ff0a4bc90e1a585fe8e264f37b6))
* **daemon:** prune archived legacy clones and tell agents about workspace resets ([066db87](https://github.com/babariviere/pilot/commit/066db87e6a8ac51b8837cce56d50bb5230cc5d1e))
* **kernel:** allow the user's web tool in Ask sessions ([bf993de](https://github.com/babariviere/pilot/commit/bf993de8afbfa5cb5b0b94853f8c5c7854b26a52))
* show chat history from before compaction ([ff80929](https://github.com/babariviere/pilot/commit/ff80929ff560e68a0c2dd17bad9096fa232a8682))


### Bug Fixes

* center artifacts in chat cards and documents ([332c032](https://github.com/babariviere/pilot/commit/332c032f0d30807fb19d85cf64e5c990daaa0fe0))

## [1.14.0](https://github.com/babariviere/pilot/compare/v1.13.0...v1.14.0) (2026-10-12)


### Features

* **macos:** fold long project chat lists in the sidebar ([b89355f](https://github.com/babariviere/pilot/commit/b89355f9e2beefcf23a4df3c4c35ff09c2b5116e))

## [1.13.0](https://github.com/babariviere/pilot/compare/v1.12.2...v1.13.0) (2026-10-12)


### Features

* add task deletion, ordering and bulk grouping ([609c6d2](https://github.com/babariviere/pilot/commit/609c6d255e25dc3600a0fd67ee5bc66b9b387cf3))
* **chat:** add slash commands for compact, prompts and skills ([14b593d](https://github.com/babariviere/pilot/commit/14b593d5197f134157729a42aaf1514af010e473))
* **daemon:** validate chat start model and thinking choices ([71fa8c2](https://github.com/babariviere/pilot/commit/71fa8c2b5f135df3b61a1eff4744224838269b73))
* track pull request stack positions ([20aadd3](https://github.com/babariviere/pilot/commit/20aadd344d9092d884f04732a555366f183cd655))


### Bug Fixes

* **daemon:** preserve user activity notes in agent context ([d4dd5b6](https://github.com/babariviere/pilot/commit/d4dd5b6f3f3d88184b8f7d896764308cf3a6a22d))
* **daemon:** recover from kernel IPC failures without crashing or looping ([0da0884](https://github.com/babariviere/pilot/commit/0da08846a7e4ef4306311b2f59330a16346a5b95))
* **macos:** align composer controls row ([7326107](https://github.com/babariviere/pilot/commit/7326107a80ff1d93527764a620b55386a656f240))


### Performance Improvements

* cache the model catalog across folders and in the app ([259b677](https://github.com/babariviere/pilot/commit/259b677a38213a62af366114fc7986819e3b88d0))
* **daemon:** spawn git, jj and gh off the event loop ([cc79b75](https://github.com/babariviere/pilot/commit/cc79b7548643b65b7adc5aed2ac49efa4e16cd6f))
* **kernel:** run workers at normal scheduling priority ([5a31f1f](https://github.com/babariviere/pilot/commit/5a31f1fe111e840eb663879ffed8c8b3e455bcc2))

## [1.12.2](https://github.com/babariviere/pilot/compare/v1.12.1...v1.12.2) (2026-10-11)


### Performance Improvements

* **sidebar:** use summary-backed attention counts ([bc3c6a0](https://github.com/babariviere/pilot/commit/bc3c6a058a20d633634b826ee79af379c5c48687))

## [1.12.1](https://github.com/babariviere/pilot/compare/v1.12.0...v1.12.1) (2026-10-11)


### Bug Fixes

* **daemon:** give each PR one owner, claimed by the first session to discover it ([627893e](https://github.com/babariviere/pilot/commit/627893eba34a74246a59db7e8be25f7d0d26e3a7))
* **kernel:** record PR ownership for inert body substitutions ([8e434fd](https://github.com/babariviere/pilot/commit/8e434fd6eabc57c449b45527dae2c39dc45380d7))

## [1.12.0](https://github.com/babariviere/pilot/compare/v1.11.1...v1.12.0) (2026-10-11)


### Features

* **daemon:** deliver durable batched event notices ([33e9710](https://github.com/babariviere/pilot/commit/33e9710f237c8cd13c312ea6aea398c2891f4d74))
* **daemon:** support multi-task claims and task sequencing ([b7e313f](https://github.com/babariviere/pilot/commit/b7e313fc62b092a74892ca9ec5f4a2fdfb10b8c9))


### Bug Fixes

* **chats:** preserve active roles after PR merges ([a647321](https://github.com/babariviere/pilot/commit/a647321570a00e22abac04abc497d8630090529e))
* **daemon:** diff sessions against their current base branch ([703131c](https://github.com/babariviere/pilot/commit/703131c0c964d4d16cf1692499aa6d19ac5175b7))
* **kernel:** return structured tool results in codemode ([63eb287](https://github.com/babariviere/pilot/commit/63eb287a19852ab285f1fa72f7729f7daecb2f9a))

## [1.11.1](https://github.com/babariviere/pilot/compare/v1.11.0...v1.11.1) (2026-10-09)


### Bug Fixes

* **macos:** anchor transcript scroll when artifacts resize ([c3fecbe](https://github.com/babariviere/pilot/commit/c3fecbe90bc8bcebc83f1b6113297fdaae75dd71))

## [1.11.0](https://github.com/babariviere/pilot/compare/v1.10.2...v1.11.0) (2026-10-09)


### Features

* **macos:** compact queued message strip with steer and follow-up edits ([46beb36](https://github.com/babariviere/pilot/commit/46beb36e19ee5cfa4eeac46d05c1ce605907ebbd))


### Bug Fixes

* **macos:** fit inline image artifacts to their content ([160be54](https://github.com/babariviere/pilot/commit/160be54a01d1c9078e4ec1f23bf1c5cb736bb850))
* **macos:** unify composer pickers and remove UI noise ([37bd280](https://github.com/babariviere/pilot/commit/37bd2805041527b3346b5eefa223ce22abfe2a8c))


### Performance Improvements

* **daemon:** cache workspace inspection, look up known PRs by number, react to ref changes ([d67fa90](https://github.com/babariviere/pilot/commit/d67fa900f5ffa59b4dc0217afcab0ebba1c5143b))
* **daemon:** schedule GitHub PR sync with batched GraphQL lookups ([df3fa42](https://github.com/babariviere/pilot/commit/df3fa425f2f11cd5d87556aa6b8a38ea34cad67b))

## [1.10.2](https://github.com/babariviere/pilot/compare/v1.10.1...v1.10.2) (2026-10-09)


### Bug Fixes

* **macos:** prioritize lead chats in grouped sidebar ([7b411f5](https://github.com/babariviere/pilot/commit/7b411f5366ed849c7ce17184f9bdfa49cea6e71a))

## [1.10.1](https://github.com/babariviere/pilot/compare/v1.10.0...v1.10.1) (2026-10-09)


### Bug Fixes

* **ci:** follow up all agent-owned PR stack heads ([024f941](https://github.com/babariviere/pilot/commit/024f9419d0d43559bcaf74a2bcdec8901d7823cf))

## [1.10.0](https://github.com/babariviere/pilot/compare/v1.9.0...v1.10.0) (2026-10-09)


### Features

* **macos:** reveal message timestamps on click ([6bd8e3d](https://github.com/babariviere/pilot/commit/6bd8e3db905bfa3efcd8d7545b4caf9d52847982))

## [1.9.0](https://github.com/babariviere/pilot/compare/v1.8.0...v1.9.0) (2026-10-09)


### Features

* **tools:** add role-gated chat control actions ([c763f88](https://github.com/babariviere/pilot/commit/c763f88db5b780aed9513974ebe47ab18cfffa51))


### Bug Fixes

* **kernel:** check only executable policy arguments ([b1bcd3d](https://github.com/babariviere/pilot/commit/b1bcd3dc5a2719279c8f43c69b045f7825c0b2ff))
* **kernel:** restrict unsafe stack commands ([8809613](https://github.com/babariviere/pilot/commit/8809613cd315a15de0500ef05fa7587f1b5836fd))
* **macos:** prevent blank transcripts on session opening ([2745395](https://github.com/babariviere/pilot/commit/2745395bff9a00d7d2ef6b25c69fe68a44db00f1))
* **tools:** tailor declarations to the current role ([b94a503](https://github.com/babariviere/pilot/commit/b94a5032e1060b64ee57bc600b6604e826771106))

## [1.8.0](https://github.com/babariviere/pilot/compare/v1.7.1...v1.8.0) (2026-10-09)


### Features

* **changes:** list every session branch with its pull request ([354e42e](https://github.com/babariviere/pilot/commit/354e42e14f3a96c2bdcd2ff71aad5866ab4ca18b))
* **chat:** open dedicated chats with locked project context ([7bc88c8](https://github.com/babariviere/pilot/commit/7bc88c833456c6eae4786c4d8832572559a40144))
* **macos:** redesign the Changes pane branch list ([1d9d8ed](https://github.com/babariviere/pilot/commit/1d9d8ed9561b944e5bded2e96ac7cae8aa092002))
* **tasks:** attach resource links and newly opened pull requests ([a452f55](https://github.com/babariviere/pilot/commit/a452f5596b345d435ffe43258cab3015f0d35ffd))
* **tasks:** follow linked pull request review and merge states ([0bd7076](https://github.com/babariviere/pilot/commit/0bd7076f2cabc6b92226ae01a5620ff0ff02a340))
* **ui:** allow expanding task descriptions ([7772446](https://github.com/babariviere/pilot/commit/777244687fc6f43eb52ec79851e7a61be0148b54))


### Bug Fixes

* **macos:** label build workspaces as isolated workspaces ([6f02036](https://github.com/babariviere/pilot/commit/6f02036879d576299cf6fa85a14738426bf63427))


### Performance Improvements

* **artifacts:** speed up rendering and harden storage ([a07f8d7](https://github.com/babariviere/pilot/commit/a07f8d7451e15106549462007fb0ef1d512e60fe))

## [1.7.1](https://github.com/babariviere/pilot/compare/v1.7.0...v1.7.1) (2026-10-09)


### Bug Fixes

* **macos:** clarify mission task owners and coordinator ([b281e36](https://github.com/babariviere/pilot/commit/b281e3629bc088aefa7eef04a3ffa3e82912d669))

## [1.7.0](https://github.com/babariviere/pilot/compare/v1.6.2...v1.7.0) (2026-10-09)


### Features

* add missions to share a brief, tasks and artifacts across chats ([52b3aae](https://github.com/babariviere/pilot/commit/52b3aae30145eb605f216ef01ba7b38946453db0))

## [1.6.2](https://github.com/babariviere/pilot/compare/v1.6.1...v1.6.2) (2026-10-09)


### Bug Fixes

* **artifacts:** center Mermaid diagrams in previews ([9c09870](https://github.com/babariviere/pilot/commit/9c098701a6aedf10be16e0b2674fda64ea2300fd))
* **daemon:** preserve outcomes when parking idle sessions ([1db5f26](https://github.com/babariviere/pilot/commit/1db5f2640b0b2b47c6246eb9e13605f19f643183))
* **kernel:** bundle artifact authoring skill and namespace ([44762a0](https://github.com/babariviere/pilot/commit/44762a02e2d19f0e0be3a15bd78e68351196ee91))
* **kernel:** keep artifact discovery visible after resume ([efbbc27](https://github.com/babariviere/pilot/commit/efbbc270d7ce9a6b4519ce8248aa8ad883090592))
* **macos:** keep the subagent footer readable while scrolling ([6e76854](https://github.com/babariviere/pilot/commit/6e768549c1670fc148c9955d5a610c93654b2185))
* **macos:** use native inspector toolbar toggles ([62daf3b](https://github.com/babariviere/pilot/commit/62daf3babc6e7f6f123d0703adebf6c0cdc853cf))

## [1.6.1](https://github.com/babariviere/pilot/compare/v1.6.0...v1.6.1) (2026-10-09)


### Bug Fixes

* **macos:** keep transcript rows stable while scrolling ([1e6c48b](https://github.com/babariviere/pilot/commit/1e6c48b3f896d4c91517bf5fd0818459e3a0cf3e))
* **macos:** move repository context into Changes ([9737453](https://github.com/babariviere/pilot/commit/97374533a4b026a13ddd6beb400045243a556b62))
* **macos:** put composer controls on an opaque tray ([3261fd0](https://github.com/babariviere/pilot/commit/3261fd0abfb43dcd68dcc1d9195d9d2740222137))
* **macos:** simplify session toolbar and space its buttons ([ebbc2a1](https://github.com/babariviere/pilot/commit/ebbc2a16136664f8058a05d21ecee87bd9e52450))
* **queue:** hide background job notifications from composer ([8f18c67](https://github.com/babariviere/pilot/commit/8f18c67533fb8486731a061235c8095dc18c10e7))
* **terminal:** Focus the shell when opening the terminal ([66d411f](https://github.com/babariviere/pilot/commit/66d411f09ebf4ccdd434941280e6237dc16e24b6))

## [1.6.0](https://github.com/babariviere/pilot/compare/v1.5.0...v1.6.0) (2026-10-08)


### Features

* **sessions:** add persistent session pinning ([de59430](https://github.com/babariviere/pilot/commit/de59430743c7d86b5b116949806bd44097ad262a))


### Bug Fixes

* **lint:** clear daemon lint and Biome deprecation ([51c39e1](https://github.com/babariviere/pilot/commit/51c39e19648d3b631b87faf2a945fece472a5960))
* **macos:** fold long chat messages with a soft fade ([c8a96c8](https://github.com/babariviere/pilot/commit/c8a96c8be4c1f601fb69fc75621ff741f498a87c))

## [1.5.0](https://github.com/babariviere/pilot/compare/v1.4.0...v1.5.0) (2026-10-08)


### Features

* **daemon:** follow up on agent-created PR problems ([cb48e04](https://github.com/babariviere/pilot/commit/cb48e04c7aba9084b40d1092e3da228fe5c237e6))
* link multiple pull requests to a session ([6cf0d9d](https://github.com/babariviere/pilot/commit/6cf0d9dbfd2ceb21d423300161a125b5848daaca))
* show and control subagents in the app ([7c4b77a](https://github.com/babariviere/pilot/commit/7c4b77a6ceb101a8a83ddbbfb67d5831b2ea02ce))
* **workspaces:** share jj storage and reclaim archived checkouts ([5bc67fe](https://github.com/babariviere/pilot/commit/5bc67fe0c8a16a402d71b144846d28448d5f463a))


### Bug Fixes

* **daemon:** stop polling merged and closed PRs ([6686f4f](https://github.com/babariviere/pilot/commit/6686f4f89f57464f32ed883eb8a509cd0e18ce2c))
* **macos:** give inline artifacts more room ([8f1d723](https://github.com/babariviere/pilot/commit/8f1d723afdf33d1fb0189a2b333faf057d6e0019))
* **macos:** move workspace context into the session toolbar ([bed2739](https://github.com/babariviere/pilot/commit/bed27393c0a4b6a50bf31f4bf12bb5a81977bfbe))
* **macos:** separate branch context from session toolbar actions ([cd158b6](https://github.com/babariviere/pilot/commit/cd158b60c03e520ead23ef1ecb5166ee363b47f1))
* **macos:** simplify transcript byte-count type checking ([cca963a](https://github.com/babariviere/pilot/commit/cca963aec6bf36f18348a5345a4baef5ef0445c5))
* **macos:** stabilize menu-bar updates to mitigate recursion ([e011eb7](https://github.com/babariviere/pilot/commit/e011eb7a8c6250b2f38db18df4558fa2b8d49559))


### Performance Improvements

* stream subagent transcripts instead of polling ([59a516d](https://github.com/babariviere/pilot/commit/59a516d647ed8a9843b77ed8ec8b8f4571ae2e0d))

## [1.4.0](https://github.com/babariviere/pilot/compare/v1.3.0...v1.4.0) (2026-10-08)


### Features

* **sessions:** simplify attention and prioritize fresh completions ([5e70480](https://github.com/babariviere/pilot/commit/5e70480e3f57d10647c71dc6b6bf57e1b30319ca))


### Bug Fixes

* **sidebar:** toggle projects when clicking their names ([1c5270e](https://github.com/babariviere/pilot/commit/1c5270e0491cb57e0e342c76a65e10d6dcebc9d5))


### Performance Improvements

* reduce UI and background worker resource usage ([68a065d](https://github.com/babariviere/pilot/commit/68a065d59d6e32d0fff989b7bf543cce1a30939f))

## [1.3.0](https://github.com/babariviere/pilot/compare/v1.2.0...v1.3.0) (2026-10-08)


### Features

* **chats:** add read-only Ask mode and Build handoff ([6d88292](https://github.com/babariviere/pilot/commit/6d8829260eee90ee6e81aab0a0f9ff7c0fb0a2fc))
* **macos:** persist message drafts across app restarts ([bb528e9](https://github.com/babariviere/pilot/commit/bb528e92025d2811e151edb968fa26fd5895204e))


### Bug Fixes

* **macos:** preserve message drafts across navigation ([e682d63](https://github.com/babariviere/pilot/commit/e682d630172291f1da4617a630c6ba8122399fa6))

## [1.2.0](https://github.com/babariviere/pilot/compare/v1.1.0...v1.2.0) (2026-10-08)


### Features

* **artifacts:** add standalone SwiftUI previews ([d29b713](https://github.com/babariviere/pilot/commit/d29b7138bcd284c16972481b536f7bf2e62f04cb))
* **artifacts:** proactively explain with optional diagram previews ([9c0a7cc](https://github.com/babariviere/pilot/commit/9c0a7cc478a3f1bac0727f2b95489b07cfe017dd))
* **macos:** embed chat artifacts without card framing ([2861343](https://github.com/babariviere/pilot/commit/2861343904655170f96699a41c882456c1bf9600))
* **macos:** list chat artifacts in the right inspector ([9e451d7](https://github.com/babariviere/pilot/commit/9e451d7d1d839190571a536af18c1e827c7a0880))
* **sessions:** add a remote base branch selector ([3dbc9fe](https://github.com/babariviere/pilot/commit/3dbc9fed46e12744c1ee74be45207e6ae20b595f))


### Bug Fixes

* **macos:** prevent sidebar row clipping and align metadata ([3ba7b43](https://github.com/babariviere/pilot/commit/3ba7b430df6c23150dd644370d5d0677e802503a))
* **macos:** remove chat toolbar status indicator ([a8873b4](https://github.com/babariviere/pilot/commit/a8873b4c25406538288279a87031977b00c5d26d))


### Performance Improvements

* **chat:** improve typing and session-switch responsiveness ([76ce8cd](https://github.com/babariviere/pilot/commit/76ce8cdbc88f9fd5cbf36233098055b939bb2816))

## [1.1.0](https://github.com/babariviere/pilot/compare/v1.0.1...v1.1.0) (2026-10-08)


### Features

* **macos:** add per-chat thinking level selector ([ae29861](https://github.com/babariviere/pilot/commit/ae29861651360f6402d0c448f0be375f2a64636c))
* **macos:** group projects into custom sidebar folders ([6ad28c9](https://github.com/babariviere/pilot/commit/6ad28c958ee973355c6086ac02d2b56595a86711))
* **macos:** render SVG and Mermaid fences inline ([9b1311a](https://github.com/babariviere/pilot/commit/9b1311a6244b445789cc32e5043ba473543a156b))
* **macos:** support native clipboard image pasting ([c9e749f](https://github.com/babariviere/pilot/commit/c9e749f12a849152f582c6db3fc66090564a0aa9))
* **projects:** add per-project PR requirement ([619be05](https://github.com/babariviere/pilot/commit/619be05ec42d1a093bd682a48aac29225dd40551))


### Bug Fixes

* **kernel:** require conventional branch prefixes ([0cf56c1](https://github.com/babariviere/pilot/commit/0cf56c1a75b5983c7d22868b1452b693d26e62fa))
* **macos:** hide settled status footer in chat ([91f2c0a](https://github.com/babariviere/pilot/commit/91f2c0a47a870428f099d2645c531d5d5432494d))
* **macos:** keep sidebar footer readable over session rows ([23dc172](https://github.com/babariviere/pilot/commit/23dc1724383d4eb5c60e4d253bade49cf632ca6b))
* **macos:** shorten thinking selector label ([81b444c](https://github.com/babariviere/pilot/commit/81b444cc7ad7857676ec6bcaf9af92f950b007df))


### Performance Improvements

* faster workspace creation, thread reopening and many-thread load ([7ef522f](https://github.com/babariviere/pilot/commit/7ef522f644cb230dc36bbd878f44e87a1aac1afe))
* **release:** slim macOS bundles and publish stable ZIPs only ([07dfbfa](https://github.com/babariviere/pilot/commit/07dfbfa44b03836535b7c435ef2c30b0955f83df))

## [1.0.1](https://github.com/babariviere/pilot/compare/v1.0.0...v1.0.1) (2026-10-07)


### Bug Fixes

* **macos:** resolve private appcast downloads before Sparkle checks ([c243b0c](https://github.com/babariviere/pilot/commit/c243b0cd0546430581f2f370d8b0859a41e3d53b))

## [1.0.0](https://github.com/babariviere/pilot/compare/v0.5.0...v1.0.0) (2026-10-07)


### ⚠ BREAKING CHANGES

* **artifacts:** artifact tools are now invoked as artifact({action: ...}).

### Features

* **artifacts:** support images and larger expanded previews ([dde61df](https://github.com/babariviere/pilot/commit/dde61df1b87dd62618a3cf53c76f6ee635ebd47f))
* **chat:** add queued message removal shortcut ([56f0c00](https://github.com/babariviere/pilot/commit/56f0c0051abb846285dea85475dbea04650ecd92))
* **daemon:** archive inactive chats and delay merge archives ([20f6c0b](https://github.com/babariviere/pilot/commit/20f6c0b9658cb8534f0628069989aec2f7053c2b))
* **macos:** add session debugging drafts in pilot project ([1cd0e4f](https://github.com/babariviere/pilot/commit/1cd0e4fa8279bd5760eb31d16d12ed344666ace2))
* **macos:** show git changes and branch in sidebar ([d8a0ddd](https://github.com/babariviere/pilot/commit/d8a0ddddce07cd1ef5671c02428313b0acd4f3a9))
* **macos:** show sidebar line totals with a branch separator ([e7e430f](https://github.com/babariviere/pilot/commit/e7e430ff839bfa29d69e99a00d3cbc25dea6f376))
* **macos:** use a text-colored braille spinner while working ([ee4b623](https://github.com/babariviere/pilot/commit/ee4b6233fa07780a38f9e4b420d91ff3d40f10be))
* **sessions:** let agents name branches and generate cheap titles ([7c9d076](https://github.com/babariviere/pilot/commit/7c9d076709ab4526221f4f7b9439509916b859a7))
* **status:** show colored icons and clarify completion reporting ([40824bc](https://github.com/babariviere/pilot/commit/40824bcb3e86ea0258bd741dc95bf82755224c9d))


### Bug Fixes

* **chat:** allow removing queued messages ([e58d86a](https://github.com/babariviere/pilot/commit/e58d86a481493dbba961c89b9930957d18b5d431))
* **macos:** align status icons and use a plain completion check ([92aec39](https://github.com/babariviere/pilot/commit/92aec396c5754ac73fd666d50282ca66468b008d))
* **macos:** animate chat activity and remove trailing unread badge ([659f430](https://github.com/babariviere/pilot/commit/659f43088c8c8621a6b93666ef0a755023581ebf))
* **macos:** distinguish open and merged pull request icons ([0030ca3](https://github.com/babariviere/pilot/commit/0030ca3458bfbbfa9b80ea41ace0dedd831ea5ca))
* **macos:** move artifact browser into project header ([ae541fb](https://github.com/babariviere/pilot/commit/ae541fbc1c257115bb412676f821e169794895fe))
* **macos:** render real braille glyphs for the working spinner ([0f7cc11](https://github.com/babariviere/pilot/commit/0f7cc115da0599b9cb85be8f8f031cc0c05287ba))
* **macos:** replace working spinner with a text highlight wave ([58eb685](https://github.com/babariviere/pilot/commit/58eb6859fc4030bbf683280a0aa6ca58e4705c53))


### Code Refactoring

* **artifacts:** consolidate tools behind an action API ([fa5f462](https://github.com/babariviere/pilot/commit/fa5f462c8b00bad07e7295be48570ee11d26f56c))

## [0.5.0](https://github.com/babariviere/pilot/compare/v0.4.0...v0.5.0) (2026-10-07)


### Features

* **chat:** add compact composer usage and model picker ([6edb47d](https://github.com/babariviere/pilot/commit/6edb47dc771095d55a80c480932748974aa750f3))
* **chat:** make Codex and Claude usage visible and inspectable ([9ed9635](https://github.com/babariviere/pilot/commit/9ed9635c12318d05cd69d97b060cf2d52d4f18f7))

## [0.4.0](https://github.com/babariviere/pilot/compare/v0.3.0...v0.4.0) (2026-10-07)


### Features

* **chat:** show live TODO tasks above the composer ([e069a4e](https://github.com/babariviere/pilot/commit/e069a4e1f60e43261d3ed72334294b91d40aa588))


### Bug Fixes

* **macos:** default to artifact previews and explain stale daemons ([afc2ea7](https://github.com/babariviere/pilot/commit/afc2ea7f8ee82a22abae9025b5fcef994459753d))
* **macos:** keep project header buttons stable on hover ([31973d1](https://github.com/babariviere/pilot/commit/31973d15ee35aad04ba7da5d87b2845a797d540b))
* **macos:** resolve Ghostty resources inside signed app bundles ([f561e16](https://github.com/babariviere/pilot/commit/f561e1623a4714e9f146224e9e99f08b4df34d36))

## [0.3.0](https://github.com/babariviere/pilot/compare/v0.2.0...v0.3.0) (2026-10-07)


### Features

* **artifacts:** add versioned interactive session artifacts ([81c5f34](https://github.com/babariviere/pilot/commit/81c5f34573b7a819b311a5408334ce41237f5e64))
* **attention:** show agent outcomes and unread result indicators ([18968d4](https://github.com/babariviere/pilot/commit/18968d410d6e970a82b8a52429fa4c61dab8560e))
* **attention:** track pull request state for session branches ([395c64b](https://github.com/babariviere/pilot/commit/395c64b5227de771e023c67d74929c34ee5cc21e))
* **chats:** add archiving and project/global archive browsing ([2eb68fc](https://github.com/babariviere/pilot/commit/2eb68fcd278f38bbcfcc0cc7b4af5f50b34354c5))
* **macos:** add a polished path completion picker ([b77833b](https://github.com/babariviere/pilot/commit/b77833b51385a66def24254e1f3fd6a673f0cd72))
* **macos:** complete file paths on Tab ([fd5b3c4](https://github.com/babariviere/pilot/commit/fd5b3c4645e4f176d5b6f628e421060fcc1a41f9))


### Bug Fixes

* **macos:** preserve scroll position during active conversations ([d6ee0fc](https://github.com/babariviere/pilot/commit/d6ee0fc667b5cb15cd70fa9a117c69858399f736))
* **sidebar:** refresh chat ages and preserve activity timestamps ([5b8c046](https://github.com/babariviere/pilot/commit/5b8c046fecb0b9cf7275acd4c1a6783525af4a05))

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
