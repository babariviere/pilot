#!/usr/bin/env bash
# Run after copying and again after ZIP extraction in CI to catch non-relocatable dependencies.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
runtime="$(cd "${1:?Usage: check-runtime.sh runtime}" && pwd)"
python3 "$here/scripts/release_metadata.py" symlinks "$runtime"
cd "$runtime"
./node/bin/node --import tsx --input-type=module <<'JS'
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
assert.equal(process.platform, 'darwin');
assert.equal(process.arch, 'arm64');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
await import('@pilot/kernel');
const { prepareArtifact, getLibrary } = await import('@pilot/artifacts');
const artifact = await prepareArtifact({
  title: 'Runtime smoke test',
  kind: 'react',
  source: 'export default function Artifact() { return <p>pilot-artifact-runtime-ok</p>; }',
});
assert.match(artifact.html, /artifact-root/);
assert.ok((await getLibrary('mermaid')).length > 0);
await import('ws');
const pty = createRequire(import.meta.url)('node-pty');
const terminal = pty.spawn('/bin/echo', ['pilot-runtime-ok'], { cwd: process.cwd(), env: process.env });
let output = '';
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Bundled node-pty smoke test timed out')), 10000);
  terminal.onData(data => { output += data; });
  terminal.onExit(({exitCode}) => { clearTimeout(timeout); exitCode === 0 ? resolve() : reject(new Error(`pty exit ${exitCode}`)); });
});
assert.match(output, /pilot-runtime-ok/);
JS
# Native dependencies must not need Homebrew or checkout-local shared libraries.
while IFS= read -r -d '' binary; do
	if file "$binary" | grep -q 'Mach-O'; then
		lipo "$binary" -verify_arch arm64
		otool -arch arm64 -L "$binary" | awk '/^[[:space:]]/{print $1}' | while IFS= read -r dependency; do
			case "$dependency" in
				@*|/usr/lib/*|/System/Library/*) ;;
				*) echo "Non-system runtime library: $dependency ($binary)" >&2; exit 1 ;;
			esac
		done
	fi
done < <(find "$runtime" -type f \( -name '*.node' -o -name '*.dylib' -o -perm -111 \) -print0)
