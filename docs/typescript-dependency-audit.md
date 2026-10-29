# TypeScript dependency audit, 2026-10-29

## Inventory and boundaries

The root `package.json` and five `packages/*/package.json` manifests
(artifacts, daemon, kernel, protocol, telemetry) share `pnpm-workspace.yaml`
and one `pnpm-lock.yaml`. No other first-party npm manifests or npm/yarn
lockfiles were found. The Cargo workspaces are audited separately.

Preserved intentionally:
- pnpm 12.16.1, Node >=24, the locked TypeScript native-preview toolchain,
  root Node 24 types, and all internal app/package versions.
- Pi SDK family 1.4.0 and its coordinated overrides.
- The immutable pi-extensions fork at
  `8a7655ee43b87a7fd57290c2cf55e8b6eed3a056`.
- Both existing Pi patches: shared safe MCP config writes (SDK and bundled CLI,
  including removal of unused example lockfiles) and steer-first durable
  inbox boundaries.
  Extend the coding-agent patch narrowly to externalize the bundled CLI's Undici
  dispatcher binding, because lockfile overrides cannot replace bundled code.
- The Mermaid KaTeX 0.19.1 override and the existing `allowBuilds` script
  allowlist. No audit suppression, force fix, script bypass, package-manager
  change or lockfile deletion.

Both macOS and Linux runtime assembly copy these workspace manifests, lockfile
and patches, then install production dependencies with the hoisted linker and
`--frozen-lockfile`. The updates therefore cover bundled runtimes too.
This audit changes source dependencies, not an installed app or daemon.

## Before

`pnpm audit --json` and `pnpm audit --prod --json` both reported 11
advisories: 1 critical, 5 high, 4 moderate and 1 low. All are present in
production dependencies, not merely dev tools. The all-dependency audit also
contains a development route through daemon's pi-durable dependency.

