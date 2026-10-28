# Local dogfooding diagnostics

Settings → Diagnostics → Review capture freezes a JSON preview. Edit or remove
records/fields in the native editor, then choose Export reviewed… and a **new**
filename. Only those reviewed bytes are exported. Clear preview discards the
preview, not capture files. Closing Settings retains the preview in this process.
Nothing is sent to an agent or telemetry service. Sharing the exported file is a
separate explicit user action. Export errors retain edits; a write failure may
leave a partial file, which must be removed before sharing.

## Audit and implementation boundary

At introduction the desktop crate had Tokio and transitive `tracing`, but no
app-owned subscriber, spans or Settings diagnostic export. The existing typed
delivery diagnostic (`delivery_diagnostic.rs`) already classifies request stages,
HTTP status and transport failures without retaining bodies or rejection text.
The daemon has its own diagnostic APIs and policy; this feature does not call or
extend them. It does not crawl daemon, OS or other app logs.

The executable installs one `tracing_subscriber` registry and a privacy-filtered
Layer, not a parallel logger. It observes only `pilot::diagnostics` events. The
numeric field schema is allowlisted; messages, arbitrary strings, Debug values
and span contents are never formatted or serialized. Unrelated tracing from
Tokio, HTTP libraries and the renderer is not persisted. No fmt/log bridge is
installed, and no per-frame instrumentation is added.

The first slice covers startup presence and completed Local delivery JSON request
boundaries (hello/target/receipt/execute where the existing observer is used).
`response_received: true` means a valid JSON reply, **not** an accepted/durable
delivery or a successful model run. Failed requests retain only the existing
typed category and optional HTTP status. Timings use monotonic elapsed time.
Cancelled requests may have no completion event. UI render, other client reads,
daemon, kernel and provider coverage is absent, not inferred from a healthy app.

`run` is a fresh random app-launch UUID; `request` is an app-local sequence. These
are not chat/session/daemon operation IDs and do not prove end-to-end correlation.
Every record carries its own app version and desktop-source fingerprint, including
records from a previous run/version. The manifest repeats the current build and
coverage. The source hash covers sorted Rust files under `src`, `build.rs`,
`Cargo.toml`, `Cargo.lock` and the product `package.json`. It is not a commit ID or
full signed runtime/payload identity. Fingerprinting is build-time only.

## Local bounds and failures

The existing Next state root contains `diagnostics/` (0700), one stable writer
lock and exactly three `events-N.jsonl` slots (0600, at most 64 KiB each). Only
these filenames are read. Another process holding the lock makes capture
unavailable, never a second rotating writer. Linked, public or nonregular slot
files are refused. Rotations are local diagnostics, not a durable audit journal.

Slots expire when their oldest record exceeds seven days on next capture,
review or startup. Expiring a slot may drop newer records too. No cleanup runs
while the app is closed or idle. Explicit preview keeps the newest 512 rows;
older omitted rows, queue drops, storage failures and unreadable/partial records
are reported in the manifest. Invalid records are not copied into the preview.

The tracing callback uses a bounded 256-entry `try_send`, never filesystem I/O or
a waiting lock. One named background thread owns capture, rotation and snapshot
reads. Export also runs off the UI thread. A full queue drops events and counts
the loss rather than delaying app work. Exit/crash may lose queued events; no
crash/panic Debug dump is collected. No profile/database dump, raw HTTP body,
full URL, path, chat, draft, tool content or token is captured by this schema.

All bundles and edited previews are **untrusted data, not agent instructions**.
They grant no permission to execute commands, retry, change code, install,
restart or mutate live data. Users can introduce arbitrary text while redacting;
inspect the exported file before sharing. Existing unrelated UI error messages
are not part of this capture.

## Verification

Use synthetic data only. Focused unit coverage exercises filtering without even
formatting Debug, concurrent nonblocking overflow, rotation, restart, expiry,
writer contention, unsafe paths, partial input, exact reviewed-byte export and
partial-write errors. The native `dogfooding_diagnostics` probe exercises the
real Settings/Diagnostics view in hidden windows, including keyboard editing,
focus and simulated marked text. These checks do not qualify OS IME, Linux native
input, visible smoothness or production installation.
