# Changelog

## [1.60.0](https://github.com/babariviere/pilot/compare/v1.59.2...v1.60.0) (2026-10-20)


### Features

* **kernel:** add history recall and opt-in deterministic compaction ([c8486c2](https://github.com/babariviere/pilot/commit/c8486c29ac99d1b447825741cefbeef185390efa))


### Bug Fixes

* **context:** preserve status when digest budgets fill ([13ea3cc](https://github.com/babariviere/pilot/commit/13ea3cce85a722131f69b58fecee9b0232e8b854))

## [1.59.2](https://github.com/babariviere/pilot/compare/v1.59.1...v1.59.2) (2026-10-20)


### Bug Fixes

* **build:** include PR delivery without publishing approval ([63c89c5](https://github.com/babariviere/pilot/commit/63c89c50b5ff8452119faad8421a00bd00d111ab))

## [1.59.1](https://github.com/babariviere/pilot/compare/v1.59.0...v1.59.1) (2026-10-20)


### Bug Fixes

* **database:** preserve verified Postgres TLS options ([7004f36](https://github.com/babariviere/pilot/commit/7004f3655269b1553abf60a4a500cca357048ee7))

## [1.59.0](https://github.com/babariviere/pilot/compare/v1.58.0...v1.59.0) (2026-10-20)


### Features

* **diagnostics:** accept an optional investigation reason ([26b5f27](https://github.com/babariviere/pilot/commit/26b5f27076168d8e417eb979448e607c688784ff))


### Bug Fixes

* **deps:** update dependency motion to v14.3.1 ([5867702](https://github.com/babariviere/pilot/commit/5867702b3d66211016d47b790c96e62a9cbf1cc2))

## [1.58.0](https://github.com/babariviere/pilot/compare/v1.57.0...v1.58.0) (2026-10-20)


### Features

* **diagnostics:** observe integration background job health ([c43a588](https://github.com/babariviere/pilot/commit/c43a588d61608c5acf30f0b76327b35197ab17ca))
* **diagnostics:** read bounded owned service journal history ([c55fcb0](https://github.com/babariviere/pilot/commit/c55fcb0917abcaf6fd7615e610e35a9e06586a56))
* **diagnostics:** retain bounded refresh evidence across restarts ([b41e7fe](https://github.com/babariviere/pilot/commit/b41e7fe8efc3377d2713c835b1dcd30c41362d8b))
* **diagnostics:** retain private native app event logs ([93abb1a](https://github.com/babariviere/pilot/commit/93abb1af44b1291321e2eab13277fa4542d76ea0))


### Bug Fixes

* **deps:** update dependency typebox to v1.4.2 ([d94c48e](https://github.com/babariviere/pilot/commit/d94c48e34f2966a148a598c6cc73c93847b65035))
* **diagnostics:** expire retained completion details independently ([8f1452c](https://github.com/babariviere/pilot/commit/8f1452c4bb6f26ba340c3b278c62a5746aab638a))
* **linear:** use supported mission sync read fields ([ac5d59d](https://github.com/babariviere/pilot/commit/ac5d59d348ee5ec624a27c9c207a293075340cb8))
* **macos:** archive diagnostics after confirmed repair start ([e41be90](https://github.com/babariviere/pilot/commit/e41be901834b89aef3dda811c3a0f206ece5eebf))
* **macos:** size Slack toolbar glyph to match adjacent actions ([b302ee9](https://github.com/babariviere/pilot/commit/b302ee923fd051705d270e0c6e0685435365f875))
* **slack:** verify and report Done reaction cleanup ([5852e8d](https://github.com/babariviere/pilot/commit/5852e8d8b793779b91cdbe15904d77eb15aefa1a))
* **ui:** hide retained Control conversations from discovery ([448a937](https://github.com/babariviere/pilot/commit/448a9376fef15bd7c98e43ef4fdf30a29b8a3376))


### Performance Improvements

* **macos:** isolate text sizing from drawing ([f21f96d](https://github.com/babariviere/pilot/commit/f21f96d8a448fdc4e0db5835b08d292d7e99560b))
* **macos:** report hitch time ratio and scrolling hitches in benchmarks ([18bdfd1](https://github.com/babariviere/pilot/commit/18bdfd1a79857fcbef1f7e80c15ed806d2bd83fe))

## [1.57.0](https://github.com/babariviere/pilot/compare/v1.56.0...v1.57.0) (2026-10-19)


### Features

* draw Mermaid diagrams in native visuals ([3b87e1e](https://github.com/babariviere/pilot/commit/3b87e1e41549dc574b1f15f011832708fcce0c45))
* **macos:** add host-specific MCP connections and safe setup review ([d2d361b](https://github.com/babariviere/pilot/commit/d2d361b090b63b4747017e34a776860523e775ac))
* **mcp:** add coordinated writes for existing configurations ([d4fa044](https://github.com/babariviere/pilot/commit/d4fa0443e7d2ee4c6a335ac6cc934210017ff0f1))
* **permissions:** require app approval for publish upgrades ([78b6a62](https://github.com/babariviere/pilot/commit/78b6a62bb9b5e90710e4cc578fdd47227cdded9c))
* **slack:** use hourly budgets and allow forced sync ([57d88c9](https://github.com/babariviere/pilot/commit/57d88c987be19a6668a0d7d94e210997c0a123fc))


### Bug Fixes

* **chat:** show which decisions changed in notices ([e5d7288](https://github.com/babariviere/pilot/commit/e5d728896a84ec8bc815fd22ecaeabaae723cf0e))
* **config:** move Pilot settings to the config directory ([907294e](https://github.com/babariviere/pilot/commit/907294ea976b856a304543434fb7ee6980c15a6a))
* **control:** share menu visibility across reactive snapshots ([4aecb02](https://github.com/babariviere/pilot/commit/4aecb020eae73412da5d3ec0ef4aef01810b743c))
* **control:** show only Mac Control in navigation ([48bd2ed](https://github.com/babariviere/pilot/commit/48bd2edb3dde1daf1b4e609eb182282cbf329591))
* **linear:** reconcile ticket sync and retain scoped failures ([979cb47](https://github.com/babariviere/pilot/commit/979cb47665734d324937abb23ebe1b8080e2fbaf))
* **macos:** align repair status with the composer ([38f40c0](https://github.com/babariviere/pilot/commit/38f40c0bc1e21115a014fb019c603aad801f8c8c))
* **macos:** keep row submenus active when the pointer leaves ([f29d901](https://github.com/babariviere/pilot/commit/f29d901b9bd6139abc0b82c9230d359cc03a3236))
* **macos:** let native visuals grow to their full height ([d899a8d](https://github.com/babariviere/pilot/commit/d899a8da57bb050e02e8f4a75ec1e46f36137972))


### Performance Improvements

* **macos:** benchmark native visuals against HTML artifacts ([e2d770a](https://github.com/babariviere/pilot/commit/e2d770a09e08949537b705495e8cf172a20b6b57))

## [1.56.0](https://github.com/babariviere/pilot/compare/v1.55.0...v1.56.0) (2026-10-19)


### Features

* **artifacts:** define the visual node tree API 1 ([7b0e2c6](https://github.com/babariviere/pilot/commit/7b0e2c6d062dd2c5b090eb424dce66a8553ea91a))
* **artifacts:** publish visual artifacts after a QuickJS pre-check ([8666edc](https://github.com/babariviere/pilot/commit/8666edc83c5f7c9831fc76bcd1fb66d44a1dcc67))
* draw canvas nodes in native visuals ([e78afbd](https://github.com/babariviere/pilot/commit/e78afbdc03193f1131293bc3e3760726f6347599))
* draw shader nodes in native visuals with Metal ([4985932](https://github.com/babariviere/pilot/commit/498593259e5cf271c818cc5ac4f909ba9f6143ea))
* **kernel:** offer native visuals by default and steer agents to them ([90c960f](https://github.com/babariviere/pilot/commit/90c960f56ceef569668129054bb3a44b5e826a25))
* **macos:** parse Markdown tables into header, alignment and cells ([70811be](https://github.com/babariviere/pilot/commit/70811be94ab523fcb1a5a52c99da4a1a2fda7272))
* **macos:** render chat Markdown tables as native accessible tables ([0c4cbe7](https://github.com/babariviere/pilot/commit/0c4cbe7b99e294c813719199f13d40780b2bcadd))
* **macos:** render visual artifacts natively ([f6df85c](https://github.com/babariviere/pilot/commit/f6df85c7a084e3d344bdf61a3a7929247d33c957))
* **macos:** run visual scripts in a sandboxed QuickJS-NG service ([6c10288](https://github.com/babariviere/pilot/commit/6c102885968939ebf6bd4ce5e3a4d9b7c21302c4))
* **slack:** let a chat's agent mark its Slack message done ([133a086](https://github.com/babariviere/pilot/commit/133a0864feb618a757c2627b119c32ede1b4082a))


### Bug Fixes

* **attention:** flag code changes without a pull request ([a02e0de](https://github.com/babariviere/pilot/commit/a02e0de767eec7894c9989cbaa0ca97df7085281))
* **ci:** restore macOS build and Ask skill read on main ([d024f46](https://github.com/babariviere/pilot/commit/d024f46c611dfcab6cf0c789b7be6b6609f3f0ba))
* **daemon:** allow explicit publish permission upgrades ([d9d21a9](https://github.com/babariviere/pilot/commit/d9d21a9774da7912def588e7fe0c09049d694af0))
* **daemon:** archive coordinators with their missions ([313e3bd](https://github.com/babariviere/pilot/commit/313e3bd2bc78dcf605cb0f98f9f2bd4212d0f09c))
* keep assistant handoffs, pending questions and coordinator compaction bounded ([04a755a](https://github.com/babariviere/pilot/commit/04a755a986ac4f1ab61e8d04941119bd29da07fa))
* **macos:** compare session diagnostics hosts directly ([4d70902](https://github.com/babariviere/pilot/commit/4d709023421d74a187b0d42d64ec4a65b4fe57aa))
* **macos:** pass the artifact decoder as a Sendable closure ([172103f](https://github.com/babariviere/pilot/commit/172103fcc1d9ed1d170d0ba933b5757321b98459))

## [1.55.0](https://github.com/babariviere/pilot/compare/v1.54.0...v1.55.0) (2026-10-19)


### Features

* bind reviewed repair starts to configured source checkouts ([0897a42](https://github.com/babariviere/pilot/commit/0897a425d3cbbae582dd79bb8231294ede1d7beb))
* **diagnostics:** collect local feature usage aggregates ([ba68bec](https://github.com/babariviere/pilot/commit/ba68bec849e7438fe575c444930190f0bc794902))
* **diagnostics:** expose private local feature evidence ([c71d462](https://github.com/babariviere/pilot/commit/c71d462252357dab611be09a0e4db6c267a3b13b))
* **diagnostics:** read app-wide evidence through trusted role ([36b5b79](https://github.com/babariviere/pilot/commit/36b5b79b8ad899a848b4451c264180d3ee908716))
* **diagnostics:** scaffold bounded local feature aggregates ([2edda4c](https://github.com/babariviere/pilot/commit/2edda4cc76a9d6c504f784a2d55bc94acac91be4))
* **diagnostics:** start without an attached chat ([b53912d](https://github.com/babariviere/pilot/commit/b53912dfb0f26bb1d366b2e117af6f20ea893979))
* pin repair actions beside the chat composer ([fa862f9](https://github.com/babariviere/pilot/commit/fa862f9119e56bfbca81f40b00468a71baafd4d4))
* **slack:** set a Slack message's status from its chat ([82f514e](https://github.com/babariviere/pilot/commit/82f514e8ca060e70f8cde5bb67826e9397b70865))
* **sources:** expose bounded refresh health to diagnostics ([a1770e0](https://github.com/babariviere/pilot/commit/a1770e07c32af09d6cdff4efc6fbbe9c67af092d))
* **sources:** scaffold read-only refresh health ([9b9d115](https://github.com/babariviere/pilot/commit/9b9d1158055430ead37a51811cc90e870276559a))


### Bug Fixes

* **diagnostics:** attribute synchronous startup and update work ([d840c85](https://github.com/babariviere/pilot/commit/d840c8595bcff26a37fbfe214129144a41fdb0ca))
* **diagnostics:** describe chat selection as investigation focus ([f37a0ed](https://github.com/babariviere/pilot/commit/f37a0ed1767032a7f663d45e919078cd7ef7701e))
* **diagnostics:** select chats by qualified host ([41342cf](https://github.com/babariviere/pilot/commit/41342cfad6591020607e534da41596c6a8d7c883))
* return the verified project origin response ([5188ba3](https://github.com/babariviere/pilot/commit/5188ba33ed836d9392b01c944d58d4e3eef4692f))
* **sessions:** defer auto-pause status until active tools finish ([1264a9e](https://github.com/babariviere/pilot/commit/1264a9e29168b24b42e3a274a9ac61af69bf5e36))
* **sidebar:** scope missions to the selected project ([06507a7](https://github.com/babariviere/pilot/commit/06507a71d2cb070edb2935327ff1553cb24c22a6))
* **ui:** preserve PR capitalization in watch labels ([acaab20](https://github.com/babariviere/pilot/commit/acaab20d4e6b483dd500fed604ff971426910174))

## [1.54.0](https://github.com/babariviere/pilot/compare/v1.53.1...v1.54.0) (2026-10-19)


### Features

* **databases:** add host-local project connection settings ([1b0071f](https://github.com/babariviere/pilot/commit/1b0071fe936e29718e12426dff2c144a72889968))
* **environment:** add profile, plan and readiness types with validated storage ([12f65e1](https://github.com/babariviere/pilot/commit/12f65e1b3ad16e12f85208274e7929c31e8089b2))
* **environment:** add the Environment section to project settings ([d5b81aa](https://github.com/babariviere/pilot/commit/d5b81aafa8a735495d413143b4a10f00a922c11d))
* **environment:** discover declared toolchains, services and setup steps ([e74f6e0](https://github.com/babariviere/pilot/commit/e74f6e01cc2489db3124519eeed244207a3e8047))
* **environment:** probe hosts and preview install plans ([de841f2](https://github.com/babariviere/pilot/commit/de841f2b957ef67411b0e32ff22f1c7deb3fac61))
* show Slack or Linear source on chats started from triage ([f9b020d](https://github.com/babariviere/pilot/commit/f9b020d425fc95010d5e6e7425f89ff5923bd378))


### Bug Fixes

* **ci:** repair native regressions and Linux workflow expectations ([d525e57](https://github.com/babariviere/pilot/commit/d525e5798e7c787ceb4c7f777d3826d5a67f0917))
* **control:** archive non-home conversations read-only ([3d4e4c1](https://github.com/babariviere/pilot/commit/3d4e4c19a61d32b5e4e70889122a62576f04aef3))
* **control:** require explicit mode for chat starts ([b52dfe8](https://github.com/babariviere/pilot/commit/b52dfe82adc5873f0ac751916864da298f0762e0))
* **slack:** accept wrapped reaction confirmations ([25a08fa](https://github.com/babariviere/pilot/commit/25a08faa19e0905f60f3a21fe0f5f1e371cd65d9))
* **slack:** expose triage refresh in the toolbar ([35a8611](https://github.com/babariviere/pilot/commit/35a8611104f0b239fcb54ad48be71be04f5e2033))
* **slack:** restore access to the triage board ([1131a9b](https://github.com/babariviere/pilot/commit/1131a9b44b57e10b3bd5b813acbffd52bc94a6a1))

## [1.53.1](https://github.com/babariviere/pilot/compare/v1.53.0...v1.53.1) (2026-10-19)


### Bug Fixes

* **diagnostics:** bound URL credential redaction work ([8063aac](https://github.com/babariviere/pilot/commit/8063aac38ab5c4f68ffa5fabe889baa2a86106b4))

## [1.53.0](https://github.com/babariviere/pilot/compare/v1.52.0...v1.53.0) (2026-10-19)


### Features

* **projects:** map host checkouts by Git origin ([df46ec5](https://github.com/babariviere/pilot/commit/df46ec5f2e2f001e2684bd72c7a5dcbada3c9a0b))


### Bug Fixes

* **macos:** disable disconnected chat submission ([8697b22](https://github.com/babariviere/pilot/commit/8697b22f69f06f4b07fbb8285ca78867ccdafba8))
* **macos:** keep urgency and true totals in the multi-host Inbox ([f10228f](https://github.com/babariviere/pilot/commit/f10228f3326d9b9be8cab1267176b846c0aad7ce))
* **projects:** scope manual checkout overrides to placement ([aa6f4cb](https://github.com/babariviere/pilot/commit/aa6f4cb8f52c91e90dc410a7a7784eecd228ee4a))
* **settings:** keep unsaved project edits across refreshes and saves ([bad833f](https://github.com/babariviere/pilot/commit/bad833f0c618b6627642957aad644e1ac90d384a))


### Performance Improvements

* **projects:** coalesce unchanged checkout evidence writes ([6ad467c](https://github.com/babariviere/pilot/commit/6ad467c0e95f96bab4c8e50e593398323d79c68e))

## [1.52.0](https://github.com/babariviere/pilot/compare/v1.51.0...v1.52.0) (2026-10-18)


### Features

* **diagnostics:** identify specialist chats and suggest repairs ([0483d7d](https://github.com/babariviere/pilot/commit/0483d7db2be301f43ef55987405bba844d611c32))
* **diagnostics:** surface repair proposal prompts ([a3eb39b](https://github.com/babariviere/pilot/commit/a3eb39bf232f87e30ac1fff9b655899f7efb0c30))


### Bug Fixes

* **devbox:** authorize GitHub setup with key-management scopes ([f931bbf](https://github.com/babariviere/pilot/commit/f931bbf8c57f3ba8adb353f9c74c764bf6d7bb90))
* **macos:** order diagnostics test arguments ([6d1d7cd](https://github.com/babariviere/pilot/commit/6d1d7cdddc0eac9dd5f67faaf994ec5888ff3bc2))
* **macos:** restore diagnostics CI compilation ([b1783aa](https://github.com/babariviere/pilot/commit/b1783aa9bfb124e29b3be5e3532d16eba3a8f519))
* **macos:** retain missions when dashboard summaries are clipped ([e0ca964](https://github.com/babariviere/pilot/commit/e0ca964fa5a0f07864cd5fd8d99b738f17800429))

## [1.51.0](https://github.com/babariviere/pilot/compare/v1.50.0...v1.51.0) (2026-10-18)


### Features

* **diagnostics:** add bounded Pilot log access ([c9e1307](https://github.com/babariviere/pilot/commit/c9e130721ec2f9baaf9f7f406de858c0e844ada5))
* **diagnostics:** generate descriptive specialist titles ([921cd0c](https://github.com/babariviere/pilot/commit/921cd0cbd7bd30f3326b5afbce9f48caf8d9f4da))


### Bug Fixes

* **home:** bound PR badges in Working now rows ([6211e8f](https://github.com/babariviere/pilot/commit/6211e8f42f09650b967c221b7d78430c3f6f19ee))
* **kernel:** bound shell execution and distinguish timeouts ([bad16fe](https://github.com/babariviere/pilot/commit/bad16fe272ae421e1bf22a120bdf43fda55665de))

## [1.50.0](https://github.com/babariviere/pilot/compare/v1.49.0...v1.50.0) (2026-10-18)


### Features

* **control:** add authorized chat run controls ([cef73aa](https://github.com/babariviere/pilot/commit/cef73aaf2d028157986f19cb809006188e02d655))
* **control:** add bounded local text and image reads ([6e46f38](https://github.com/babariviere/pilot/commit/6e46f38e2d4f479573a894f664627ba29ac423cc))
* **control:** add durable executor admission and enrollment ([1313ca3](https://github.com/babariviere/pilot/commit/1313ca37ce097083ec82b02c85635359edfe37a2))
* **control:** enforce started chat permission levels ([50fc10c](https://github.com/babariviere/pilot/commit/50fc10cba563e2117f3950a1d5e23c22f429a8ee))
* **control:** require explicit authorized start choices ([25b60c8](https://github.com/babariviere/pilot/commit/25b60c8c00cca51abe1b9d2df0818fd0ce2bd3b3))
* **control:** unify logical missions in status ([ca0668b](https://github.com/babariviere/pilot/commit/ca0668b2675c913b4112acaa5e0a2051a4acd27d))
* **diagnostics:** accept questions in Ask about Pilot ([5df8475](https://github.com/babariviere/pilot/commit/5df8475dd4f2f822e62942fd52d5038fc1b758a8))
* **diagnostics:** add informational usage budgets ([533654f](https://github.com/babariviere/pilot/commit/533654ff9ca08311ecf6f24591a512b015570fb7))
* **diagnostics:** restore scoped target history ([bc4ba0a](https://github.com/babariviere/pilot/commit/bc4ba0ac6ce93442088a6eca892b1429154cfa30))
* **macos:** add scoped-model selector and sync foundation ([09696dc](https://github.com/babariviere/pilot/commit/09696dcb65affa948876e2cadb0b3bfbcf729ae1))
* **macos:** automatically update compatible devbox runtimes ([91b6db9](https://github.com/babariviere/pilot/commit/91b6db96091b8204ce4f5caee16b6921cf92f1b3))
* **macos:** reconnect saved devboxes at startup ([f7a4762](https://github.com/babariviere/pilot/commit/f7a4762ac9afedd77b5c3de27bf48786defea6de))
* **macos:** wire scoped-model settings and live host sync ([bbf8e88](https://github.com/babariviere/pilot/commit/bbf8e88cee71c2bb3943ec506f26b349e6ed6c13))
* **models:** add host-local scoped-model settings API ([129f06e](https://github.com/babariviere/pilot/commit/129f06e35079bfd313c466104707755334a56708))


### Bug Fixes

* **chat:** isolate Local drafts from pending devbox starts ([ec83eb5](https://github.com/babariviere/pilot/commit/ec83eb5b8586abe7ed3f9cbd5a18796aab800695))
* **control:** keep start tool description within budget ([4d90f7e](https://github.com/babariviere/pilot/commit/4d90f7e455542ced883fd70fcc93287eb42e6305))
* **control:** keep the tool description compact ([8eb6028](https://github.com/babariviere/pilot/commit/8eb6028133ebf57e72f2831ab733889413a17743))
* **control:** make budgets diagnostic and release safe failures ([ec55f97](https://github.com/babariviere/pilot/commit/ec55f973695fd05c2887dbc97a13b79af54a8623))
* **control:** make history summaries reliable and never fail a turn on them ([e931d6c](https://github.com/babariviere/pilot/commit/e931d6c5ddfa883debbaed6bc323919b61d480e6))
* **control:** recover turns while history compaction is behind ([aa7d1b4](https://github.com/babariviere/pilot/commit/aa7d1b489832b09b1b8aa0a9859c7fcd5e7251e7))
* **control:** report correlated request preparation failures ([31b1d5b](https://github.com/babariviere/pilot/commit/31b1d5b5b15deb8b8792cd56170027aee5ed4f77))
* **control:** revoke archived watch authorizations ([0b4f98c](https://github.com/babariviere/pilot/commit/0b4f98cd01268b3a8e1866f3bac2e5699f7ea860))
* **daemon:** repeat PR follow-ups only after an agent push attempt ([029864a](https://github.com/babariviere/pilot/commit/029864a65f5d4ef5539ea3e745f66863498999e7))
* **devbox:** recover durable chat starts and make Check actionable ([8415b3a](https://github.com/babariviere/pilot/commit/8415b3aa498b3a68d11426a07591020feec49a9f))
* **macos:** build with Swift 6.4 diagnostics ([5b8886f](https://github.com/babariviere/pilot/commit/5b8886f06f75ea5b110d01719c1528bc57b6271e))
* **macos:** clear message text selection when focus leaves the reply ([aba664e](https://github.com/babariviere/pilot/commit/aba664ea2c1ce003f311e97677ab364db326ae3f))
* **macos:** fence scoped-model conflict consent ([ac78937](https://github.com/babariviere/pilot/commit/ac789376214a662307bc913d1f060bd29f2bb954))
* **macos:** offer runtime update when setup finds an older unsaved devbox ([d9a44cb](https://github.com/babariviere/pilot/commit/d9a44cbb56fe70502ad7fe5bffaf19be677c1bcf))
* **macos:** unify mission navigation across devboxes ([d23bb4f](https://github.com/babariviere/pilot/commit/d23bb4f930f0b6839940b036c38d914ac659501e))
* **missions:** align native catalog with logical producer ([89e6041](https://github.com/babariviere/pilot/commit/89e6041bc3cfa522218caf2e5fcbeaab9c8ab087))
* **models:** align scoped-model settings wire contract ([962dd3e](https://github.com/babariviere/pilot/commit/962dd3eb3271fa5e1f3c71ce0a5532d124a4396a))
* restore main CI after concurrent merges ([de89c3c](https://github.com/babariviere/pilot/commit/de89c3c63c1370392f78efca62313733808c3be1))
* **transcript:** preserve coordinator message provenance ([a45ff07](https://github.com/babariviere/pilot/commit/a45ff075ca7af54cf283c237f11bc6da6da903de))

## [1.49.0](https://github.com/babariviere/pilot/compare/v1.48.0...v1.49.0) (2026-10-18)


### Features

* **control:** follow through on authorized chat work ([b214c7e](https://github.com/babariviere/pilot/commit/b214c7e3ba88fb689ddfa6c718654f9766b59186))
* **control:** include delegated tasks and remote mission replicas ([cd0adee](https://github.com/babariviere/pilot/commit/cd0adee069ea80850ddb778f246ccc335e17b971))
* **control:** record and enforce action authorizations ([e0660f8](https://github.com/babariviere/pilot/commit/e0660f88147b26bf250e657853f5b2df9ea51370))
* **devbox:** add independent GitHub connection setup ([9bf7e14](https://github.com/babariviere/pilot/commit/9bf7e149c368aeb57ea5c1f101cea8a878dd7bdf))
* **diagnostics:** add reviewed repair proposals ([101cb9b](https://github.com/babariviere/pilot/commit/101cb9bfb49372c750b7b7e9001ede03739d24d3))
* **diagnostics:** add specialist setup context ([c2a76d9](https://github.com/babariviere/pilot/commit/c2a76d9c63ae643b995ff0f025237f990b23d40f))
* **diagnostics:** expose devbox setup stages ([91d79bc](https://github.com/babariviere/pilot/commit/91d79bc37b357c0414d95665de57ef8c5b52c4b6))
* **diagnostics:** measure context efficiency and relaunches ([846d795](https://github.com/babariviere/pilot/commit/846d7954b7450cd79fc8fd90039b61bd4a0776b4))
* **macos:** copy session paths and links ([57a0a57](https://github.com/babariviere/pilot/commit/57a0a57e7aded56aa40dae6f420858ebeef41f7b))
* **projects:** import GitHub repositories onto a chosen host ([bf304a4](https://github.com/babariviere/pilot/commit/bf304a4f2300885ed29b978dd18fcbcda5ae59a4))
* **telemetry:** account for AI usage and estimated cost ([e50fc02](https://github.com/babariviere/pilot/commit/e50fc02dd2e92fb65c3176b98fd7016ce185f566))


### Bug Fixes

* **daemon:** settle AI usage writes before removing a rolled-back session ([d92a5c8](https://github.com/babariviere/pilot/commit/d92a5c8cc07e609982c6ba55b1ecc44a53e1caa1))
* **kernel:** isolate Control requests and surface preparation faults ([23cb6f2](https://github.com/babariviere/pilot/commit/23cb6f26e28cc5622a2ed9a40fe2ec57d1256d39))
* **macos:** import Foundation in GitHub import model ([d048e0a](https://github.com/babariviere/pilot/commit/d048e0a6b8f39864cd97cf9bf087933d94836c6e))
* **macos:** use design-system role for usage details ([f06c713](https://github.com/babariviere/pilot/commit/f06c713f97fe3f688c7d043de67cb1d55e2ff709))

## [1.48.0](https://github.com/babariviere/pilot/compare/v1.47.0...v1.48.0) (2026-10-18)


### Features

* add exact-head PR checks for Control ([a3c83ed](https://github.com/babariviere/pilot/commit/a3c83ed2ed39ba8db53a3bf8bb539618b2bd37e5))
* add read-only control memory API ([97e873e](https://github.com/babariviere/pilot/commit/97e873e910164e76aa260786ee5bc866e95c19eb))
* **control:** add bounded read-only diagnostics ([31c8d01](https://github.com/babariviere/pilot/commit/31c8d015c155cfca5cbd9d2aac03010b8b8dcf8a))
* **control:** share a bounded dashboard snapshot ([c77c57b](https://github.com/babariviere/pilot/commit/c77c57b441707d1696ba06e04017725177e95d53))
* **diagnostics:** surface suspected tool stalls ([21bd202](https://github.com/babariviere/pilot/commit/21bd202689e0072e307ef0f201b1a95aa6d2bb11))
* **evidence:** capture committed session history and provenance ([4d67c6e](https://github.com/babariviere/pilot/commit/4d67c6e10ca0c0d43c2cd97a36e5b998bb9891ce))
* **evidence:** freeze code and verification snapshots ([3197844](https://github.com/babariviere/pilot/commit/319784442c9778a28177166d8ac59834c9721613))
* **github:** capture bounded PR discussions and check evidence ([6674367](https://github.com/babariviere/pilot/commit/6674367b1f675ad18072781fd618b3b25653cc55))
* **github:** capture exact PR objects without branch ownership ([6be2147](https://github.com/babariviere/pilot/commit/6be2147d7d62eb8782b31fbfbdfb617379fdff4c))
* **macos:** add the Control screen ([a00fbc3](https://github.com/babariviere/pilot/commit/a00fbc310e39d44112df8cc73d8be08bf218f750))
* **macos:** open the Control chat with G then C and list it in the palette ([31aeda8](https://github.com/babariviere/pilot/commit/31aeda8cdf9b473013cd3c255cd3fc1c4947f14f))
* **macos:** pin the Control chat above the sidebar list in every scope ([c65133b](https://github.com/babariviere/pilot/commit/c65133b44baaeaabe92c9e57bbe2f7a5db46816b))
* **telemetry:** trace tool call lifecycle ([9fba05b](https://github.com/babariviere/pilot/commit/9fba05b29e42f028f6774872e28c991e91ac4428))


### Bug Fixes

* **agents:** leave remote CI monitoring to Pilot ([8889f11](https://github.com/babariviere/pilot/commit/8889f111530c90a30b74771465d3c0ae0e5c9a44))
* **control:** format watch notices as readable event lists ([8f2ef69](https://github.com/babariviere/pilot/commit/8f2ef694fa1b90e1c5d4d4ef8122f8f92eeef5f8))
* **daemon:** show unanswered questions as Needs you while jobs run ([9ef5165](https://github.com/babariviere/pilot/commit/9ef5165d6eeb61b8d5dc71a9c9dfc452f6b9a66e))
* **deps:** update dependency @gotgenes/pi-anthropic-auth to v3.4.3 ([92498e4](https://github.com/babariviere/pilot/commit/92498e4f840f297fd9ffbd46f10188c3593a1881))
* **deps:** update dependency motion to v14.3.0 ([1dcf7a5](https://github.com/babariviere/pilot/commit/1dcf7a51f13a7d685c1589b6d632186821ac388a))
* **home:** share contained status corners with inbox ([df6a277](https://github.com/babariviere/pilot/commit/df6a2774503c0f22dd3c5c6b5c298602ccbc11ee))
* **inbox:** keep status corners inside row bounds ([b277c4b](https://github.com/babariviere/pilot/commit/b277c4bb3b7621693975e9f7b01ecffee0f25ac2))
* **macos:** keep chat history visible while loading ([b96a791](https://github.com/babariviere/pilot/commit/b96a7917b82af6b0eed16cb8537cb8aba79b249d))
* **macos:** keep one reading anchor through a history layout pass ([c0cde23](https://github.com/babariviere/pilot/commit/c0cde23182d8ad8d3fcc813be9d6363cec061317))
* **macos:** keep SSH control socket directory name valid ([9300d53](https://github.com/babariviere/pilot/commit/9300d536537cd99361eeec76e33b84b70ccede2f))
* **macos:** keep the grey selection on highlighted chat rows ([725b77f](https://github.com/babariviere/pilot/commit/725b77f67c643f7a27ccc93d1c3d33ab778e6399))
* **macos:** resolve Swift warnings and treat new warnings as errors ([368030a](https://github.com/babariviere/pilot/commit/368030a067accce337bcde071f3118de5d834360))
* **macos:** retain reading anchors through history layout ([1c64a7d](https://github.com/babariviere/pilot/commit/1c64a7d68a747d344b30879a32099d8a21a184fe))
* **macos:** show keyboard highlights only during keyboard navigation ([f1eca3e](https://github.com/babariviere/pilot/commit/f1eca3e1ba1ee06e70409a040c287f16560d746e))
* show contextual G destinations ([7d1de46](https://github.com/babariviere/pilot/commit/7d1de46a75b9628873fab846a2258eb23a868809))
* **watches:** remove subscriptions for archived targets ([acb46e8](https://github.com/babariviere/pilot/commit/acb46e8d794d30fa2f60dacce9d4680c39ad5f05))

## [1.47.0](https://github.com/babariviere/pilot/compare/v1.46.0...v1.47.0) (2026-10-17)


### Features

* **analytics:** define feature adoption catalog ([25237a6](https://github.com/babariviere/pilot/commit/25237a6955b10c50f77671e0b6be7afb9916110b))
* **analytics:** instrument approved adoption journeys ([6953802](https://github.com/babariviere/pilot/commit/695380242112c5d6cda227bc4500590c2ce2be09))
* **diagnostics:** add native crash and hang evidence ([29e2204](https://github.com/babariviere/pilot/commit/29e2204e60c7b8c82ac1b56334f6326aba936c53))
* **diagnostics:** add target-scoped diagnosis actions ([758954b](https://github.com/babariviere/pilot/commit/758954b4c03fc70d933a1a7d830889b0df39d451))
* **diagnostics:** isolate specialist repair handoffs ([afff2e6](https://github.com/babariviere/pilot/commit/afff2e6cb9e266410e2ec694ab8032d3ae675b41))
* **telemetry:** add consent and export settings ([4ea9862](https://github.com/babariviere/pilot/commit/4ea9862fcc6b6189b1ca14303f4f33aadc325bee))
* **telemetry:** add Node OpenTelemetry foundation ([111c21b](https://github.com/babariviere/pilot/commit/111c21bc7fd6056d58fe4c42a2e00864ac6c02c0))
* **telemetry:** add Swift OpenTelemetry foundation ([5abaed3](https://github.com/babariviere/pilot/commit/5abaed339709f4362a4800f0b6bf7b29c681d7f8))
* **telemetry:** trace chat opening latency ([211d96a](https://github.com/babariviere/pilot/commit/211d96ae0593f5863a60a3ef067507b38fef1077))
* **telemetry:** trace message response latency ([618b92d](https://github.com/babariviere/pilot/commit/618b92df4ac4b79c78ac5bf3ee66a6b271116a78))


### Bug Fixes

* **analytics:** reject linked telemetry identities ([68287c8](https://github.com/babariviere/pilot/commit/68287c89354d679605100dc1b67261829d367493))
* **daemon:** finish workspace removals interrupted after jj unregistered them ([01ab4c9](https://github.com/babariviere/pilot/commit/01ab4c9ef225a543135b1def0df949a7254d9e8e))
* **daemon:** refresh bound primary PR from by-number results ([b0acfaf](https://github.com/babariviere/pilot/commit/b0acfafbfc89e0d21c4e129229ab251ff6a3433a))
* **daemon:** skip unreachable mounts in Linux isolation guard ([6a3dbba](https://github.com/babariviere/pilot/commit/6a3dbbadd9fc1b3aa4712c6577402c293e415214))
* **diagnostics:** use existing secondary text token ([342dd30](https://github.com/babariviere/pilot/commit/342dd30fc366e599bfc9120440c3a64e6dcce729))
* **settings:** show focus only on the selected sidebar row ([60a1e77](https://github.com/babariviere/pilot/commit/60a1e777a31d502e26200b36b1d98e18f1a4e7dd))
* **slack:** read forwarded messages and app notifications as attachments ([001efae](https://github.com/babariviere/pilot/commit/001efaed348fbea1a392e071345b8e2e8f791ec9))
* **telemetry:** key remote settings by host identity ([bdca6be](https://github.com/babariviere/pilot/commit/bdca6be8a0a2e8a603c30ba760fb35fafa0893a4))
* **telemetry:** preserve explicit span outcomes ([ccd0938](https://github.com/babariviere/pilot/commit/ccd093817856c9010aac50304576d6a4830eab1b))
* **ui:** remove focus outlines throughout Pilot ([db02736](https://github.com/babariviere/pilot/commit/db02736e391e0b828655c4412021699f3f4a4b9a))
* **ui:** suppress native focus rings across macOS versions ([615fa13](https://github.com/babariviere/pilot/commit/615fa13e7c70f89f1a485ed21ef981fb5b219862))
* **ui:** track native field editor ownership during focus changes ([2f5d704](https://github.com/babariviere/pilot/commit/2f5d7042c25ebc763b23b6b4c3333fd1fdbfe6d5))

## [1.46.0](https://github.com/babariviere/pilot/compare/v1.45.1...v1.46.0) (2026-10-17)


### Features

* **artifacts:** add GLSL shader artifact kind ([fbb2e9d](https://github.com/babariviere/pilot/commit/fbb2e9dab0fc237b2770db6f3d15d21c01c07fe3))
* **control:** connect watch delivery and client contracts ([55e54ce](https://github.com/babariviere/pilot/commit/55e54cebbd76ab205f5c0f4dd50661d15f7318ea))
* **diagnostics:** expose bounded agent evidence ([a6aa6b2](https://github.com/babariviere/pilot/commit/a6aa6b2454a3a4919896c12b6b6861eac99f78ab))
* **diagnostics:** record bounded lifecycle evidence ([36164a0](https://github.com/babariviere/pilot/commit/36164a0b985d4f2d5adf679539a7c7aa226980c2))
* **macos:** add ⌘[ and ⌘] for Back and Forward and restore list highlights ([c4eb1ec](https://github.com/babariviere/pilot/commit/c4eb1ec6cc777c69e4474eb7a61b47b1e7888e14))
* **macos:** add command-arrow navigation history ([4bc18f0](https://github.com/babariviere/pilot/commit/4bc18f0dfb603056247d69cd740d0def23989830))
* **macos:** add keyboard lists to Home, Overview, Inbox and Archive ([8528dbd](https://github.com/babariviere/pilot/commit/8528dbde22721aefb2e1d3bb27567446d9eaf9af))
* **macos:** add keyboard navigation to mission pages ([ed99205](https://github.com/babariviere/pilot/commit/ed992056f954afb7420ef0771a22883faac85a4d))
* **macos:** add keyboard regions, focus keys and Go navigation ([90a0a27](https://github.com/babariviere/pilot/commit/90a0a27d95c18d0a252b3c1c6602cb1cb245621b))
* **macos:** add quick jumps to Slack triage and the Linear queue ([b45735d](https://github.com/babariviere/pilot/commit/b45735d8089484f5ddb7ed36863155751ff31924))
* **macos:** add slash commands that open existing controls ([fee218f](https://github.com/babariviere/pilot/commit/fee218f10fa1db53305835ad410192e49135744c))
* **macos:** draw Mermaid diagrams natively in chat ([ba3b89d](https://github.com/babariviere/pilot/commit/ba3b89dc73bdbdf936aaf830d6b2faf091450d43))
* **macos:** give Slack triage and memory the page focus ([71d57eb](https://github.com/babariviere/pilot/commit/71d57eb3ffa032b1cad9edae795ea5c54653dd73))
* **macos:** give the control chat its own identity ([647d189](https://github.com/babariviere/pilot/commit/647d189764eec24a30d60ccfd6f636cda78aac97))
* **macos:** lead the palette with places and make shortcuts searchable ([c0d3cb6](https://github.com/babariviere/pilot/commit/c0d3cb6869210c94e25e8e4387bbbe4edd23ecb1))
* **macos:** make inline artifacts interactive in chat ([c55844c](https://github.com/babariviere/pilot/commit/c55844c822f2ed32f799bb48ff3189b4e9edf831))
* **macos:** make terminal and artifact focus safe to leave ([098ab7b](https://github.com/babariviere/pilot/commit/098ab7b3485982cb97fdd0047c78f5d6a9e1bf5e))
* **macos:** navigate Settings pages from the keyboard ([86608f6](https://github.com/babariviere/pilot/commit/86608f6096ff9090b6c3e4be83709f92a3b1504b))
* **macos:** navigate transcript messages and inspector lists with the keyboard ([91ba34e](https://github.com/babariviere/pilot/commit/91ba34e363106a1a92b0f9f5a71d8537f3930c13))
* **macos:** pace streamed text fade-in by word run ([2de1fb0](https://github.com/babariviere/pilot/commit/2de1fb0bc19e469aabedc4631f82c0e8d7ad60bd))
* **macos:** reach composer controls and stop from the keyboard ([7012fe6](https://github.com/babariviere/pilot/commit/7012fe62fb9cd106cb27f10ad4235096eed95002))
* **macos:** reach tray lists, timed scheduling and row actions from the keyboard ([4e25c94](https://github.com/babariviere/pilot/commit/4e25c9449506f262f1da84d56eea37773e916de8))
* **macos:** show the control chat's watches and actions ([873eb12](https://github.com/babariviere/pilot/commit/873eb12394fb5187a725e3704243f974e3096256))
* **macos:** show the working line above the composer ([ad3ae26](https://github.com/babariviere/pilot/commit/ad3ae268f920bfb5cbafe9347cbf386ca99abbfe))


### Bug Fixes

* **chat:** reset cached qualified feeds when reopening ([8ba8d1c](https://github.com/babariviere/pilot/commit/8ba8d1cef7fc63a26cdb1fbaea87c217984715bc))
* **chat:** show complete tool code before highlighting finishes ([019169d](https://github.com/babariviere/pilot/commit/019169d134fb09820ffdd215107cb52272b3aaf3))
* **daemon:** don't stall mission store shutdown when its saver can't open the file ([a969886](https://github.com/babariviere/pilot/commit/a96988653283b2157414dbf6777ea22a72a5cd07))
* **daemon:** drain lifecycle writes before spawn rollback ([73b39ab](https://github.com/babariviere/pilot/commit/73b39ab6148b48d2484911617dc9d9ed051ce6d3))
* **daemon:** preserve proposal outcome notices ([5e91830](https://github.com/babariviere/pilot/commit/5e91830c86673cb5f8d0d0215ae78032a05dd075))
* **daemon:** suppress self-directed notices ([0e8ccf2](https://github.com/babariviere/pilot/commit/0e8ccf23d73b0087c88b37261c3dea293ef114e3))
* **devbox:** load SSH helper from packaged resources ([e3e5d54](https://github.com/babariviere/pilot/commit/e3e5d5413cfa53973dca71a55234b80e4e02b34e))
* **macos:** accept arrow keys that carry keypad flags in keyboard lists ([6b6c56c](https://github.com/babariviere/pilot/commit/6b6c56c83dd561600c159f078468b1c55b0196ba))
* **macos:** accept arrow keys that carry keypad flags in the transcript ([db602dd](https://github.com/babariviere/pilot/commit/db602dd39067b9bff65b43b6cae1a966f10d2962))
* **macos:** keep daemon cwd outside replaceable app bundle ([b2c872c](https://github.com/babariviere/pilot/commit/b2c872cea43408ff62b90230fee77f22f79a7c3d))
* **macos:** keep diagrams at natural size and remember artifact sizes ([d7f73e0](https://github.com/babariviere/pilot/commit/d7f73e0091050a7979629ef6a79b0de80029b78a))
* **macos:** keep the chat pinned while replies stream fast ([88880e4](https://github.com/babariviere/pilot/commit/88880e4b7ffc949627d56486f8b2be8f3d318fea))
* **sessions:** show chats as working during compaction ([60a9c7c](https://github.com/babariviere/pilot/commit/60a9c7cc817705556677b535034e67e03048b896))


### Performance Improvements

* **control:** bound retained transcript preparation ([2167802](https://github.com/babariviere/pilot/commit/216780298b9231c7d4d10bccb1cd01e0c5b271df))

## [1.45.1](https://github.com/babariviere/pilot/compare/v1.45.0...v1.45.1) (2026-10-17)


### Bug Fixes

* **macos:** prevent terminal layout feedback loops ([03b5a39](https://github.com/babariviere/pilot/commit/03b5a39326441cdddb42538936768b5120219419))
* **pr:** detect creation before a later shell failure ([6d32684](https://github.com/babariviere/pilot/commit/6d32684339257a6d74b5621822226430d00cfd34))
* **sessions:** allow stopping failed subagent recovery ([c95be86](https://github.com/babariviere/pilot/commit/c95be863631eacb1e33a2e162f31587c989f5828))
* **sessions:** keep automatic input behind recovery Stop ([c66276e](https://github.com/babariviere/pilot/commit/c66276e93e0bf3d423fc4d0bb600e330f0afaa29))
* **sessions:** type the stopped admission rejection ([a161f46](https://github.com/babariviere/pilot/commit/a161f46ea593a110c2208e2b5207cf5e00f27f21))

## [1.45.0](https://github.com/babariviere/pilot/compare/v1.44.0...v1.45.0) (2026-10-17)


### Features

* **control:** add zoom and date memory tools ([4b69f45](https://github.com/babariviere/pilot/commit/4b69f45f13d26558ea7add6588cbf87e2fa7116a))
* **control:** attach accepted idle chats to missions ([e38914c](https://github.com/babariviere/pilot/commit/e38914ce4b5611e1633e1d560068845eeadc9eaf))
* **control:** compact chat memory in the background ([246c86e](https://github.com/babariviere/pilot/commit/246c86e79aabfb75ad6d82168f6221e5310a19b4))
* **control:** create requested missions and start their lead ([fbd5da1](https://github.com/babariviere/pilot/commit/fbd5da1ca5037f32494a8818616a340ca2606279))
* **control:** persist chat log, summary tree and view ([19cf17f](https://github.com/babariviere/pilot/commit/19cf17ff26d0af0586de6adc10892859d63995ea))
* **control:** read and append memory across projects ([9ac2ec7](https://github.com/babariviere/pilot/commit/9ac2ec760cfb1501760c6b7c719b22ebd12ef068))
* **control:** read global status and quoted chat results ([8de3adb](https://github.com/babariviere/pilot/commit/8de3adb470292bf058b7d31fe934550da9226aa0))
* **control:** run project-less turns from saved memory ([60307e3](https://github.com/babariviere/pilot/commit/60307e3876f2d55d46716298dd10df13ffd6df15))
* **control:** start and send work with durable audit records ([fb433e6](https://github.com/babariviere/pilot/commit/fb433e696a19f63bbec2376588850f27ce44e793))
* **devboxes:** show machine state and specifications ([215070c](https://github.com/babariviere/pilot/commit/215070c9506a11dfd577c5199d862b674be908aa))
* **inspection:** add separate versioned analysis records ([d3bc8ad](https://github.com/babariviere/pilot/commit/d3bc8adfde79e78ed9d2772749918d64fe64a3e7))
* **inspection:** enforce retention and linked erasure ([9c08439](https://github.com/babariviere/pilot/commit/9c08439d84dde46a76b261690d076d62ee868f32))
* **inspection:** reserve durable consent and usage ([25236d3](https://github.com/babariviere/pilot/commit/25236d34d9e9e504d84799863780f0cbf83fb417))
* **inspection:** restrict analysis to sealed evidence tools ([5a0d74a](https://github.com/babariviere/pilot/commit/5a0d74a631920d3efee54a1263cbbd6121f540be))
* **inspection:** seal private immutable evidence ([cfa9432](https://github.com/babariviere/pilot/commit/cfa9432d46865107238c6d7ace2b0a6b0ff8decd))
* **macos:** fade in newly streamed text ([b35c7ac](https://github.com/babariviere/pilot/commit/b35c7ac23d37ed020882d281a92474c798f361dd))
* **macos:** shimmer running tool titles and reveal opened steps ([e488186](https://github.com/babariviere/pilot/commit/e4881866ca3b0f72efed3fe7f4e74370eff5ab81))
* **watches:** add bounded off-thread subscription storage ([a2c04ee](https://github.com/babariviere/pilot/commit/a2c04ee34097c106d12186242b37f60c3f61b650))
* **watches:** consume durable task and mission completions ([279f49c](https://github.com/babariviere/pilot/commit/279f49ce756ea4a08e14d1aa771f239a891a4064))
* **watches:** deliver durable chat lifecycle notices ([af227fa](https://github.com/babariviere/pilot/commit/af227fa8c747a05065239f463b6ea84d036db5da))
* **watches:** observe completed Linear issues ([9e9e1f5](https://github.com/babariviere/pilot/commit/9e9e1f5f3a00d13549175c59b99fd3b0185539ba))
* **watches:** observe pull request state transitions ([e33ccd8](https://github.com/babariviere/pilot/commit/e33ccd8e321c007bad8781ad566df5b341360429))


### Bug Fixes

* **deps:** update Pi SDK to 1.3.0 ([eccc315](https://github.com/babariviere/pilot/commit/eccc3152c2ade0f026e7e93ae9da76f1f7dd55b6))
* **macos:** anchor Add devbox sheet to its settings section ([066de40](https://github.com/babariviere/pilot/commit/066de4093c86db6a9fdd29c802c86e49fe23d0c8))
* **macos:** initialize the default client on the main actor ([fdafcaa](https://github.com/babariviere/pilot/commit/fdafcaa9bdec0fc1115d1e4f74f145865d66cf12))
* **macos:** stop local chats from qualified references ([9aa3f7f](https://github.com/babariviere/pilot/commit/9aa3f7f0de70bdbb85b328458e7cd06f8c2a6889))
* **notices:** preserve authoritative idle admission ([fa51ed1](https://github.com/babariviere/pilot/commit/fa51ed14f0be3a9f83d877f9db4d13055d7f3afa))
* **watches:** separate frozen and later event batches ([b6d25ba](https://github.com/babariviere/pilot/commit/b6d25ba2d02b5007fcde083cf11c65fcb9bb5f44))


### Performance Improvements

* **macos:** add a release streaming benchmark with signposts ([021da76](https://github.com/babariviere/pilot/commit/021da764ddf787172b3e77befb216ad5ca0e15c0))
* **macos:** append streamed text without re-laying out its block ([c856330](https://github.com/babariviere/pilot/commit/c85633084c1f73890216943d3ac35eb927c7c2a0))
* **macos:** play receding sidebar corners on Core Animation ([b91f9c8](https://github.com/babariviere/pilot/commit/b91f9c8ee577d8cb6aba4aaa31db5b5ad7bad195))
* **macos:** play spinners and the composer corner on Core Animation ([927f87b](https://github.com/babariviere/pilot/commit/927f87b46f7d323ac4b114913c52b82aee39122b))
* **macos:** prepare only the newest Markdown blocks while streaming ([8642c39](https://github.com/babariviere/pilot/commit/8642c398d147ba0d37de937afeaea648b25c9910))
* **macos:** re-evaluate only transcript rows per streamed update ([cc7470b](https://github.com/babariviere/pilot/commit/cc7470b0e3b77eb05d3a86d59ce9dcae1bded1d6))

## [1.44.0](https://github.com/babariviere/pilot/compare/v1.43.0...v1.44.0) (2026-10-16)


### Features

* **macos:** remove the Home heading above the composer ([05fc0c9](https://github.com/babariviere/pilot/commit/05fc0c9fe06fae92c23da9c937b3e177e209a365))
* **macos:** shorten Home summary to a count line ([fd5c246](https://github.com/babariviere/pilot/commit/fd5c24694aa48372315a517c7507be74e19edfbe))


### Bug Fixes

* **artifacts:** release idle build helpers before updates ([0fd9562](https://github.com/babariviere/pilot/commit/0fd9562668a2c28c9cbff0ee67cd20a1949a2059))
* **slack:** read mention-only channels from history instead of search ([bee47ac](https://github.com/babariviere/pilot/commit/bee47ac1a01a34aa19da6dd0f63921ddec40375e))
* take chats with a scheduled message out of Needs you ([cab407f](https://github.com/babariviere/pilot/commit/cab407fe15e01bd8e0a113a5d857554e56efcf41))

## [1.43.0](https://github.com/babariviere/pilot/compare/v1.42.0...v1.43.0) (2026-10-16)


### Features

* **chat:** add Go to project to chat menus ([6ad175f](https://github.com/babariviere/pilot/commit/6ad175f9158b4035709fd3765835b2d7075418b1))
* **chat:** add Home to the project picker ([9fe5480](https://github.com/babariviere/pilot/commit/9fe5480e753c2fc73418d2c7868349732907c732))
* **chats:** open chat links from coordinator replies ([173f5f4](https://github.com/babariviere/pilot/commit/173f5f44b2ae573e328f68bf434055ba804cbe4c))
* **context:** expose shared notes and tasks to the app ([78ba711](https://github.com/babariviere/pilot/commit/78ba7116b47d151fbc93e2fb88d12a0ede2acffe))
* let agents query a project's Postgres databases ([c7f1b81](https://github.com/babariviere/pilot/commit/c7f1b81b62d5c1fe247b82a59b2a062123336878))
* **linear:** add Canceled and Duplicated state mappings ([e49a850](https://github.com/babariviere/pilot/commit/e49a85085a28a2e1e745d86ed69b39b094b5f5a8))
* **linear:** associate tickets with existing and split work ([27b2803](https://github.com/babariviere/pilot/commit/27b28032a3c89d59b33d89e913783d3d1aa25c26))
* **linear:** check closing directives against remaining work ([684e46e](https://github.com/babariviere/pilot/commit/684e46e1849db7996d6d525766b12ca90a2e9a0c))
* **linear:** expose ticket synchronization status ([dec6bc4](https://github.com/babariviere/pilot/commit/dec6bc4c7823e3a68dcb621d6950429030543c60))
* **linear:** keep ticket status in step with contributing work ([2cfb8db](https://github.com/babariviere/pilot/commit/2cfb8db3afbd02ce5e37ca57ac5c614201acbd27))
* **linear:** store managed tickets and task contributions ([bb5c7c7](https://github.com/babariviere/pilot/commit/bb5c7c70af5ee7b098bc7936bdf94a99ded0c835))
* **macos:** add a keyboard shortcuts reference ([53f6f4d](https://github.com/babariviere/pilot/commit/53f6f4d5fd9d0d9ce18398464507ecf1a748e348))
* **macos:** add devbox setup and unified remote chats ([cae3a72](https://github.com/babariviere/pilot/commit/cae3a723012d21584697ef1e13616fa304aa4b18))
* **macos:** mark remote chats with a neutral badge ([a38b86d](https://github.com/babariviere/pilot/commit/a38b86d6c8359b02cff2b109ae7fbf82c8d01218))
* **macos:** open the coordinator from the mission title ([26763c8](https://github.com/babariviere/pilot/commit/26763c836c38e3e1ccf6c670b6acbad714565c6d))
* **macos:** show sent messages instantly with a send animation ([3fc6e16](https://github.com/babariviere/pilot/commit/3fc6e16546d1b527131f8b3a95698bc1eee3bb94))
* **prs:** recognize more gh pr create forms, with a timed branch fallback ([04ebd83](https://github.com/babariviere/pilot/commit/04ebd83bb150e62f66bbb1fdecd10096dc1e96e9))
* **slack:** add Waiting status that resumes chats on thread replies ([fc6257a](https://github.com/babariviere/pilot/commit/fc6257a676c97bdfaf4410facb5bde0726b65a2c))


### Bug Fixes

* **branches:** attach a chat's branch and PRs only from the agent's own writes ([8e1d8a0](https://github.com/babariviere/pilot/commit/8e1d8a0a5c0c4f9b4d3ec5b2756f1e42b0972839))
* **chats:** keep saved history visible after startup fails ([176baec](https://github.com/babariviere/pilot/commit/176baec26439e2cf627f4de55c0da342f2159f6c))
* **connectivity:** check the provider server before declaring an outage ([f9fc3a2](https://github.com/babariviere/pilot/commit/f9fc3a26df33abd7c571e2e7bca75b92880557f3))
* **connectivity:** pause agents only on evidence of an outage ([1e8faac](https://github.com/babariviere/pilot/commit/1e8faacaf935171c5e4b8b078692cd6e28ece165))
* **connectivity:** tolerate an unreachable probe host ([6698da5](https://github.com/babariviere/pilot/commit/6698da5eb04233a32926e0f29b193d47fdbaada1))
* **connectivity:** write provider hints atomically ([b6ccef5](https://github.com/babariviere/pilot/commit/b6ccef5bac841106baef71bab21cb5e7e95c8b75))
* **deps:** update dependency playwright to v1.64.1 ([bf926c3](https://github.com/babariviere/pilot/commit/bf926c357edc56d447eca5719a66fbc55d88726a))
* **deps:** update react monorepo to v19.3.1 ([119f399](https://github.com/babariviere/pilot/commit/119f399685e91a48f2d26083ae550b8a6f8ac34a))
* grant database access only from the app's decision, never from a message ([7d91b6e](https://github.com/babariviere/pilot/commit/7d91b6edd4c95edd006e54016da411a047ec7dfd))
* **linear:** bound canonical ticket identities ([7ea66a1](https://github.com/babariviere/pilot/commit/7ea66a17697bcb867b971cd7e23a4339308bcf9e))
* **linear:** count sync issues and repair migration fixture ([0666ba4](https://github.com/babariviere/pilot/commit/0666ba4e44d43b1f328af3aaab0cdfbf12fbcecc))
* **linear:** retain terminal observations while paused ([46420cf](https://github.com/babariviere/pilot/commit/46420cfc2e45d070718bad068e9932682f8ebd83))
* **macos:** clear project pages within their state owner ([fed701b](https://github.com/babariviere/pilot/commit/fed701b54431b4b246113f252b852edc73f05403))
* **macos:** keep native navigation on the owning devbox ([6ab39b1](https://github.com/babariviere/pilot/commit/6ab39b1b56ff55ce7f9e358cc980232c3424ab63))
* **macos:** keep remote folder and recovery choices on their host ([dea26d9](https://github.com/babariviere/pilot/commit/dea26d949352701ec2085e12e8ece90c2c346615))
* **macos:** line up the New mission button with the sidebar icons ([947da59](https://github.com/babariviere/pilot/commit/947da59e9382bee419cfe573da77aca61f31ff9b))
* **macos:** open the project on the chat host ([f1de06b](https://github.com/babariviere/pilot/commit/f1de06ba16a48b25f41b176786ee446e4dafe986))
* **macos:** paint a neutral background behind the chat in dark mode ([c9e4a54](https://github.com/babariviere/pilot/commit/c9e4a54e78684aa38c9098bed66cc2586f7c8927))
* **macos:** pass the host client to link actions ([ac8db85](https://github.com/babariviere/pilot/commit/ac8db850b8c091d713763b4223b14321a8c47772))
* **macos:** qualify archive and secondary chat actions ([59fb2b2](https://github.com/babariviere/pilot/commit/59fb2b2feae6e441f4022241724811006b4d82f5))
* **macos:** resolve host-aware action compile errors ([932b14b](https://github.com/babariviere/pilot/commit/932b14b1ec705ae4c68d0a7d3dbae4de1aabdaad))
* **macos:** restore local overview navigation and update stale tests ([c5921b0](https://github.com/babariviere/pilot/commit/c5921b0f2d0c87bb067f6df167a64f364ce95f7e))
* **macos:** show finished subagents as done, not as new answers ([15381a9](https://github.com/babariviere/pilot/commit/15381a9c320e0ca36aa67c71bc9fa591ce3d0c8c))
* **macos:** show task status menu items as text only ([f6b0524](https://github.com/babariviere/pilot/commit/f6b0524176eb8ccfc1a340eafa78acf9fae1c8c7))
* **macos:** show the coordinator button without a background ([7005163](https://github.com/babariviere/pilot/commit/7005163a50b97c8d1bc8fd329e5d6c46e3aa66c0))
* **macos:** simplify shared memory view type inference ([3273489](https://github.com/babariviere/pilot/commit/32734897e5e51545134f078be7f85d584bdd2f67))
* **macos:** simplify the mission toolbar button ([712b2b1](https://github.com/babariviere/pilot/commit/712b2b1876dcb3f6b7474505ed158f218bc14e17))
* **slack:** keep hidden labels scoped to unmentioned threads ([1b3c781](https://github.com/babariviere/pilot/commit/1b3c781dc371c5bd34ac7dc683851083d7155342))
* **slack:** keep mentioned threads visible ([05048ec](https://github.com/babariviere/pilot/commit/05048ec4e3e449ffaaaa6e22a5008de6112c1094))


### Performance Improvements

* **models:** share model discovery through the daemon ([41cbe34](https://github.com/babariviere/pilot/commit/41cbe3457787629f04130dd7f6ca0b75bc0c9900))

## [1.42.0](https://github.com/babariviere/pilot/compare/v1.41.0...v1.42.0) (2026-10-16)


### Features

* **updates:** safely update a devbox without stopping live work ([1485427](https://github.com/babariviere/pilot/commit/1485427443cd6080c1ccc81153b8ab2bab31b88e))


### Bug Fixes

* **startup:** serialize catalogs and batch mission recovery ([e957d4a](https://github.com/babariviere/pilot/commit/e957d4a8038bccd6ffbc51f2e7ce74cc24fb53f4))
* **updates:** use the right user service environment ([965ff12](https://github.com/babariviere/pilot/commit/965ff12b706d8edf1549d93e9c8a1c7b8a5d567b))

## [1.41.0](https://github.com/babariviere/pilot/compare/v1.40.0...v1.41.0) (2026-10-16)


### Features

* **auth:** add independent pre-chat credential setup ([7954722](https://github.com/babariviere/pilot/commit/795472248fed87024dd77adc13c571374adfa78f))
* **macos:** add dark mode with appearance-aware theme tokens ([ca2cf74](https://github.com/babariviere/pilot/commit/ca2cf74762643b0d3e4e3a743b043b39ac0b934d))
* **macos:** find archived chats from search and the command palette ([30e5c80](https://github.com/babariviere/pilot/commit/30e5c804bcd655206cf4c3a71d0e684c9e49b9f5))
* **macos:** keep shared notes and tasks in sync ([75ca24c](https://github.com/babariviere/pilot/commit/75ca24c86f20cfccf5869797a444f8733cc0f19d))
* **macos:** list tasks and subagents with their state in the composer tray ([a3eb5fe](https://github.com/babariviere/pilot/commit/a3eb5feefde069ca883b8466c46436a384f04f4e))
* **macos:** open project repositories on GitHub ([8ca66d6](https://github.com/babariviere/pilot/commit/8ca66d6f9370bd3b1edfb6ecc63dc19955b8ff68))
* **macos:** preserve independent remote lifecycle and offline summaries ([81c8c0e](https://github.com/babariviere/pilot/commit/81c8c0e01843138014a612b80ca6236bdd6f2e53))
* **macos:** show more of the Home sky ([48e7a1f](https://github.com/babariviere/pilot/commit/48e7a1f46be6c826e1f208d8e137a398fe690cbd))
* **macos:** show subagent model and thinking in the header ([f43c08a](https://github.com/babariviere/pilot/commit/f43c08a9c6ece9919ddfdba7ce52ea0ea4934762))
* **macos:** use day and night ocean scenes on Home ([b66524a](https://github.com/babariviere/pilot/commit/b66524aff87e4b0a4688217b56507e54db82608f))
* **memory:** share saved project notes safely ([6a794eb](https://github.com/babariviere/pilot/commit/6a794ebd72c0bfc248bcc97b521e439c9544ba93))
* **palette:** add confirmed pull request merges ([8521e03](https://github.com/babariviere/pilot/commit/8521e0347eb01b360048afcb0abd2a1ddf8d48bb))
* **palette:** bind merge confirmation to Cmd-Shift-M ([b832b68](https://github.com/babariviere/pilot/commit/b832b683e47883d8bd6a1926f37a3a361550e41b))
* **tasks:** let work continue on another computer ([9fc0c65](https://github.com/babariviere/pilot/commit/9fc0c65f011d712f1d656838cd49e04307a10b9e))
* **terminal:** route bounded workspace shells by host ([2802ee4](https://github.com/babariviere/pilot/commit/2802ee480108b13059d9bb79f6cced6022f02689))


### Bug Fixes

* **ci:** keep Sparkle build versions above the pre-rename release ([26f9b88](https://github.com/babariviere/pilot/commit/26f9b8890efe00d7176c6c233a623e947a72f0c2))
* **kernel:** recover chats after image tools fail ([0cd30b9](https://github.com/babariviere/pilot/commit/0cd30b9ddf86bfd913efec656d600f8e947a2b87))
* **macos:** clip status corners to their surface bounds ([ec5dd70](https://github.com/babariviere/pilot/commit/ec5dd702f09ac795ad5b7cf802d70b6de5503511))
* **macos:** integrate mission navigation into the chat toolbar ([5d04f23](https://github.com/babariviere/pilot/commit/5d04f23e490e46d7891cb506ca4f58bfef6bfc62))
* **macos:** keep chat inspectors compact by default ([b8effd0](https://github.com/babariviere/pilot/commit/b8effd031d2bcc39690c1b4ebfbd74e18669c9f2))
* **macos:** send scheduled times as whole milliseconds ([781f7de](https://github.com/babariviere/pilot/commit/781f7dea9d0fb02ba6f238975b8983598cc1b2e6))

## [1.40.0](https://github.com/babariviere/pilot/compare/v1.39.0...v1.40.0) (2026-10-16)


### Features

* **kernel:** compact long cold chats before the next user message ([8fe073a](https://github.com/babariviere/pilot/commit/8fe073ad31f5b4b8167cd6718e1fe52aa6991478))
* **macos:** open the open chat's latest PR with ⌘⇧P ([b7dff9f](https://github.com/babariviere/pilot/commit/b7dff9f728c19a42c5f586499bfdd747f2d897d3))
* **macos:** quote tracked tickets as Markdown and let composers grow with the window ([488ac0a](https://github.com/babariviere/pilot/commit/488ac0a3639004f1b0ad9ed3edb301a1e81d10fb))
* **macos:** render user messages as Markdown ([70dbe78](https://github.com/babariviere/pilot/commit/70dbe78c9b4221a0f3e22117982256286637b938))
* **macos:** show attempt number on PR follow-up events ([0d54608](https://github.com/babariviere/pilot/commit/0d54608ebb405de8aa0baf13c5e1fe5b9115666d))
* **ssh:** bootstrap the verified Linux runtime safely ([873f10a](https://github.com/babariviere/pilot/commit/873f10a79ad41c20bf1c66d81a77af5121a6dc0b))
* **tracking:** add Slack messages to triage by link and search reports ([1e65d54](https://github.com/babariviere/pilot/commit/1e65d548f71b362ecb25da507f61aef37e011389))


### Bug Fixes

* keep progress in tasks and reduce comment noise ([5d527a8](https://github.com/babariviere/pilot/commit/5d527a8bcb8bbe2905e901493787f9ae1c738453))
* **kernel:** tag automatic input in live message events ([c8c4cab](https://github.com/babariviere/pilot/commit/c8c4cab7faa27809b395a8df9b4eff16b1c1cc95))
* **macos:** keep the menu bar pilotd submenu open while chats work ([e3662ff](https://github.com/babariviere/pilot/commit/e3662ff44302bd18284a8f0a5d9282fadc325ee6))
* **macos:** make adding a Slack channel easier to find ([29e8e73](https://github.com/babariviere/pilot/commit/29e8e732c76714d88ad7134fb8940b44441c2b23))
* **slack:** remove eyes on Done through an opt-in MCP route ([893ec49](https://github.com/babariviere/pilot/commit/893ec493c6995d58d59f34fb798720604fe2864d))

## [1.39.0](https://github.com/babariviere/pilot/compare/v1.38.0...v1.39.0) (2026-10-16)


### Features

* **auth:** broker canonical credentials for isolated workers ([4648241](https://github.com/babariviere/pilot/commit/4648241bbf05f72f407eff4a0d82c3a475f550d6))
* **daemon:** isolate Linux coordinator processes with bubblewrap ([f4b2b9e](https://github.com/babariviere/pilot/commit/f4b2b9e958fba73b31c877be224359a8d3e6d5e6))
* **daemon:** support a headless Linux runtime handshake ([56bbf74](https://github.com/babariviere/pilot/commit/56bbf74c8ccedb3c489c1af22e0512b70cad6e5f))
* **delivery:** reserve durable operations and recover stable admissions ([2873d05](https://github.com/babariviere/pilot/commit/2873d05609df684b4d3caa9878e80ce1957ae256))
* **linear:** classify issue size with correction learning ([474a364](https://github.com/babariviere/pilot/commit/474a36401d60d837cb2e3a05334913f680590abf))
* **macos:** add Slack common cases view, case actions and Overview top three ([79ceab2](https://github.com/babariviere/pilot/commit/79ceab21200dcece10047467a5f2606e6ea0bc90))
* **macos:** drag tasks to reorder and edit their dependencies ([cf11f47](https://github.com/babariviere/pilot/commit/cf11f47927bf79aa210e6fb6905a8bcace935955))
* **macos:** manage phases in the Tasks tab and show phase progress ([b26480a](https://github.com/babariviere/pilot/commit/b26480ab8d97410310f28ca5a5f005a06c58b1bd))
* **macos:** manage safe OpenSSH loopback forwarding ([8887591](https://github.com/babariviere/pilot/commit/88875911feb046951ba5a9cb0a76cb184672727a))
* **macos:** open inline artifact links in the viewer ([b337cf0](https://github.com/babariviere/pilot/commit/b337cf0a1a7850a3d336e83db3e154abc35bc756))
* **macos:** replace dot grid spinner with an ellipsis ([61d3cd6](https://github.com/babariviere/pilot/commit/61d3cd63ee4ae079146c7eb7b8d290b32ef5a2f5))
* **macos:** show clear in-chat pause notices ([1d95c2b](https://github.com/babariviere/pilot/commit/1d95c2bafd61ad454ed794d8e99f480dbda22d25))
* **macos:** show extra usage on Home ([80de1a7](https://github.com/babariviere/pilot/commit/80de1a7dccd0009d7ab7393f1291f399f3489d9f))
* **macos:** show Linear size chips and suggest Start mission for planning work ([30a943a](https://github.com/babariviere/pilot/commit/30a943ad5e6d9d1f44f6f62ced6e52e136b28246))
* **macos:** show Linear sub-issues under their parent ([1d10ab9](https://github.com/babariviere/pilot/commit/1d10ab9f69be0587624a6fcf8fa11535314b59ec))
* **macos:** show the Linear size guide and corrections in tracking settings ([baf182f](https://github.com/babariviere/pilot/commit/baf182f4640ba271b2cda173cbda72b7783014cc))
* **macos:** show the Slack triage guide with Rebuild in tracking settings ([1dacbd8](https://github.com/babariviere/pilot/commit/1dacbd83f8ffffa68c2e4bf47fd031c18d42f23a))
* **memory:** show project memory as a tree page ([8776398](https://github.com/babariviere/pilot/commit/87763986884a0777278227dc38c4aa331aa8bcb7))
* **missions:** add a preferred model per task ([2d8d6b2](https://github.com/babariviere/pilot/commit/2d8d6b26ab1eab42d4f361cc280c3a972c918ca0))
* **missions:** add start chat options for tasks ([cd294c1](https://github.com/babariviere/pilot/commit/cd294c1780bb4cc7c3f41ad2a0446005a04da237))
* **phases:** add ordered task phases and optional gating ([461a8c8](https://github.com/babariviere/pilot/commit/461a8c855cfbefa7ceff6c801a174303a49b1e4b))
* **repositories:** scope remote selection and file reads by host ([718be17](https://github.com/babariviere/pilot/commit/718be17488ab9a4f29bdb0ab794302ecd56a85dc))
* **routing:** add host-qualified endpoint and resource routing ([4423329](https://github.com/babariviere/pilot/commit/4423329ff54649acf5d1dfc7ca79e0637d074ed2))
* **routing:** persist qualified chat drafts and navigation identity ([af3cc5b](https://github.com/babariviere/pilot/commit/af3cc5b5e24786bbb9f056c4f6298802fa97ecc9))
* **slack:** group recurring reports into stable common cases ([f3a9f04](https://github.com/babariviere/pilot/commit/f3a9f04b92df405ab30b1d1b247e9514d157a7e7))
* **tracking:** groom corrections into scoped triage guides ([885f3d3](https://github.com/babariviere/pilot/commit/885f3d325f7b83a0b9f8a727607fbd720afdf75a))
* **tracking:** store Linear parent and resolve parent headers ([4f23a39](https://github.com/babariviere/pilot/commit/4f23a39796d0854e5718111dfd82502bc38c6321))
* **transfers:** stage remote images and pin artifact resources ([bb9964c](https://github.com/babariviere/pilot/commit/bb9964c7e84be78f6e5abc0aebdb72dd1ea45989))


### Bug Fixes

* **agents:** cover deferred retrieval and quiet paused chrome ([f79007b](https://github.com/babariviere/pilot/commit/f79007b5dfc010bfeb0698eb0343c24b9fc0292f))
* **agents:** pause recoverably when internet is unavailable ([72aaa1b](https://github.com/babariviere/pilot/commit/72aaa1ba8db404f1f980585f857224c186767613))
* **artifacts:** respect nested clipping when measuring height ([f77fe47](https://github.com/babariviere/pilot/commit/f77fe477b56452918c943ff59e692853370969a9))
* **auth:** fence revocation intents and preserve MCP store semantics ([79bc186](https://github.com/babariviere/pilot/commit/79bc186b5abe55d87d7114b3104e779222ec5a2a))
* **auth:** install broker hooks once across SDK loaders ([73a4e32](https://github.com/babariviere/pilot/commit/73a4e3248ccf75b39fb8099d3934de6a82f9a372))
* **ci:** isolate release writes from package verification ([2a7ee06](https://github.com/babariviere/pilot/commit/2a7ee062539fa43f08f2a867688f275e7085d979))
* **daemon:** avoid traversing unused legacy auth paths ([be2d4ee](https://github.com/babariviere/pilot/commit/be2d4eea8f457cbb7a27938ab92ed2ff020850e4))
* **daemon:** build chat titles from user and assistant text only ([cd854c8](https://github.com/babariviere/pilot/commit/cd854c8e56ab80ec1956266178a53dc618fe18ab))
* **daemon:** parse new Slack MCP formats and let manual sync skip error backoff ([658ffc1](https://github.com/babariviere/pilot/commit/658ffc1fcc08984911149abf069ba4c27db807e3))
* **daemon:** reject ancestor bind aliases before private writes ([bcfb4d0](https://github.com/babariviere/pilot/commit/bcfb4d03f0d532af0622253962b242cd81a9c344))
* **daemon:** reject mount aliases in writable coordinator state ([00a0f0c](https://github.com/babariviere/pilot/commit/00a0f0c7cbdba80a6546b54fb9a0ce8e146f3327))
* **daemon:** resolve coordinator trust before read-only launch ([01e35af](https://github.com/babariviere/pilot/commit/01e35af385e408b169d1ff008b36fc555d109a21))
* **daemon:** suggest rebasing PRs behind their target branch ([d4806e8](https://github.com/babariviere/pilot/commit/d4806e81bd6e0c9ae53f700d75c84166b323aa4f))
* **daemon:** verify accessible sandbox mount identities ([87b7e58](https://github.com/babariviere/pilot/commit/87b7e588b82aa6cf4ecd33594f727775b8a831cc))
* **delivery:** finish interrupted receipt cleanup during recovery ([7d7d881](https://github.com/babariviere/pilot/commit/7d7d881203ba9dfd2d8e74de59c6659444158e0e))
* **kernel:** pause on subscription exhaustion without failing ([65529e8](https://github.com/babariviere/pilot/commit/65529e8378d6adeb06384d1f368b48cd13569baa))
* **kernel:** read canonical settings without writable locks ([51ea453](https://github.com/babariviere/pilot/commit/51ea453b5e6b24a70eb430a7ec1d89020bb3252b))
* **kernel:** scope credential preloads to worker descendants ([2a5332d](https://github.com/babariviere/pilot/commit/2a5332da6981bcfac0ed4cb081a6f8b92a02437f))
* **linux:** provide native build tooling and failure-path checks ([f495f17](https://github.com/babariviere/pilot/commit/f495f17846b2736f976306693512f3b32b3402e6))
* **linux:** validate service paths and authenticate streamed archives ([3d2f3d2](https://github.com/babariviere/pilot/commit/3d2f3d27ef43ea4703a84db3f34fd7613f523deb))
* **macos:** apply the offline label font through Font ([3b1f9bb](https://github.com/babariviere/pilot/commit/3b1f9bbbf50274933359d3fcc39e9009d5968b26))
* **macos:** centralize artifact attachment symbol rendering ([36a0162](https://github.com/babariviere/pilot/commit/36a01620e4953dbd5d333e47bcaeb8f41ac8b9ec))
* **macos:** enlarge dot grid spinner to row-icon size ([efda85f](https://github.com/babariviere/pilot/commit/efda85fb9a1a7fb5c93f75e7f5a4733da8a544bf))
* **macos:** isolate artifact popup callbacks to the main actor ([bc6b8af](https://github.com/babariviere/pilot/commit/bc6b8afb9624b2ff0f8f91772a1ec514515cc5be))
* **macos:** keep mission task rows still on hover ([f514384](https://github.com/babariviere/pilot/commit/f514384bef50444bb51ed2c1be67a5f276b1c11c))
* **macos:** keep native task menu image labels concrete ([8cd2a81](https://github.com/babariviere/pilot/commit/8cd2a8157ca61a013b787c1b1d6f9d5a2ad84ca6))
* **macos:** mirror the in-review status pie ([381e92c](https://github.com/babariviere/pilot/commit/381e92c8741ced7521527e4bfd8b2c2e80c54da3))
* **macos:** omit redundant overall progress for phased work ([00613b9](https://github.com/babariviere/pilot/commit/00613b92958487fb7712291638de0756c1b4c4c0))
* **macos:** open Slack links at the right message ([3de4746](https://github.com/babariviere/pilot/commit/3de474645ec222a12fa726cc1d402a550a2db7f8))
* **macos:** preserve artifact size across renderer remounts ([a0f517e](https://github.com/babariviere/pilot/commit/a0f517e90a1fe1a88b8e8493c30209087a602869))
* **macos:** raise dot grid spinner contrast ([4ff4285](https://github.com/babariviere/pilot/commit/4ff4285caf952ae399776bac70b7d2b99057f33e))
* **macos:** restore phase progress to Overview ([a08b0a5](https://github.com/babariviere/pilot/commit/a08b0a5a8c7d2f0119f813fe0e26a0c9b21a7f1a))
* **macos:** show the result of MCP Check Now ([b49b451](https://github.com/babariviere/pilot/commit/b49b4510daafba1b9d5472196bd41e6dc529543a))
* **macos:** use native template images for all task menu icons ([d6be4ba](https://github.com/babariviere/pilot/commit/d6be4ba1c97da1a7304a71b8a01833ba8a3d6bc8))
* **macos:** use thirds for task progress and show menu icons ([b18fb80](https://github.com/babariviere/pilot/commit/b18fb800ecb6ed090e18c972aae03d3be8822b44))
* **power:** acknowledge sleep after durable preparation ([f9344c2](https://github.com/babariviere/pilot/commit/f9344c260280cee152b19e8be7f8eb13733f431d))
* **power:** leave screen locking to macOS ([688d331](https://github.com/babariviere/pilot/commit/688d331f41fe786c3beefa75bab5763f48732bbe))
* **routing:** replace endpoints and reattach subscriptions after SSH drops ([a11bcc0](https://github.com/babariviere/pilot/commit/a11bcc09554b6abcbb6366d5861899b7bece5bdd))
* **transfers:** fence disk faults and reject missing adopted image data ([41fee59](https://github.com/babariviere/pilot/commit/41fee597c648f8b00dfe70256ec928a26c2b8d47))
* **transfers:** inject isolated command transports into HTTP fixtures ([6015d47](https://github.com/babariviere/pilot/commit/6015d4769f05be0219c43a73654fe468dbfd45dd))


### Performance Improvements

* **daemon:** attribute event-loop stalls to CPU or waiting ([7d1283d](https://github.com/babariviere/pilot/commit/7d1283d7f6cc779f8758c61655b7ee78c9a88637))
* **daemon:** run the mission store in memory and save it off the event loop ([1b30a38](https://github.com/babariviere/pilot/commit/1b30a38c3b7235ad0a6f0572c400be9a4c0f4fdc))
* **macos:** retain the web-only link scanner fast path ([e380de9](https://github.com/babariviere/pilot/commit/e380de9c66c9ca73542bddd5d24a5c50bd226930))
* **macos:** run pilotd as an Interactive launchd agent ([4f384e0](https://github.com/babariviere/pilot/commit/4f384e061b676f80b9810e5f2795c8b8b698507d))
* **routing:** coalesce unified snapshots and test large chat lists ([22ad21d](https://github.com/babariviere/pilot/commit/22ad21db8cb02fad0c1adc92975ac3eec4bd9cb1))

## [1.38.0](https://github.com/babariviere/pilot/compare/v1.37.0...v1.38.0) (2026-10-15)


### Features

* **slack:** filter tracked threads by personal mentions ([8edbdfd](https://github.com/babariviere/pilot/commit/8edbdfd0925d401ffd950ddaa7745540529d3b81))


### Bug Fixes

* **daemon:** avoid repeating automatic PR review feedback ([8e769af](https://github.com/babariviere/pilot/commit/8e769af59c77847ca6f8be145d4fbc25964878de))
* **macos:** let user bubbles hug short messages ([7b09404](https://github.com/babariviere/pilot/commit/7b094049bff6ec9e0c1af78cd3e35282d51cdab2))
* **macos:** target Slack messages with native timestamp links ([60453b0](https://github.com/babariviere/pilot/commit/60453b09ffa9bb48180092d044a57aab43c5c5a5))
* **memory:** validate summaries and retain private diagnostics ([7e45587](https://github.com/babariviere/pilot/commit/7e455877af0fe9b4eafdcc4ade704fcafb6a42b7))
* **sessions:** accept Stop during sleep pauses ([3239ed3](https://github.com/babariviere/pilot/commit/3239ed39051c0f431b395f6f8cf51286ffac4a3c))

## [1.37.0](https://github.com/babariviere/pilot/compare/v1.36.1...v1.37.0) (2026-10-15)


### Features

* **linear:** save five per-team workflow state mappings ([d67ec37](https://github.com/babariviere/pilot/commit/d67ec379e059a98b4139f9d476028725f2d7a5dd))
* **macos:** Agents tab as one list with a detail view ([53a8777](https://github.com/babariviere/pilot/commit/53a877743eb427500570e44dba9f75e17388ebf2))
* **macos:** calmer mission Overview with one Links list ([7ceff50](https://github.com/babariviere/pilot/commit/7ceff50d97ec7867d3b3bc7307f0fd848015c6dc))
* **macos:** command palette (⌘K) ([60759fd](https://github.com/babariviere/pilot/commit/60759fdc4ca415a2622798fe8db647997c7a899d))
* **macos:** composer working corner and dot grid spinner ([562e778](https://github.com/babariviere/pilot/commit/562e778bcb3f40ed92db5223bd89916538b55d6f))
* **macos:** one aligned usage line per provider on Home ([d62d47a](https://github.com/babariviere/pilot/commit/d62d47a1714707a0a434463347672cf1369488e5))
* **macos:** open coordinator from project page mission rows ([8b01359](https://github.com/babariviere/pilot/commit/8b013596a82e929f8d4c6147307fa4d3d60cc055))
* **macos:** plain progress bars with status colours and a legend ([a2089e9](https://github.com/babariviere/pilot/commit/a2089e9e2997eb533df09ef2852ea242342091c7))
* **macos:** project folders head the picker and Home; sidebar always groups by urgency ([612da41](https://github.com/babariviere/pilot/commit/612da41860aac3de93efbc139a15a3d2ed00fad9))
* **macos:** reading-column archive, urgency menu bar and settings cleanup ([292df40](https://github.com/babariviere/pilot/commit/292df403dcb1c78ad7a72e4f51d5a759b92d82e0))
* **macos:** restyle settings as a reading column with hairline rows ([adc2d9a](https://github.com/babariviere/pilot/commit/adc2d9ab48ebe2f0ab1ea50c05f0453e1c1eaa95))
* **macos:** show unsent drafts on chat rows ([85289c0](https://github.com/babariviere/pilot/commit/85289c061d5608f5091efc175b4140c4b6858420))
* **macos:** three-quarter circle for in-review status ([f17819b](https://github.com/babariviere/pilot/commit/f17819bbb8820c0a936f771150b35e2704b48301))
* show chats blocked on an MCP server under Needs you ([6717e5c](https://github.com/babariviere/pilot/commit/6717e5c0da174bc02f58ba0f7624bf0440969c09))
* show pi MCP server status and sign-in in Settings ([c716e1c](https://github.com/babariviere/pilot/commit/c716e1c483292382258ca065aa68aa870507ffb7))
* **todos:** store per-chat todos in durable session storage ([d255fe4](https://github.com/babariviere/pilot/commit/d255fe4fe38ca85989dc2744179e59c7b7872e6c))
* **tracking:** sync Slack done reactions ([ce6b8e6](https://github.com/babariviere/pilot/commit/ce6b8e6bcfb22abb397ac40f3ce40a604fead85e))
* **usage:** pause chats at subscription limits and continue safely ([8454c98](https://github.com/babariviere/pilot/commit/8454c98f49cc93a53f3da4bbc677a033722795b5))


### Bug Fixes

* **attention:** prefer ready PRs over unreviewed results ([466d629](https://github.com/babariviere/pilot/commit/466d6298d94deddf1de83be1c5f97c212a34f50c))
* **daemon:** rebase before failed CI follow-ups ([1c41f7e](https://github.com/babariviere/pilot/commit/1c41f7e723a299b77d4c498e37f2969b05da9a93))
* **daemon:** title chats after the first completed turn ([c6001c7](https://github.com/babariviere/pilot/commit/c6001c73cc3cebf14c2a9cfe6e9191eb63442c8b))
* **kernel:** queue input behind idle manual compaction ([143ad1d](https://github.com/babariviere/pilot/commit/143ad1d2277f3cc5c26c01bd3b7c5eb8e9aa2ce0))
* **linear:** configure per-team start workflow states ([f10df24](https://github.com/babariviere/pilot/commit/f10df24c7b39cc2f36c3991a41cf98f7a8aca34e))
* **macos:** avoid nested require macros in icon test ([2049877](https://github.com/babariviere/pilot/commit/2049877b81fa656c3fe977e6b6299da47228168c))
* **macos:** keep pending questions visible after compaction ([ebd2877](https://github.com/babariviere/pilot/commit/ebd2877af373eecd2573f866bb3cdc8b14bf4df3))
* **macos:** keep sidebar chat selection neutral ([c18e38f](https://github.com/babariviere/pilot/commit/c18e38fafe8373e712d34777b13cfcf489e6a651))
* **macos:** lock the session during closed-lid work ([776184c](https://github.com/babariviere/pilot/commit/776184c59f0f18fe551727fa7e0de8d8a4e7b728))
* **macos:** resolve row accessibility from the parent model ([415a72e](https://github.com/babariviere/pilot/commit/415a72e58c69a55c112215ac3dfb57dbb723641d))
* **macos:** show agent questions while background jobs run ([7eff5a8](https://github.com/babariviere/pilot/commit/7eff5a807d1c2e83053014b579d9993b05f86278))
* **macos:** supply the model to mission toolbar hosts ([a728d2b](https://github.com/babariviere/pilot/commit/a728d2bf5ad0fce7b668417cf78bc585819367c9))
* **macos:** use shared spinner for coordinator drafting ([cf2e10d](https://github.com/babariviere/pilot/commit/cf2e10de2275929e04089c1cbc49450534c962dc))
* **pr:** surface exhausted follow-ups in Needs you ([6f4f84d](https://github.com/babariviere/pilot/commit/6f4f84d5903fff57b77fab7c1f61a0255b0ad7c0))
* **usage:** preserve startup failures while input remains queued ([1fb6ad5](https://github.com/babariviere/pilot/commit/1fb6ad56d89bce2342573f57e81ffc781f0f44c1))


### Performance Improvements

* **metadata:** avoid eager PR details and sidebar diff scans ([856f93a](https://github.com/babariviere/pilot/commit/856f93a48a248fd2ff32d28cb37d01a285827a78))

## [1.36.1](https://github.com/babariviere/pilot/compare/v1.36.0...v1.36.1) (2026-10-15)


### Bug Fixes

* **macos:** give inline links soft title underlines ([8ccbeca](https://github.com/babariviere/pilot/commit/8ccbecab8be946d1e22e9d627ec7557516ad7ec3))

## [1.36.0](https://github.com/babariviere/pilot/compare/v1.35.1...v1.36.0) (2026-10-15)


### Features

* **macos:** render branded inline service links ([334f829](https://github.com/babariviere/pilot/commit/334f829d4307422d11b6db23625934a25bb21bc7))
* **tasks:** delegate linked work from Linear assignees ([56ca4cc](https://github.com/babariviere/pilot/commit/56ca4ccc8ec4fce8a9fd2006470673b6ffd85b1e))
* **tasks:** show delegated work quietly in task views ([8791634](https://github.com/babariviere/pilot/commit/87916344a2fd18edd554d7733dd06ebdb490f02c))
* **tracking:** add close effects to Slack labels ([dc548b8](https://github.com/babariviere/pilot/commit/dc548b8ca092a90871333a33d25da19129803692))
* **tracking:** finish Slack items after linked work completes ([c397e45](https://github.com/babariviere/pilot/commit/c397e45f14dad4ac60922a919f5f71991f75e8c1))
* **tracking:** react with eyes when Slack work starts ([fe26088](https://github.com/babariviere/pilot/commit/fe260881e06b8a11a482e137128ec9fe9ecf0150))


### Bug Fixes

* **daemon:** defer main refreshes during update preparation ([8a551ea](https://github.com/babariviere/pilot/commit/8a551ea7dfd4f32bf954ccadb09672e55e00cf98))
* **daemon:** recover pending work of idle parents ([dd1f94d](https://github.com/babariviere/pilot/commit/dd1f94d53dbd3ee694dbd4b1da38368ddd5f460d))
* **macos:** restore Copy Link in agent replies ([b1947e0](https://github.com/babariviere/pilot/commit/b1947e0b816ae5bd28b0989fa727b5f831a7c9a1))
* **macos:** seed copy source before link preparation ([41f19d9](https://github.com/babariviere/pilot/commit/41f19d947123170e7de3fc0e886e600f5eafbd64))

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