| Advisory | Package before | Severity | First patched version |
| --- | --- | --- | --- |
| [GHSA-cg2g-xh64-v4q7](https://github.com/advisories/GHSA-cg2g-xh64-v4q7) | dompurify@3.4.16 | critical | >=3.4.17 |
| [GHSA-mrv2-3pqr-j5jr](https://github.com/advisories/GHSA-mrv2-3pqr-j5jr) | dompurify@3.4.16 | high | >=3.4.17 |
| [GHSA-c6gr-qvv4-5v3f](https://github.com/advisories/GHSA-c6gr-qvv4-5v3f) | dompurify@3.4.16 | low | >=3.4.17 |
| [GHSA-4qv8-2p9j-2685](https://github.com/advisories/GHSA-4qv8-2p9j-2685) | undici@8.10.2 | moderate | >=8.12.2 |
| [GHSA-f72v-6w45-q472](https://github.com/advisories/GHSA-f72v-6w45-q472) | undici@8.10.2 | moderate | >=8.12.2 |
| [GHSA-xjj6-f33q-929c](https://github.com/advisories/GHSA-xjj6-f33q-929c) | undici@8.10.2 | high | >=8.12.2 |
| [GHSA-4w7w-5xrc-9h26](https://github.com/advisories/GHSA-4w7w-5xrc-9h26) | undici@8.10.2 | high | >=8.12.2 |
| [GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) | undici@8.10.2 | high | >=8.12.2 |
| [GHSA-qrxm-fqhp-jwvm](https://github.com/advisories/GHSA-qrxm-fqhp-jwvm) | undici@8.10.2 | high | >=8.12.2 |
| [GHSA-9fm3-97px-rjf6](https://github.com/advisories/GHSA-9fm3-97px-rjf6) | undici@8.10.2 | moderate | >=8.12.2 |
| [GHSA-55wc-3pg8-jfw6](https://github.com/advisories/GHSA-55wc-3pg8-jfw6) | undici@8.10.2 | moderate | >=8.12.2 |

DOMPurify path (the same for all three advisories):

```text
packages__artifacts>mermaid>dompurify
```

Undici paths (the same for all eight advisories, verbatim from the all-dependency
audit; `packages__` is pnpm's workspace-path notation):

```text
packages__daemon>@earendil-works/pi-ai>openai>undici
packages__daemon>@earendil-works/pi-coding-agent>@earendil-works/pi-agent-core>@earendil-works/pi-ai>openai>undici
packages__daemon>@earendil-works/pi-coding-agent>@earendil-works/pi-ai>openai>undici
packages__daemon>@earendil-works/pi-coding-agent>undici
packages__daemon>@earendil-works/pi-durable>@earendil-works/pi-ai>openai>undici
packages__protocol>@earendil-works/pi-ai>openai>undici
packages__protocol>@earendil-works/pi-durable>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-agent-core>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-coding-agent>@earendil-works/pi-agent-core>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-coding-agent>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-coding-agent>undici
packages__kernel>@gotgenes/pi-anthropic-auth>@earendil-works/pi-coding-agent>@earendil-works/pi-agent-core>@earendil-works/pi-ai>openai>undici
packages__kernel>@gotgenes/pi-anthropic-auth>@earendil-works/pi-coding-agent>@earendil-works/pi-ai>openai>undici
packages__kernel>@gotgenes/pi-anthropic-auth>@earendil-works/pi-coding-agent>undici
packages__kernel>@gotgenes/pi-anthropic-auth>@earendil-works/pi-ai>openai>undici
packages__kernel>@babariviere/pi-extensions>@earendil-works/pi-ai>openai>undici
packages__kernel>@babariviere/pi-extensions>@earendil-works/pi-coding-agent>@earendil-works/pi-agent-core>@earendil-works/pi-ai>openai>undici
packages__kernel>@babariviere/pi-extensions>@earendil-works/pi-coding-agent>@earendil-works/pi-ai>openai>undici
packages__kernel>@babariviere/pi-extensions>@earendil-works/pi-coding-agent>undici
packages__kernel>@babariviere/pi-extensions>@earendil-works/pi-durable>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-ai>openai>undici
packages__kernel>@earendil-works/pi-durable>@earendil-works/pi-ai>openai>undici
```

The production audit reports 21 of these paths. Only
`packages__daemon>@earendil-works/pi-durable>@earendil-works/pi-ai>openai>undici`
is absent because daemon declares pi-durable as a dev dependency.
This does not make the other runtime paths safe.

## Updates and compatibility

The follow-up request to update all TS dependencies broadened this beyond the
initial security fixes. Every direct dependency was checked against the registry,
and all semver-compatible transitive dependencies were refreshed, excluding the
compiler/toolchain. Parent exact pins are not blindly overridden; Pi's vulnerable
Undici pin is the scoped security exception.

- DOMPurify 3.4.16 → 3.4.17 within Mermaid's existing `^3.4.12` range.
- Undici 8.10.2 → 8.12.3 with the scoped
  `@earendil-works/pi-coding-agent>undici` override. Pi 1.4.0 pins 8.10.2
  exactly, so a normal compatible refresh cannot fix it. OpenAI's optional
  peer (`>=5 <9`) resolves to the same fixed version. Undici's Node
  minimum remains >=22.19.0, below the existing Node 24 requirement.
  The prebuilt Pi CLI also embeds Undici implementation code outside pnpm's
  graph. Its sole root initializer is replaced with external `require("undici")`:
  the embedded definitions remain inert, with no invocation. The dispatcher now
  uses the same patched dependency as the SDK. No CLI/SDK entrypoint swap or
  networking policy change is involved. This deliberately extends, rather than
  replaces, the existing MCP safety patch.
- Motion 14.6.0 → 14.7.1, framer-motion and motion-dom to 14.7.1,
  motion-utils to 14.7.0.
- Replace deprecated OpenTelemetry sdk-trace-base/sdk-trace-node 2.12.0 with
  the consolidated sdk-trace 3.0.0 package. Use TracerProvider and the new batch
  constructor, keeping explicit resource/attribute/event/link limits, queue/batch
  limits, export/flush deadlines, manual parent propagation, exporter opt-in and
  no global/automatic instrumentation. This also removes the old trace chain's
  incompatible API peer constraints. No telemetry schema or destination changes.
- Refresh all other compatible graph entries, including AWS SDK credential
  providers, Smithy, Defuddle/LinkeDOM and supporting browser-library dependencies.
  Raise declared type floors to the already-resolved Node 24.19.2 and ws 8.18.2.
  Align the Biome schema URL with the existing 2.6.3 CLI.
- Correct stale artifact-library version metadata, and include Mermaid's
  resolved DOMPurify version in prebuilt bundle keys. Otherwise an unchanged
  Mermaid/esbuild key could reuse a bundle containing the old sanitizer.

Other direct packages are current within the retained compatibility policy.
`@types/node@26.6.5` is a different Node major, not a suitable update for
the retained Node 24 contract.
Some transitive type-only dependencies resolve Node 26 types under their own
existing ranges; the root compiler continues to use the Node 24 declarations.

### Full lockfile graph delta

All versions per changed package name are shown, including retained parallel
versions. A dash means the package name was removed or newly introduced.

| Package | Before | After |
| --- | --- | --- |
| @aws-sdk/core | 3.978.1 | 3.978.6 |
| @aws-sdk/credential-provider-env | 3.972.72 | 3.972.77 |
| @aws-sdk/credential-provider-http | 3.972.74 | 3.972.79 |
| @aws-sdk/credential-provider-ini | 3.973.17 | 3.973.22 |
| @aws-sdk/credential-provider-login | 3.972.79 | 3.972.84 |
| @aws-sdk/credential-provider-node | 3.972.84 | 3.972.89 |
| @aws-sdk/credential-provider-process | 3.972.72 | 3.972.77 |
| @aws-sdk/credential-provider-sso | 3.973.16 | 3.973.21 |
| @aws-sdk/credential-provider-web-identity | 3.972.78 | 3.972.83 |
| @aws-sdk/eventstream-handler-node | 3.972.35 | 3.972.39 |
| @aws-sdk/middleware-eventstream | 3.972.30 | 3.972.34 |
| @aws-sdk/middleware-websocket | 3.972.54 | 3.972.59 |
| @aws-sdk/nested-clients | 3.997.46 | 3.997.51 |
| @aws-sdk/signature-v4-multi-region | 3.996.47 | 3.996.49 |
| @aws-sdk/token-providers | 3.1127.0, 3.1138.0 | 3.1127.0, 3.1157.0 |
| @aws-sdk/types | 3.974.6 | 3.975.0 |
| @babel/runtime | 7.29.7 | 7.29.10 |
| @opentelemetry/context-async-hooks | 2.12.0 | — |
| @opentelemetry/core | 2.12.0, 3.0.0 | 3.0.0 |
| @opentelemetry/resources | 2.12.0, 3.0.0 | 3.0.0 |
| @opentelemetry/sdk-trace-base | 2.12.0 | — |
| @opentelemetry/sdk-trace-node | 2.12.0 | — |
| @opentelemetry/sdk-trace | 2.12.0, 3.0.0 | 3.0.0 |
| @smithy/core | 3.35.1 | 3.37.0 |
| @smithy/node-http-handler | 4.12.1 | 4.12.1, 4.13.0 |
| @types/node | 24.19.2 | 24.19.2, 26.6.5 |
| @types/retry | 0.12.0 | 0.12.0, 0.12.5 |
| bowser | 2.14.1 | 2.15.0 |
| cssom | 0.5.0 | — |
| cytoscape | 3.34.3 | 3.34.4 |
| defuddle | 0.19.5 | 0.19.6 |
| dompurify | 3.4.16 | 3.4.17 |
| es-toolkit | 1.52.0 | 1.53.0 |
| framer-motion | 14.6.0 | 14.7.1 |
| linkedom | 0.18.13 | 0.18.14 |
| motion-dom | 14.6.0 | 14.7.1 |
| motion-utils | 14.6.0 | 14.7.0 |
| motion | 14.6.0 | 14.7.1 |
| undici-types | 7.24.6 | 7.24.6, 8.9.0 |
| undici | 8.10.2 | 8.12.3 |
| uuid | 14.0.2 | 14.0.3 |
| yaml | 2.9.0 | 2.9.0, 2.9.1 |
| @acemir/cssom | — | 0.9.32 |

## After and remaining maintenance concerns

Fresh `pnpm audit --json`, `pnpm audit --prod --json` and
`pnpm audit --dev --json` each report **zero advisories**.
The all-dependency graph contains 384 dependencies, production 358, and the
separately selected development graph 111 (these selections overlap).
No remaining registry-reported vulnerable path or unfixed advisory was found.
A clean registry audit is not proof that all packages are maintained or that
no undisclosed vulnerability exists.

One deprecated package name remains: `node-domexception@1.0.0`, in favor
of native DOMException. The OpenTelemetry deprecations and peer mismatch have
been removed, not suppressed.

All exact routes are obtained from every Pi-AI route in the Undici list
above by replacing the terminal `>openai>undici` with each of these
versioned suffixes (both gaxios routes and both fetch-blob routes exist):

```text
>@google/genai@2.21.0>google-auth-library@10.9.1>gaxios@7.3.1>node-fetch@3.3.2>fetch-blob@3.2.0>node-domexception@1.0.0
>@google/genai@2.21.0>google-auth-library@10.9.1>gaxios@7.3.1>node-fetch@3.3.2>formdata-polyfill@4.0.10>fetch-blob@3.2.0>node-domexception@1.0.0
>@google/genai@2.21.0>google-auth-library@10.9.1>gcp-metadata@8.1.2>gaxios@7.3.1>node-fetch@3.3.2>fetch-blob@3.2.0>node-domexception@1.0.0
>@google/genai@2.21.0>google-auth-library@10.9.1>gcp-metadata@8.1.2>gaxios@7.3.1>node-fetch@3.3.2>formdata-polyfill@4.0.10>fetch-blob@3.2.0>node-domexception@1.0.0
```

Pi-AI is 1.4.0 everywhere above. The same production and daemon-dev roots
apply. Node-fetch 3.3.2 is current and still pulls fetch-blob 3.x, which
pulls this shim. Node-domexception 2.0.2 is also deprecated. Fetch-blob 4
and gaxios 8 are major versions, not safe blanket overrides for this task.
Removal requires upstream dependency migration; replacing the shim alone
would not address the deprecated design.

## Verification scope

- Frozen workspace installation, root TypeScript typecheck and scoped Biome
  lint/format: lock consistency and affected TS contracts.
- Artifact render tests: all offline library builds, Motion JSX compilation,
  exact provenance and sanitizer-aware cache invalidation.
- MCP setup and dependency-pin tests: preserve both SDK and bundled CLI writer
  behavior and verify the bundled dispatcher no longer initializes embedded Undici.
- Telemetry unit and daemon integration tests: preserve reviewed fields,
  privacy rejection, opt-in, parent propagation, bounded queues, revocation,
  failure handling and local-only protobuf transport fixtures.
- Kernel steering, model and bundled-extension integration tests: synthetic
  providers, transport mocks, durable queue behavior, auth and fork compatibility.
  Clear inherited `PILOT_*`, `PI_*` and `NODE_OPTIONS` for these fixtures,
  rather than connecting tests to the agent's credential broker.
- Isolated temporary production workspace: frozen hoisted install, all seven
  offline library builds, fixed sanitizer/Undici versions, both applied Pi
  patches, cached bundle loading and OTel 3 export/flush/shutdown. Lifecycle
  scripts still obey `allowBuilds`.

128 tests pass across the eleven selected files, with no skips. No full suite, Cargo
build, live provider request, installed runtime mutation or release action was
performed.
